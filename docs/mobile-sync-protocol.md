# Local sync: transport v1, full-ledger protocol v2

The desktop's existing renderer API stays on an authenticated loopback listener.
`mobile-sync.mjs` owns a second listener bound to one explicitly selected RFC1918
IPv4 interface. It starts only when the desktop sync panel opens, expires after
10 minutes, and closes on panel close, stop, import/reset, or desktop exit.

## Pairing and transport

The desktop QR contains UTF-8 JSON:

```
{app:"superledger", v:1, protocolVersion:2, addresses:["http://<private-ip>:<ephemeral-port>"],
 sessionId:"<16 random bytes as hex>", key:"<32 random bytes as base64url>",
 expiresAt:<epoch milliseconds>}
```

Only `POST /sync/v1/<sessionId>` is exposed. No file, health, download, or general
ledger API is reachable on that listener. The phone accepts literal private IPv4
addresses only, rejects redirects and hostnames, and performs no external request.
The outer HTTP transport carries authenticated ciphertext, not the ledger.

Request/response envelope: `{iv, data}`; both fields are unpadded base64url. IV is
12 random bytes. `data` concatenates AES-256-GCM ciphertext with a 16-byte tag.
AAD is UTF-8 `superledger-sync-v1:<sessionId>:request` or the corresponding
`:response`. The direction differs to prevent request/response reflection.

An authenticated request contains `requestId`, persistent `deviceId`, display-only
`deviceName`, `bookId`, and up to 500 operations. Android also bounds batches by
UTF-8 size. Version 2 requests include `protocolVersion:2`. First pairing uses
`bookId:null`; version 2 can also merge independently created mobile entities.
Version 1 first pairing still requires an empty queue. Non-null book IDs must
match, so a reset desktop ledger never accepts stale edits. The first successful device binds
that temporary session. Reusing a request ID with changed contents is rejected.

An authenticated response contains `protocolVersion:2`, matching `requestId`, `bookId`, `state`,
`accepted` operation IDs, `conflicts`, `summary`, and `syncedAt`. Errors after
authentication also use the encrypted envelope and include `requestId,error`.
An HTTP success alone is not an acknowledgement; the phone verifies GCM and the
request ID, then persists the resulting ledger and queue atomically.

## Merge and durability

Version 2 entity operations use `{id,entity,kind,recordId,record,base}` with entity
`account`, `subscription`, `goal`, `settings` or `transaction`. Settings has the
fixed record ID `settings` and cannot be deleted. Transactions also retain the
legacy `transaction` / `transactionId` fields below. The first base snapshot and
queue position survive collapsed edits. Every candidate is validated as a whole
ledger before its receipt is committed. Deleting a referenced account conflicts.
Deleting a subscription detaches its history without deleting booked expenses.
Processed subscription periods union independently of editable plan fields;
deterministic `rec_<subscriptionId>_<YYYYMM>` charges deduplicate by occurrence and
native financial fields. Different amounts/accounts require explicit review.

- Put: `{id,kind:"put",base:<original transaction or null>,transaction}`.
- Delete: `{id,kind:"delete",base:<original transaction>,transactionId}`.
- For edits, the desktop compares the original transaction with its current
  version. Independent changes merge; concurrent edits/deletes become explicit
  conflicts. Comparing canonical JSON ignores object-key ordering.
- For automatic captures, exact source notification/reference matches can dedupe;
  weaker amount/time/account or subscription matches require review. A user may
  choose `allowDuplicate:true` with a new operation ID to keep two distinct bills.
- Operation receipts and ledger updates are committed in the same atomic file
  replacement. A lost response is safe to retry. Receipts also survive deletion,
  so an old create request cannot resurrect an already deleted transaction.
- A locally created record deleted before acknowledgement still leaves a delete
  operation: the desktop may already have committed the create.
- Android stores pending operations, local state, capture IDs and unresolved
  conflicts in one AtomicFile. Unacknowledged operations overlay each downloaded
  baseline. Financial captures arriving during sync remain pending for review.
- The desktop's internal `_mobileSync` field carries book identity and receipt
  digests. Ordinary renderer PUTs cannot replace it; it is omitted from mobile
  snapshots. Import/reset ends the pairing identity so an old phone cannot mutate
  the replacement ledger. Receipts are never silently pruned.
- Capacity/disk errors do not acknowledge changes or replace the previous ledger.

## Scope and validation

Version 2 supports accounts, 12 currencies, income/expenses, same/cross-currency
transfers, subscriptions, budget and goals. Version 1 retains CNY transaction-only
scope. Android 1.2 requires desktop 1.7: it checks protocolVersion in both QR and
authenticated response before applying data. The transport URL/AAD stay v1 for
old phones; desktop 1.7 still accepts their limited operations.

`tests/mobile-sync.test.mjs` and `tests/mobile-full-ledger.test.mjs` cover durable retry/delete semantics, concurrent
edits, duplicate review, wrong-book rejection, invalid transactions, crypto
tampering, loopback/public-address rejection, expiry/cancellation, and the real
local HTTP encrypted round trip including desktop restart/import. Android tools
also exercise the actual Java SyncClient against Node and the desktop QR encoder
against ZXing. These tests do not establish vivo notification reliability.

Implementation references: [Node crypto](https://nodejs.org/api/crypto.html),
[Android notification listener](https://developer.android.com/reference/android/service/notification/NotificationListenerService),
[Android AtomicFile](https://developer.android.com/reference/android/util/AtomicFile).
