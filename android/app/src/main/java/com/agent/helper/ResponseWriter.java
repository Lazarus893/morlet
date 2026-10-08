package com.agent.helper;

import android.content.Context;
import android.os.Environment;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public class ResponseWriter {

    private static final String TAG = "ResponseWriter";
    private static final String RESPONSE_FILENAME = "response.json";

    /**
     * Get the response file path.
     * Tries getExternalFilesDir first, falls back to /sdcard/agent_helper/
     */
    public static File getResponseFile(Context context) {
        File dir = context.getExternalFilesDir(null);
        if (dir == null) {
            dir = new File(Environment.getExternalStorageDirectory(), "agent_helper");
        }
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return new File(dir, RESPONSE_FILENAME);
    }

    /**
     * Write a JSON response to the response file.
     */
    public static void writeResponse(Context context, String type, String result) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", type);
            json.put("result", result);
            json.put("timestamp", System.currentTimeMillis() / 1000);

            File file = getResponseFile(context);
            FileOutputStream fos = new FileOutputStream(file);
            fos.write(json.toString().getBytes(StandardCharsets.UTF_8));
            fos.flush();
            fos.close();

            Log.d(TAG, "Wrote response: " + json.toString() + " to " + file.getAbsolutePath());
        } catch (JSONException | IOException e) {
            Log.e(TAG, "Failed to write response", e);
        }
    }

    /**
     * Write a raw JSON object to the response file.
     */
    public static void writeResponseJson(Context context, JSONObject json) {
        try {
            File file = getResponseFile(context);
            FileOutputStream fos = new FileOutputStream(file);
            fos.write(json.toString().getBytes(StandardCharsets.UTF_8));
            fos.flush();
            fos.close();

            Log.d(TAG, "Wrote response: " + json.toString() + " to " + file.getAbsolutePath());
        } catch (IOException e) {
            Log.e(TAG, "Failed to write response", e);
        }
    }

    /**
     * Delete the response file.
     */
    public static boolean deleteResponse(Context context) {
        File file = getResponseFile(context);
        if (file.exists()) {
            boolean deleted = file.delete();
            Log.d(TAG, "Deleted response file: " + deleted);
            return deleted;
        }
        return true;
    }
}
