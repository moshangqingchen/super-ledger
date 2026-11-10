# Local sync: transport v1, full-ledger protocol v2

The desktop's existing renderer API stays on an authenticated loopback listener.
`mobile-sync.mjs` owns a second listener bound to one explicitly selected RFC1918
IPv4 interface. It starts only when the desktop sync panel opens, expires after
10 minutes, and closes on panel close, stop, import/reset, or desktop exit.

## Pairing and transport

The desktop QR contains UTF-8 JSON:

```
{app:"superledger", v:1, protocolVersion:2, supportedSchemaVersion:4,
 addresses:["http://<private-ip>:<ephemeral-port>"],
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
UTF-8 size. Version 2 requests include `protocolVersion:2` and
`supportedSchemaVersion:4`. First pairing uses
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

Settings is one complete record, including `categoryBudgets`, `customCategories`
and any opaque extension fields. Both clients retain the full baseline for conflict
detection and copy the record before changing individual known settings. The
desktop preserves omitted unknown extension keys when accepting a settings edit;
omitted known optional fields explicitly remove those settings. An old baseline
cannot overwrite newly added preferences: it produces a normal settings conflict.

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

### Ledger schema versions

Transport and protocol versions are independent from `state.schemaVersion`.
Both current clients accept ledger schemas 1, 2, 3 and 4. Version 3 adds Beijing
hour-aware subscription booking. Version 4 is required only when at least one
of these optional fields is present:

- Subscription `intervalMonths`: recurring only, integer 1, 3, 6 or 12; writers
  omit 1, whose meaning is also the default when the field is absent.
- Settings `categoryBudgets`: at most 50 category keys (1–50 characters), each
  mapped to a positive integer CNY-cent budget. Empty objects are omitted.
- Settings `customCategories`: `expense` and `income` arrays, each with at most
  30 distinct 1–50 character names, excluding built-in names. Omit the field when
  both arrays are empty. Historical transaction category strings stay unchanged.
- Goal `deadline`: a valid `YYYY-MM-DD`; empty values are omitted.

Writers only promote a schema when a feature needs it and never downgrade an
existing schema. Readers reject feature fields advertised under an older schema.
For a desktop ledger at schema 3 or above, the phone must declare integer
`supportedSchemaVersion >= state.schemaVersion` before any operation is applied;
otherwise the encrypted error explicitly asks the user to update the phone.
Schemas 1–2 retain the old-phone behavior. Before upload, Android similarly checks
the QR's supported schema against its own ledger and asks for a desktop update
when needed. Thus an old client cannot remove fields it cannot interpret.

### Recurring periods and renewal receipts

For installment `k >= 0`, due date is
`addMonthsDue(startDate, k * (intervalMonths ?? 1), billingDay)`, with month-end
clamping. Dates and hours use Beijing time. Occurrence keys remain
`<subscriptionId>:<YYYY-MM>` and transaction IDs remain
`rec_<subscriptionId>_<YYYYMM>`, based on the actual due month. The next-payment
forecast reserves the full installment. Monthly summaries first convert each
installment to integer CNY cents, then divide by its interval and round half up;
annual estimates instead multiply each installment's CNY cents by `12 / interval`.

Editing the interval preserves every historical processed key. At save time,
the client adds new-grid occurrences strictly before Beijing today as skipped,
preventing a switch from annual to monthly from backfilling old months. Today's
period remains eligible at its scheduled hour. Off-grid historical keys are kept
but do not schedule payments. An uploaded automatic charge outside the current
grid requires a historical processed receipt already held by the desktop or in an
accepted incoming subscription, and cannot be future-dated. This retains payments
booked offline before a cycle edit, including a phone's first sync. Without that
history the stale charge conflicts for review. Existing matching historical
charges still deduplicate normally. Historical off-grid receipts remain even if
their transaction import awaits funding, so retrying just that transaction after
the plan acknowledgement is safe. For current-grid charges, rejection does not
commit a newly received processed marker or renewal extension.

Each successfully paid occurrence extends membership expiry by `intervalMonths`
months, anchored to `expiryRenewal.baseDate`; renewal receipts union across peers
so the same period cannot extend twice. An interval edit reanchors expiry at the
current earned expiry and moves old paid/renewed occurrences into its baseline.
If an incoming cycle edit was based on an older expiry and the desktop has since
renewed that membership, the subscription operation conflicts without replacing
the desktop record. The conflict sets `canKeepPhone:false` and asks the user to
adopt the current desktop record before editing the cycle again, so a new cycle
cannot silently consume already-earned membership time.
Rejected charges do not gain processed/renewed receipts. A later funded retry
adds exactly one charge and one extension.

`tests/mobile-sync.test.mjs` and `tests/mobile-full-ledger.test.mjs` cover durable retry/delete semantics, concurrent
edits, duplicate review, wrong-book rejection, invalid transactions, crypto
tampering, loopback/public-address rejection, expiry/cancellation, and the real
local HTTP encrypted round trip including desktop restart/import. Android tools
also exercise the actual Java SyncClient against Node and the desktop QR encoder
against ZXing. These tests do not establish vivo notification reliability.

Implementation references: [Node crypto](https://nodejs.org/api/crypto.html),
[Android notification listener](https://developer.android.com/reference/android/service/notification/NotificationListenerService),
[Android AtomicFile](https://developer.android.com/reference/android/util/AtomicFile).
