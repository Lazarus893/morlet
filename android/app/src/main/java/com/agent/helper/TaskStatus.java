package com.agent.helper;

import android.content.Context;
import android.content.SharedPreferences;

/** Last task status pushed by the Mac side, kept so the settings page can show it. */
final class TaskStatus {

    static final String PREFS = "task_status";

    static final String RUNNING = "running";
    static final String PAUSED = "paused";
    static final String FINISHED = "finished";
    static final String ERROR = "error";

    final String state;
    final int step;
    final String text;
    final long updatedAt;

    private TaskStatus(String state, int step, String text, long updatedAt) {
        this.state = state;
        this.step = step;
        this.text = text;
        this.updatedAt = updatedAt;
    }

    static void save(Context context, String state, int step, String text) {
        prefs(context).edit()
                .putString("state", state)
                .putInt("step", step)
                .putString("text", text)
                .putLong("updatedAt", System.currentTimeMillis())
                .apply();
    }

    /** Returns null if no status has been received yet. */
    static TaskStatus load(Context context) {
        SharedPreferences p = prefs(context);
        String state = p.getString("state", null);
        if (state == null) return null;
        return new TaskStatus(state, p.getInt("step", 0), p.getString("text", null),
                p.getLong("updatedAt", 0L));
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
