package com.moneylab.superledger.mobile;

import android.app.Notification;
import android.content.Intent;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Receives only user-enabled sources; private chats and OTPs are never stored. */
public final class PaymentNotificationService extends NotificationListenerService {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    @Override public void onNotificationPosted(StatusBarNotification notification) {
        if (notification == null) return;
        Notification item = notification.getNotification();
        if (item == null || (item.flags & Notification.FLAG_GROUP_SUMMARY) != 0 || (item.flags & Notification.FLAG_ONGOING_EVENT) != 0) return;
        try {
            LedgerStore store = LedgerStore.get(this); String pkg = notification.getPackageName(); if (!store.sourceEnabled(pkg)) return;
            Bundle extras = item.extras; if (extras == null) return;
            CharSequence titleValue = extras.getCharSequence(Notification.EXTRA_TITLE), big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT), normal = extras.getCharSequence(Notification.EXTRA_TEXT);
            String title = titleValue == null ? "" : titleValue.toString();
            String body = big != null && big.length() > 0 ? big.toString() : normal == null ? "" : normal.toString();
            if (body.length() > 2400) body = body.substring(0, 2400);
            final PaymentParser.Parsed parsed = PaymentParser.parse(pkg, title, body); if (parsed == null) return;
            final String key = notification.getKey(); final long postedAt = notification.getPostTime();
            worker.execute(() -> {
                try { store.capture(pkg, key, postedAt, parsed); sendBroadcast(new Intent(MainActivity.ACTION_CHANGED).setPackage(getPackageName())); }
                catch (Exception e) { store.captureFailed(); sendBroadcast(new Intent(MainActivity.ACTION_CHANGED).setPackage(getPackageName())); }
            });
        } catch (Exception e) { /* A corrupt store is not overwritten or reset. */ }
    }
    @Override public void onDestroy() { worker.shutdown(); super.onDestroy(); }
}
