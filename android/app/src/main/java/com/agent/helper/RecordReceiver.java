package com.agent.helper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Recording control from the Mac:
 * am broadcast -a com.agent.helper.RECORD -p com.agent.helper --es action start --es task_id ID
 * am broadcast -a com.agent.helper.RECORD -p com.agent.helper --es action stop
 */
public class RecordReceiver extends BroadcastReceiver {

    private static final String TAG = "RecordReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getStringExtra("action");
        String taskId = intent.getStringExtra("task_id");
        Log.d(TAG, "action=" + action + " task_id=" + taskId);
        RecordState state = RecordState.get(context);

        String serviceAction;
        if ("start".equals(action)) {
            serviceAction = RecordService.ACTION_START;
        } else if ("stop".equals(action)) {
            serviceAction = RecordService.ACTION_STOP;
        } else {
            state.error = "unknown action: " + action;
            state.save(context);
            return;
        }

        // Only the running service can hold a MediaProjection; without it there is nothing to
        // record with, and the service must not be started without fresh user consent.
        if (!RecordService.isAuthorized) {
            state.recording = false;
            if (state.error.isEmpty()) {
                state.error = "not authorized";
            }
            state.save(context);
            return;
        }

        Intent service = new Intent(context, RecordService.class)
                .setAction(serviceAction)
                .putExtra(RecordService.EXTRA_TASK_ID, taskId);
        try {
            context.startService(service);
        } catch (RuntimeException e) {
            Log.e(TAG, "Failed to reach RecordService", e);
            state.error = "service unreachable: " + e.getMessage();
            state.save(context);
        }
    }
}
