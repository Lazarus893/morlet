package com.agent.helper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.text.TextUtils;
import android.util.Log;

/**
 * Task status pushed from the Mac:
 * am broadcast -a com.agent.helper.TASK_STATUS -p com.agent.helper
 *     --es state running|paused|finished|error --ei step 3 --es text "..."
 */
public class TaskStatusReceiver extends BroadcastReceiver {

    private static final String TAG = "TaskStatusReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String state = intent.getStringExtra("state");
        if (TextUtils.isEmpty(state)) {
            Log.w(TAG, "TASK_STATUS without 'state' extra");
            return;
        }
        int step = intent.getIntExtra("step", 0);
        String text = intent.getStringExtra("text");
        Log.d(TAG, "state=" + state + " step=" + step + " text=" + text);

        TaskStatus.save(context, state, step, text);
        AppSettings.ensureFile(context);
        AppSettings settings = AppSettings.load(context);

        switch (state) {
            case TaskStatus.RUNNING:
                if (settings.bubble) {
                    OverlayService.send(context, OverlayService.ACTION_BUBBLE_ON);
                }
                if (settings.overlay) {
                    OverlayService.send(context, OverlayService.ACTION_OVERLAY_ON);
                }
                break;
            case TaskStatus.PAUSED:
                // A pause hands the phone back to the user, so never keep blocking touches.
                if (OverlayService.isOverlayShowing) {
                    OverlayService.send(context, OverlayService.ACTION_OVERLAY_OFF);
                }
                break;
            case TaskStatus.FINISHED:
            case TaskStatus.ERROR:
                if (OverlayService.isRunning) {
                    OverlayService.send(context, OverlayService.ACTION_TASK_ENDED);
                }
                break;
            default:
                Log.w(TAG, "Unknown state: " + state);
                break;
        }
    }
}
