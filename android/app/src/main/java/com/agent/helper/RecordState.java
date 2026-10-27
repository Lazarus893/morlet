package com.agent.helper;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Screen-recording state, mirrored to record-status.json so the Mac side can tell whether it
 * can record and when a stopped recording has been fully written.
 */
final class RecordState {

    static final String FILE_NAME = "record-status.json";
    private static final String TAG = "RecordState";

    boolean authorized;
    boolean recording;
    String taskId = "";
    final List<String> segments = new ArrayList<>();
    String currentSegment = "";
    String error = "";

    private static RecordState instance;
    private static Runnable listener;

    private RecordState() {}

    static RecordState get(Context context) {
        if (instance == null) {
            instance = restore(context.getApplicationContext());
            // Publish the fully restored state before save notifies the settings page.
            // Its refresh callback reads get() again.
            instance.save(context.getApplicationContext());
        }
        return instance;
    }

    /** Called on the main thread after every save (the settings page uses it to refresh). */
    static void setListener(Runnable r) {
        listener = r;
    }

    /**
     * A fresh process never holds a MediaProjection, whatever the file says. A segment that was
     * still being written when the process died has no moov box and cannot be played: drop it.
     */
    private static RecordState restore(Context context) {
        RecordState s = new RecordState();
        JSONObject json = AgentFiles.readJson(context, FILE_NAME);
        if (json != null) {
            s.taskId = json.optString("taskId", "");
            JSONArray list = json.optJSONArray("segments");
            if (list != null) {
                for (int i = 0; i < list.length(); i++) {
                    s.segments.add(list.optString(i));
                }
            }
            String partial = json.optString("currentSegment", "");
            if (!partial.isEmpty()) {
                File f = AgentFiles.file(context, partial);
                Log.w(TAG, "Dropping unfinished segment " + f + ": " + f.delete());
            }
            if (json.optBoolean("recording", false)) {
                s.error = "recording interrupted: app process restarted";
            } else if (json.optBoolean("authorized", false)) {
                s.error = "app process restarted, authorize again";
            } else {
                s.error = json.optString("error", "");
            }
        }
        return s;
    }

    void save(Context context) {
        try {
            JSONObject json = new JSONObject();
            json.put("authorized", authorized);
            json.put("recording", recording);
            json.put("taskId", taskId);
            json.put("segments", new JSONArray(segments));
            json.put("currentSegment", currentSegment);
            json.put("error", error);
            json.put("updatedAt", System.currentTimeMillis());
            AgentFiles.writeJson(context, FILE_NAME, json);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        if (listener != null) {
            listener.run();
        }
    }
}
