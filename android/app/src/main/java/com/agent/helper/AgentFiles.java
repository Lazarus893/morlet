package com.agent.helper;

import android.content.Context;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * JSON files shared with the Mac side through the app's external files dir
 * (/sdcard/Android/data/com.agent.helper/files/), which adb can read and write.
 */
final class AgentFiles {

    private static final String TAG = "AgentFiles";

    private AgentFiles() {}

    static File file(Context context, String name) {
        File dir = context.getExternalFilesDir(null);
        if (dir != null && !dir.exists()) {
            dir.mkdirs();
        }
        return new File(dir, name);
    }

    /** Returns the parsed file, or null if it is missing or not valid JSON. */
    static JSONObject readJson(Context context, String name) {
        File f = file(context, name);
        if (!f.isFile()) return null;
        try {
            return new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            Log.w(TAG, "Unreadable " + f + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Writes via a temp file + rename so an `adb shell cat` on the Mac never sees a
     * half-written file.
     */
    static boolean writeJson(Context context, String name, JSONObject json) {
        File target = file(context, name);
        File tmp = new File(target.getParentFile(), name + ".tmp");
        byte[] bytes = json.toString().getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
        } catch (IOException e) {
            Log.e(TAG, "Failed to write " + tmp, e);
            return false;
        }
        if (!tmp.renameTo(target)) {
            Log.e(TAG, "Failed to rename " + tmp + " -> " + target);
            tmp.delete();
            return false;
        }
        Log.d(TAG, "Wrote " + target + ": " + json);
        return true;
    }
}
