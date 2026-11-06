package com.moneylab.superledger.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Explicit mutable PendingIntent target; no exported broadcast entry point. */
public final class UpdateInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) { AppUpdater.get(context).handleInstallResult(intent); }
}
