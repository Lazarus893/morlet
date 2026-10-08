package com.agent.helper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.view.animation.AlphaAnimation;
import android.view.animation.Animation;
import android.view.animation.AnimationSet;
import android.view.animation.ScaleAnimation;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

public class OverlayService extends Service {

    private static final String TAG = "OverlayService";
    private static final String CHANNEL_ID = "agent_helper_channel";
    private static final int NOTIFICATION_ID = 1;
    private static final long LONG_PRESS_DURATION = 3000L; // 3 seconds

    static final String ACTION_OVERLAY_ON = "com.agent.helper.OVERLAY_ON";
    static final String ACTION_OVERLAY_OFF = "com.agent.helper.OVERLAY_OFF";
    static final String ACTION_OVERLAY_STATUS = "com.agent.helper.OVERLAY_STATUS";
    /** Show (or refresh) the floating takeover bubble. Internal, sent by TaskStatusReceiver. */
    static final String ACTION_BUBBLE_ON = "com.agent.helper.BUBBLE_ON";
    static final String ACTION_BUBBLE_OFF = "com.agent.helper.BUBBLE_OFF";
    /** Task finished or failed: remove every floating window and stop the service. */
    static final String ACTION_TASK_ENDED = "com.agent.helper.TASK_ENDED";

    private WindowManager windowManager;
    private View overlayView;
    private boolean overlayVisible = false;

    // Static fields for status queries
    static boolean isOverlayShowing = false;
    static boolean isBubbleShowing = false;
    static boolean isRunning = false;

    private View bubbleView;
    private WindowManager.LayoutParams bubbleParams;

    private BroadcastReceiver overlayReceiver;
    private Handler animHandler;
    private Runnable dotAnimRunnable;
    private Runnable statusTextRunnable;
    private int currentDot = 0;
    private int currentStatusIndex = 0;

    private static final String[] STATUS_TEXTS = {
        "正在分析屏幕…",
        "正在执行操作…",
        "正在处理中…",
        "等待响应…",
        "正在规划下一步…",
    };

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        animHandler = new Handler(Looper.getMainLooper());
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        registerOverlayReceiver();
        isRunning = true;
    }

    /** Starts the service (if needed) with the given action. */
    static void send(Context context, String action) {
        Intent intent = new Intent(context, OverlayService.class).setAction(action);
        try {
            context.startForegroundService(intent);
        } catch (RuntimeException e) {
            // e.g. ForegroundServiceStartNotAllowedException when overlay permission is missing
            Log.e(TAG, "Failed to start OverlayService for " + action, e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_OVERLAY_ON.equals(action)) {
                showOverlay();
            } else if (ACTION_OVERLAY_OFF.equals(action)) {
                hideOverlay();
            } else if (ACTION_OVERLAY_STATUS.equals(action)) {
                writeStatus();
            } else if (ACTION_BUBBLE_ON.equals(action)) {
                showBubble();
            } else if (ACTION_BUBBLE_OFF.equals(action)) {
                hideBubble();
            } else if (ACTION_TASK_ENDED.equals(action)) {
                hideOverlay();
                hideBubble();
                stopSelf(startId);
                return START_NOT_STICKY;
            }
        }
        return START_STICKY;
    }

    private void registerOverlayReceiver() {
        overlayReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (ACTION_OVERLAY_ON.equals(action)) {
                    showOverlay();
                } else if (ACTION_OVERLAY_OFF.equals(action)) {
                    hideOverlay();
                } else if (ACTION_OVERLAY_STATUS.equals(action)) {
                    writeStatus();
                }
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_OVERLAY_ON);
        filter.addAction(ACTION_OVERLAY_OFF);
        filter.addAction(ACTION_OVERLAY_STATUS);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(overlayReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(overlayReceiver, filter);
        }
    }

    private void showOverlay() {
        if (overlayVisible) return;

        LayoutInflater inflater = LayoutInflater.from(this);
        overlayView = inflater.inflate(R.layout.overlay_layout, null);

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;

        // Intercept all touches on the overlay except the unlock button
        overlayView.setOnTouchListener((v, event) -> true); // consume all touches

        // Setup unlock button with long press + progress indicator
        Button btnUnlock = overlayView.findViewById(R.id.btn_unlock);
        ProgressBar progressBar = overlayView.findViewById(R.id.unlock_progress);
        btnUnlock.setOnTouchListener(new LongPressUnlockListener(btnUnlock, progressBar));

        windowManager.addView(overlayView, params);
        overlayVisible = true;
        isOverlayShowing = true;
        raiseBubble();

        // Start loading animations
        startDotAnimation();
        startStatusTextRotation();

        Log.d(TAG, "Overlay shown");
    }

    private void hideOverlay() {
        if (!overlayVisible || overlayView == null) return;

        // Stop animations
        stopAnimations();

        windowManager.removeView(overlayView);
        overlayView = null;
        overlayVisible = false;
        isOverlayShowing = false;

        Log.d(TAG, "Overlay hidden");
    }

    // --- Takeover bubble: small draggable pill on the right edge ---

    private void showBubble() {
        if (bubbleView == null) {
            if (!Settings.canDrawOverlays(this)) {
                Log.w(TAG, "No overlay permission, cannot show bubble");
                return;
            }
            bubbleView = LayoutInflater.from(this).inflate(R.layout.overlay_bubble, null);
            bubbleParams = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT
            );
            bubbleParams.gravity = Gravity.END | Gravity.CENTER_VERTICAL;
            bubbleParams.x = dp(8);
            bubbleParams.y = 0;
            bubbleView.setOnTouchListener(new BubbleTouchListener());
            bubbleView.setOnClickListener(v -> onBubbleTapped());
            try {
                windowManager.addView(bubbleView, bubbleParams);
            } catch (RuntimeException e) {
                Log.e(TAG, "Failed to add bubble", e);
                bubbleView = null;
                return;
            }
            isBubbleShowing = true;
            Log.d(TAG, "Bubble shown");
        }
        renderBubble();
    }

    private void hideBubble() {
        if (bubbleView == null) return;
        try {
            windowManager.removeView(bubbleView);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "Bubble already detached", e);
        }
        bubbleView = null;
        isBubbleShowing = false;
        Log.d(TAG, "Bubble hidden");
    }

    /** Re-adds the bubble so it stays above the full-screen overlay and remains tappable. */
    private void raiseBubble() {
        if (bubbleView == null) return;
        windowManager.removeView(bubbleView);
        windowManager.addView(bubbleView, bubbleParams);
    }

    /** Grey "requested" look while control.json still holds an unanswered takeover. */
    private void renderBubble() {
        boolean requested = Takeover.isPending(this);
        TextView title = bubbleView.findViewById(R.id.bubble_title);
        TextView action = bubbleView.findViewById(R.id.bubble_action);
        title.setText(requested ? R.string.bubble_requested_title : R.string.bubble_title);
        action.setText(requested ? R.string.bubble_requested_action : R.string.bubble_action);
        bubbleView.setBackgroundResource(requested ? R.drawable.bubble_bg_requested : R.drawable.bubble_bg);
        bubbleView.setContentDescription(getString(requested
                ? R.string.bubble_requested_description : R.string.bubble_description));
    }

    private void onBubbleTapped() {
        if (Takeover.isPending(this)) {
            Toast.makeText(this, R.string.takeover_already, Toast.LENGTH_SHORT).show();
            return;
        }
        if (Takeover.request(this)) {
            hideOverlay(); // the user is taking the phone back: stop blocking their touches
            renderBubble();
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /** Drag to move; a tap without movement is a click. Releases snap to the nearest side. */
    private class BubbleTouchListener implements View.OnTouchListener {
        private final int touchSlop = ViewConfiguration.get(OverlayService.this).getScaledTouchSlop();
        private float downX;
        private float downY;
        private int startX;
        private int startY;
        private boolean dragging;

        @Override
        public boolean onTouch(View v, MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = event.getRawX();
                    downY = event.getRawY();
                    startX = bubbleParams.x;
                    startY = bubbleParams.y;
                    dragging = false;
                    return true;

                case MotionEvent.ACTION_MOVE:
                    float dx = event.getRawX() - downX;
                    float dy = event.getRawY() - downY;
                    if (!dragging && Math.hypot(dx, dy) > touchSlop) {
                        dragging = true;
                    }
                    if (dragging) {
                        // Gravity.END: x grows leftwards; CENTER_VERTICAL: y is offset from centre
                        moveBubble(v, startX - Math.round(dx), startY + Math.round(dy));
                    }
                    return true;

                case MotionEvent.ACTION_UP:
                    if (dragging) {
                        snapBubble(v);
                    } else {
                        v.performClick();
                    }
                    return true;

                case MotionEvent.ACTION_CANCEL:
                    if (dragging) {
                        snapBubble(v);
                    }
                    return true;
            }
            return false;
        }

        private void moveBubble(View v, int x, int y) {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            int maxX = Math.max(0, dm.widthPixels - v.getWidth());
            int maxY = Math.max(0, (dm.heightPixels - v.getHeight()) / 2);
            bubbleParams.x = Math.max(0, Math.min(maxX, x));
            bubbleParams.y = Math.max(-maxY, Math.min(maxY, y));
            windowManager.updateViewLayout(v, bubbleParams);
        }

        private void snapBubble(View v) {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            int margin = dp(8);
            boolean nearerLeft = bubbleParams.x + v.getWidth() / 2 > dm.widthPixels / 2;
            bubbleParams.x = nearerLeft ? dm.widthPixels - v.getWidth() - margin : margin;
            windowManager.updateViewLayout(v, bubbleParams);
        }
    }

    // --- Loading dot animation (Claude-style sequential pulse) ---

    private void startDotAnimation() {
        currentDot = 0;
        dotAnimRunnable = new Runnable() {
            @Override
            public void run() {
                if (overlayView == null) return;

                View dot1 = overlayView.findViewById(R.id.dot_1);
                View dot2 = overlayView.findViewById(R.id.dot_2);
                View dot3 = overlayView.findViewById(R.id.dot_3);
                if (dot1 == null || dot2 == null || dot3 == null) return;

                View[] dots = {dot1, dot2, dot3};

                // Reset all dots to dim
                for (View dot : dots) {
                    dot.setAlpha(0.3f);
                    dot.setScaleX(0.8f);
                    dot.setScaleY(0.8f);
                }

                // Highlight current dot with scale + fade animation
                View activeDot = dots[currentDot % 3];
                activeDot.animate()
                    .alpha(1.0f)
                    .scaleX(1.2f)
                    .scaleY(1.2f)
                    .setDuration(300)
                    .start();

                currentDot++;
                animHandler.postDelayed(this, 500);
            }
        };
        animHandler.post(dotAnimRunnable);
    }

    private void startStatusTextRotation() {
        currentStatusIndex = 0;
        statusTextRunnable = new Runnable() {
            @Override
            public void run() {
                if (overlayView == null) return;

                TextView statusText = overlayView.findViewById(R.id.overlay_status);
                if (statusText == null) return;

                // Fade out → change text → fade in
                statusText.animate()
                    .alpha(0f)
                    .setDuration(200)
                    .withEndAction(() -> {
                        statusText.setText(STATUS_TEXTS[currentStatusIndex % STATUS_TEXTS.length]);
                        statusText.animate()
                            .alpha(0.8f)
                            .setDuration(300)
                            .start();
                    })
                    .start();

                currentStatusIndex++;
                animHandler.postDelayed(this, 4000); // Rotate every 4 seconds
            }
        };
        animHandler.postDelayed(statusTextRunnable, 4000); // First change after 4s
    }

    private void stopAnimations() {
        if (dotAnimRunnable != null) {
            animHandler.removeCallbacks(dotAnimRunnable);
        }
        if (statusTextRunnable != null) {
            animHandler.removeCallbacks(statusTextRunnable);
        }
    }

    private void writeStatus() {
        ResponseWriter.writeResponse(this, "overlay_status",
                overlayVisible ? "visible" : "hidden");
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.app_name),
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.notification_channel_description));
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, SettingsActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent openSettings = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.notification_text))
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
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
        stopAnimations();
        hideOverlay();
        hideBubble();
        isRunning = false;
        if (overlayReceiver != null) {
            unregisterReceiver(overlayReceiver);
        }
        super.onDestroy();
    }

    /**
     * Custom touch listener: 3-second long press to unlock, with progress feedback.
     */
    private class LongPressUnlockListener implements View.OnTouchListener {
        private boolean isPressed = false;
        private final Handler handler = new Handler(Looper.getMainLooper());
        private final Button button;
        private final ProgressBar progressBar;
        private Runnable progressRunnable;
        private int progressValue = 0;

        LongPressUnlockListener(Button button, ProgressBar progressBar) {
            this.button = button;
            this.progressBar = progressBar;
        }

        private final Runnable unlockRunnable = () -> {
            stopProgressAnimation();
            hideOverlay();
            isPressed = false;
        };

        private void startProgressAnimation() {
            progressValue = 0;
            progressBar.setProgress(0);
            progressBar.setVisibility(View.VISIBLE);

            progressRunnable = new Runnable() {
                @Override
                public void run() {
                    if (!isPressed) return;
                    progressValue += 2;
                    progressBar.setProgress(Math.min(progressValue, 100));

                    // Update button text with countdown
                    int secondsLeft = (int) Math.ceil((100 - progressValue) * LONG_PRESS_DURATION / 100.0 / 1000.0);
                    if (secondsLeft > 0) {
                        button.setText(String.format("按住中… (%d秒)", secondsLeft));
                    }

                    if (progressValue < 100) {
                        handler.postDelayed(this, LONG_PRESS_DURATION / 50);
                    }
                }
            };
            handler.post(progressRunnable);
        }

        private void stopProgressAnimation() {
            if (progressRunnable != null) {
                handler.removeCallbacks(progressRunnable);
            }
            progressBar.setVisibility(View.INVISIBLE);
            progressBar.setProgress(0);
        }

        @Override
        public boolean onTouch(View v, MotionEvent event) {
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    isPressed = true;
                    button.setText("按住中… (3秒)");
                    button.setAlpha(1.0f);
                    startProgressAnimation();
                    handler.postDelayed(unlockRunnable, LONG_PRESS_DURATION);
                    return true;

                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (isPressed) {
                        isPressed = false;
                        handler.removeCallbacks(unlockRunnable);
                        stopProgressAnimation();
                        button.setText(getString(R.string.overlay_unlock));
                        button.setAlpha(1.0f);
                    }
                    return true;
            }
            return true;
        }
    }
}
