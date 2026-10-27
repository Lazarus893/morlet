"""Run the production RecordState on a host JVM with Android/file boundaries stubbed.

No emulator, phone, permissions or recording are used. JAVA_HOME may select a JDK.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'android/app/src/main/java/com/agent/helper/RecordState.java'
STUBS = {
    'android/content/Context.java': '''package android.content;
public class Context { public Context getApplicationContext() { return this; } }
''',
    'android/util/Log.java': '''package android.util;
public class Log { public static int w(String tag, String value) { return 0; } }
''',
    'org/json/JSONException.java': '''package org.json;
public class JSONException extends Exception { }
''',
    'org/json/JSONObject.java': '''package org.json;
import java.util.HashMap;
public class JSONObject {
  private final HashMap<String, Object> values = new HashMap<>();
  public JSONObject put(String key, Object value) throws JSONException { values.put(key, value); return this; }
  public String optString(String key, String fallback) { Object v = values.get(key); return v instanceof String ? (String) v : fallback; }
  public boolean optBoolean(String key, boolean fallback) { Object v = values.get(key); return v instanceof Boolean ? (Boolean) v : fallback; }
  public JSONArray optJSONArray(String key) { Object v = values.get(key); return v instanceof JSONArray ? (JSONArray) v : null; }
}
''',
    'org/json/JSONArray.java': '''package org.json;
import java.util.ArrayList;
import java.util.Collection;
public class JSONArray {
  private final ArrayList<?> values;
  public JSONArray(Collection<?> values) { this.values = new ArrayList<>(values); }
  public int length() { return values.size(); }
  public String optString(int index) { Object v = values.get(index); return v instanceof String ? (String) v : ""; }
}
''',
    'com/agent/helper/AgentFiles.java': '''package com.agent.helper;
import android.content.Context;
import java.io.File;
import org.json.JSONObject;
final class AgentFiles {
  static JSONObject saved, written;
  static int reads, writes;
  static JSONObject readJson(Context c, String name) { reads++; return saved; }
  static boolean writeJson(Context c, String name, JSONObject json) { writes++; written = json; return true; }
  static File file(Context c, String name) { throw new AssertionError("No fixture should delete a file"); }
}
''',
    'com/agent/helper/RecordStateRegression.java': '''package com.agent.helper;
import android.content.Context;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
public final class RecordStateRegression {
  static int notifications;
  static RecordState notifiedState;
  static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
  public static void main(String[] args) throws Exception {
    Context context = new Context();
    boolean interrupted = args[0].equals("interrupted");
    if (!args[0].equals("fresh")) {
      AgentFiles.saved = new JSONObject().put("authorized", true).put("recording", interrupted)
          .put("taskId", "task-fixture").put("segments", new JSONArray(Arrays.asList("segment-fixture")));
    }
    // SettingsActivity registers this callback before its first render/get.
    RecordState.setListener(() -> {
      check(++notifications <= 2, "Initialization recursively notified the settings page");
      notifiedState = RecordState.get(context);
      check(!notifiedState.authorized && !notifiedState.recording, "Restored permissions must be revoked");
      check(AgentFiles.reads == 1, "Listener re-entered state restoration");
    });
    RecordState state = RecordState.get(context);
    check(state == notifiedState, "Listener must see the published singleton");
    check(notifications == 1 && AgentFiles.writes == 1, "Restore must save/notify once");
    check(RecordState.get(context) == state && AgentFiles.reads == 1, "Repeated reads must reuse state");
    check(!AgentFiles.written.optBoolean("authorized", true), "File must revoke stale authorization");
    if (!args[0].equals("fresh")) {
      check(state.taskId.equals("task-fixture") && state.segments.size() == 1, "Keep completed task history");
      check(state.error.equals(interrupted ? "recording interrupted: app process restarted" : "app process restarted, authorize again"), "Retain recovery reason");
    }
    state.save(context);
    check(notifications == 2 && AgentFiles.writes == 2, "Ordinary saves must still notify");
    RecordState.setListener(null);
    state.save(context);
    check(notifications == 2, "Paused settings page must not be notified");
  }
}
''',
}


class AndroidRecordStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        selected = Path(os.environ['JAVA_HOME']) / 'bin' if os.environ.get('JAVA_HOME') else None
        javac = str(selected / 'javac') if selected else shutil.which('javac')
        cls.java = str(selected / 'java') if selected else shutil.which('java')
        if not javac or not cls.java:
            raise unittest.SkipTest('Host JDK required for the Android state regression')
        available = subprocess.run([javac, '-version'], capture_output=True, text=True, timeout=10)
        if available.returncode:
            raise unittest.SkipTest('Set JAVA_HOME to an installed host JDK')
        cls.temporary = tempfile.TemporaryDirectory(prefix='pa-record-state-fixture-')
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.classes = cls.directory / 'classes'
        cls.classes.mkdir()
        sources = []
        for name, contents in STUBS.items():
            path = cls.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
            sources.append(str(path))
        compiled = subprocess.run([javac, '-d', str(cls.classes), *sources, str(SOURCE)], capture_output=True, text=True, timeout=30)
        if compiled.returncode:
            raise AssertionError(compiled.stderr)

    def run_case(self, name):
        result = subprocess.run([self.java, '-cp', str(self.classes), 'com.agent.helper.RecordStateRegression', name], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_settings_listener_registered_before_first_state_read(self):
        self.run_case('fresh')

    def test_old_authorization_is_revoked_without_losing_completed_history(self):
        self.run_case('authorized')

    def test_interrupted_recording_recovers_without_recursive_ui_refresh(self):
        self.run_case('interrupted')


if __name__ == '__main__':
    unittest.main()
