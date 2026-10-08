package com.agent.helper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.Locale;

/**
 * Holds the user's screen-capture consent for as long as possible and records task videos
 * on request.
 *
 * Android 14+ (targetSdk 34) allows one getMediaProjection() per consent and one
 * createVirtualDisplay() per MediaProjection. So the projection and a single VirtualDisplay
 * live as long as this service; each segment only swaps in a new MediaRecorder surface.
 */
public class RecordService extends Service {

    private static final String TAG = "RecordService";

    static final String ACTION_AUTHORIZE = "com.agent.helper.RECORD_AUTHORIZE";
    static final String ACTION_START = "com.agent.helper.RECORD_START";
    static final String ACTION_STOP = "com.agent.helper.RECORD_STOP";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_RESULT_DATA = "resultData";
    static final String EXTRA_TASK_ID = "taskId";

    private static final String CHANNEL_ID = "agent_record_channel";
    private static final int NOTIFICATION_ID = 2;
    private static final long SEGMENT_MS = 180_000L;
    private static final int BIT_RATE = 3_000_000;
    private static final int FRAME_RATE = 30;

    static final String STOPPED_BY_SYSTEM = "projection stopped by system (可能是投屏抢占)";

    /** True while this process holds a usable MediaProjection. */
    static boolean isAuthorized = false;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable rotateSegment = this::rotateSegment;
    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override
        public void onStop() {
            // Android keeps one active projection: starting a screen cast stops ours.
            onProjectionStopped(STOPPED_BY_SYSTEM);
        }
    };

    private RecordState state;
    private MediaProjection projection;
    private VirtualDisplay display;
    private MediaRecorder recorder;
    private File taskDir;
    private File segmentFile;
    private int segmentIndex;
    private int width;
    private int height;
    private int dpi;

    @Override
    public void onCreate() {
        super.onCreate();
        state = RecordState.get(this);
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, getString(R.string.record_channel_name), NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_AUTHORIZE.equals(action)) {
            // Android 14+: the mediaProjection foreground service must be running before
            // getMediaProjection() is called.
            startForegroundCompat(buildNotification(getString(R.string.record_notification_ready)));
            authorize(intent.getIntExtra(EXTRA_RESULT_CODE, 0),
                    intent.getParcelableExtra(EXTRA_RESULT_DATA));
        } else if (ACTION_START.equals(action)) {
            startRecording(intent.getStringExtra(EXTRA_TASK_ID));
        } else if (ACTION_STOP.equals(action)) {
            stopRecording();
        }
        if (projection == null) {
            // No consent to hold: nothing for this service to do.
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
        // A restarted service would have no projection, so never ask for a restart.
        return START_NOT_STICKY;
    }

    // --- Projection lifetime ---

    private void authorize(int resultCode, Intent data) {
        releaseProjection(); // re-authorizing replaces the old projection
        MediaProjection p = null;
        try {
            if (data != null) {
                p = getSystemService(MediaProjectionManager.class).getMediaProjection(resultCode, data);
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "getMediaProjection failed", e);
        }
        if (p == null) {
            markUnauthorized("authorization failed");
            return;
        }
        // Android 14+: the callback must be registered before createVirtualDisplay().
        p.registerCallback(projectionCallback, handler);
        pickVideoSize();
        try {
            display = p.createVirtualDisplay("xiaoman-record", width, height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, handler);
        } catch (RuntimeException e) {
            Log.e(TAG, "createVirtualDisplay failed", e);
            p.unregisterCallback(projectionCallback);
            p.stop();
            markUnauthorized("virtual display failed: " + e.getMessage());
            return;
        }
        projection = p;
        isAuthorized = true;
        state.authorized = true;
        state.recording = false;
        state.currentSegment = "";
        state.error = "";
        state.save(this);
        Log.d(TAG, "Authorized, capture size " + width + "x" + height + " @" + dpi + "dpi");
    }

    /** Our own teardown: unregister first so stop() does not look like a system revocation. */
    private void releaseProjection() {
        if (recorder != null) {
            stopRecording();
        }
        if (display != null) {
            display.release();
            display = null;
        }
        if (projection != null) {
            projection.unregisterCallback(projectionCallback);
            projection.stop();
            projection = null;
        }
        isAuthorized = false;
    }

    /** The system or the user revoked the projection (status-bar stop, another capture app...). */
    private void onProjectionStopped(String reason) {
        Log.w(TAG, reason);
        finishSegment();
        if (display != null) {
            display.release();
            display = null;
        }
        if (projection != null) {
            projection.unregisterCallback(projectionCallback);
            projection = null;
        }
        markUnauthorized(reason);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void markUnauthorized(String reason) {
        isAuthorized = false;
        state.authorized = false;
        state.recording = false;
        state.currentSegment = "";
        state.error = reason;
        state.save(this);
    }

    // --- Recording ---

    private void startRecording(String rawTaskId) {
        if (projection == null || display == null) {
            markUnauthorized(state.error.isEmpty() ? "not authorized" : state.error);
            return;
        }
        String id = safeTaskId(rawTaskId);
        if (id.isEmpty()) {
            state.error = "missing task_id";
            state.save(this);
            return;
        }
        if (recorder != null) {
            if (id.equals(state.taskId)) {
                Log.d(TAG, "Already recording " + id);
                return;
            }
            stopRecording();
        }

        taskDir = new File(getExternalFilesDir(null), "rec/" + id);
        taskDir.mkdirs();
        state.taskId = id;
        state.segments.clear();
        // start -> stop -> start on the same task continues the numbering instead of overwriting.
        segmentIndex = 0;
        String[] existing = taskDir.list();
        if (existing != null) {
            Arrays.sort(existing);
            for (String name : existing) {
                if (name.matches("seg_\\d+\\.mp4")) {
                    state.segments.add(relativePath(name));
                    segmentIndex = Math.max(segmentIndex,
                            Integer.parseInt(name.substring(4, name.length() - 4)) + 1);
                }
            }
        }
        state.error = "";
        startSegment();
    }

    private void startSegment() {
        segmentFile = new File(taskDir, String.format(Locale.US, "seg_%02d.mp4", segmentIndex));
        MediaRecorder r = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? new MediaRecorder(this) : new MediaRecorder();
        try {
            r.setVideoSource(MediaRecorder.VideoSource.SURFACE);
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            r.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
            r.setVideoSize(width, height);
            r.setVideoFrameRate(FRAME_RATE);
            r.setVideoEncodingBitRate(BIT_RATE);
            r.setOutputFile(segmentFile.getAbsolutePath());
            r.prepare();
            display.setSurface(r.getSurface());
            r.start();
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "Failed to start segment " + segmentFile, e);
            display.setSurface(null);
            r.release();
            segmentFile.delete();
            state.recording = false;
            state.currentSegment = "";
            state.error = "recorder failed: " + e.getMessage();
            state.save(this);
            updateNotification(getString(R.string.record_notification_ready));
            return;
        }
        recorder = r;
        state.recording = true;
        state.currentSegment = relativePath(segmentFile.getName());
        state.save(this);
        updateNotification(getString(R.string.record_notification_recording, state.taskId));
        handler.postDelayed(rotateSegment, SEGMENT_MS);
        Log.d(TAG, "Recording " + segmentFile);
    }

    /** Closes the current segment. A segment with no frames makes stop() throw: drop the file. */
    private void finishSegment() {
        handler.removeCallbacks(rotateSegment);
        if (recorder == null) return;
        if (display != null) {
            try {
                display.setSurface(null);
            } catch (RuntimeException e) {
                Log.w(TAG, "Display already gone", e); // projection revoked by the system
            }
        }
        boolean ok = true;
        try {
            recorder.stop();
        } catch (RuntimeException e) {
            ok = false;
            Log.w(TAG, "Segment too short, dropping " + segmentFile, e);
        }
        recorder.release();
        recorder = null;
        if (ok && segmentFile.length() > 0) {
            state.segments.add(relativePath(segmentFile.getName()));
        } else {
            segmentFile.delete();
        }
        state.currentSegment = "";
    }

    /** Every SEGMENT_MS: close the segment and open the next, so a killed process loses at most one. */
    private void rotateSegment() {
        finishSegment();
        segmentIndex++;
        startSegment();
    }

    private void stopRecording() {
        finishSegment();
        state.recording = false;
        state.currentSegment = "";
        state.save(this);
        if (projection != null) {
            updateNotification(getString(R.string.record_notification_ready));
        }
    }

    // --- Helpers ---

    private String relativePath(String segmentName) {
        return "rec/" + state.taskId + "/" + segmentName;
    }

    /** task_id comes from an exported broadcast: keep it a single, harmless path segment. */
    private static String safeTaskId(String raw) {
        if (raw == null) return "";
        String id = raw.trim().replaceAll("[^A-Za-z0-9._-]", "_");
        return id.matches("\\.*") ? id.replace('.', '_') : id;
    }

    /** 2/3 of the real screen, falling back to 1/2 and full size if the AVC encoder refuses it. */
    private void pickVideoSize() {
        DisplayMetrics m = new DisplayMetrics();
        getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(m);
        int fullW = Math.min(m.widthPixels, m.heightPixels);
        int fullH = Math.max(m.widthPixels, m.heightPixels);
        MediaCodecInfo.VideoCapabilities caps = avcEncoderCapabilities();
        int[][] scales = {{2, 3}, {1, 2}, {1, 1}};
        width = even(fullW * 2 / 3);
        height = even(fullH * 2 / 3);
        for (int[] s : scales) {
            int w = even(fullW * s[0] / s[1]);
            int h = even(fullH * s[0] / s[1]);
            if (caps == null || caps.isSizeSupported(w, h)) {
                width = w;
                height = h;
                break;
            }
        }
        dpi = m.densityDpi * width / fullW;
    }

    private static MediaCodecInfo.VideoCapabilities avcEncoderCapabilities() {
        for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
            if (!info.isEncoder()) continue;
            for (String type : info.getSupportedTypes()) {
                if (MediaFormat.MIMETYPE_VIDEO_AVC.equalsIgnoreCase(type)) {
                    return info.getCapabilitiesForType(type).getVideoCapabilities();
                }
            }
        }
        return null;
    }

    private static int even(int value) {
        return value & ~1;
    }

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void updateNotification(String text) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification(text));
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, SettingsActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent openSettings = PendingIntent.getActivity(
                this, 1, open, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setSmallIcon(android.R.drawable.presence_video_online)
                .setContentIntent(openSettings)
                .setOngoing(true)
                .build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        releaseProjection();
        if (state.authorized || state.recording) {
            markUnauthorized("record service stopped");
        }
        super.onDestroy();
    }
}
