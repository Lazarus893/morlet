package com.agent.helper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Receives overlay control broadcasts and forwards them to OverlayService.
 * This ensures the service is started if it isn't already running.
 */
public class OverlayReceiver extends BroadcastReceiver {

    private static final String TAG = "OverlayReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        Log.d(TAG, "Received broadcast: " + action);
        if (action == null) return;

        Intent serviceIntent = new Intent(context, OverlayService.class);
        serviceIntent.setAction(action);

        // Copy any extras
        if (intent.getExtras() != null) {
            serviceIntent.putExtras(intent.getExtras());
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            Log.d(TAG, "OverlayService start requested");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start OverlayService: " + e.getMessage(), e);
        }
    }
}
