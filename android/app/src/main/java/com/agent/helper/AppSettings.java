package com.agent.helper;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Phone-automation settings. settings.json is what the Mac side reads (and may edit),
 * so it wins over the SharedPreferences copy that backs the UI.
 */
final class AppSettings {

    static final String FILE_NAME = "settings.json";
    private static final String PREFS = "settings";

    static final int CHECKPOINT_MIN = 0;
    static final int CHECKPOINT_MAX = 50;
    static final int SCREENSHOT_MIN = 1;
    static final int SCREENSHOT_MAX = 20;
    static final int MAX_STEPS_MIN = 5;
    static final int MAX_STEPS_MAX = 80;

    boolean record = true;
    int checkpointEvery = 8;
    int screenshotEvery = 3;
    int maxSteps = 30;
    boolean bubble = true;
    boolean overlay = false;

    static AppSettings load(Context context) {
        AppSettings s = new AppSettings();
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        s.record = p.getBoolean("record", s.record);
        s.checkpointEvery = p.getInt("checkpointEvery", s.checkpointEvery);
        s.screenshotEvery = p.getInt("screenshotEvery", s.screenshotEvery);
        s.maxSteps = p.getInt("maxSteps", s.maxSteps);
        s.bubble = p.getBoolean("bubble", s.bubble);
        s.overlay = p.getBoolean("overlay", s.overlay);

        JSONObject json = AgentFiles.readJson(context, FILE_NAME);
        if (json != null) {
            s.record = json.optBoolean("record", s.record);
            s.checkpointEvery = json.optInt("checkpointEvery", s.checkpointEvery);
            s.screenshotEvery = json.optInt("screenshotEvery", s.screenshotEvery);
            s.maxSteps = json.optInt("maxSteps", s.maxSteps);
            s.bubble = json.optBoolean("bubble", s.bubble);
            s.overlay = json.optBoolean("overlay", s.overlay);
        }
        s.clamp();
        return s;
    }

    /** First launch: write the defaults so the Mac side always finds a settings file. */
    static void ensureFile(Context context) {
        if (!AgentFiles.file(context, FILE_NAME).exists()) {
            load(context).save(context);
        }
    }

    void save(Context context) {
        clamp();
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("record", record)
                .putInt("checkpointEvery", checkpointEvery)
                .putInt("screenshotEvery", screenshotEvery)
                .putInt("maxSteps", maxSteps)
                .putBoolean("bubble", bubble)
                .putBoolean("overlay", overlay)
                .apply();
        try {
            JSONObject json = new JSONObject();
            json.put("record", record);
            json.put("checkpointEvery", checkpointEvery);
            json.put("screenshotEvery", screenshotEvery);
            json.put("maxSteps", maxSteps);
            json.put("bubble", bubble);
            json.put("overlay", overlay);
            json.put("updatedAt", System.currentTimeMillis());
            AgentFiles.writeJson(context, FILE_NAME, json);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private void clamp() {
        checkpointEvery = clamp(checkpointEvery, CHECKPOINT_MIN, CHECKPOINT_MAX);
        screenshotEvery = clamp(screenshotEvery, SCREENSHOT_MIN, SCREENSHOT_MAX);
        maxSteps = clamp(maxSteps, MAX_STEPS_MIN, MAX_STEPS_MAX);
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
