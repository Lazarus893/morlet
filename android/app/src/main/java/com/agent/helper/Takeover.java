package com.agent.helper;

import android.content.Context;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The "我来接管" channel: writes control.json for the Mac side to pick up. The Mac side
 * acknowledges by deleting the file or writing {"takeover":false}.
 */
final class Takeover {

    static final String FILE_NAME = "control.json";

    private Takeover() {}

    static boolean request(Context context) {
        boolean ok;
        try {
            JSONObject json = new JSONObject();
            json.put("takeover", true);
            json.put("requestedAt", System.currentTimeMillis());
            ok = AgentFiles.writeJson(context, FILE_NAME, json);
        } catch (JSONException e) {
            ok = false;
        }
        Toast.makeText(context.getApplicationContext(),
                ok ? R.string.takeover_sent : R.string.takeover_failed,
                Toast.LENGTH_SHORT).show();
        return ok;
    }

    /** True while a takeover request is waiting for the Mac side. */
    static boolean isPending(Context context) {
        JSONObject json = AgentFiles.readJson(context, FILE_NAME);
        return json != null && json.optBoolean("takeover", false);
    }
}
