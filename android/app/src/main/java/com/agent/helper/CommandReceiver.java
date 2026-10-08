package com.agent.helper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.text.TextUtils;
import android.util.Log;

public class CommandReceiver extends BroadcastReceiver {

    private static final String TAG = "CommandReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String cmd = intent.getStringExtra("cmd");
        if (TextUtils.isEmpty(cmd)) {
            Log.w(TAG, "Received command broadcast with no 'cmd' extra");
            return;
        }

        Log.d(TAG, "Received command: " + cmd);

        switch (cmd) {
            case "clear_response":
                ResponseWriter.deleteResponse(context);
                break;

            case "ping":
                ResponseWriter.writeResponse(context, "ping", "pong");
                break;

            case "status":
                String overlayState = OverlayService.isOverlayShowing ? "visible" : "hidden";
                ResponseWriter.writeResponse(context, "status", overlayState);
                break;

            default:
                Log.w(TAG, "Unknown command: " + cmd);
                break;
        }
    }
}
