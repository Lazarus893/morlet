package com.agent.helper;

import android.app.Activity;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.View;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.Button;
import android.widget.TextView;

import java.text.DateFormat;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Launcher entry of 小满手机助手: automation settings, the "我来接管" button and the
 * task status pushed from the Mac.
 */
public class SettingsActivity extends Activity {

    private static final int REQUEST_CAPTURE = 1;
    private static final int REQUEST_NOTIFICATIONS = 2;

    private interface IntSetter {
        void set(int value);
    }

    private interface IntFormatter {
        String format(int value);
    }

    private AppSettings settings;
    private boolean binding;

    private Switch swRecord;
    private Switch swBubble;
    private Switch swOverlay;
    private SeekBar seekScreenshot;
    private SeekBar seekCheckpoint;
    private SeekBar seekMaxSteps;
    private TextView valScreenshot;
    private TextView valCheckpoint;
    private TextView valMaxSteps;
    private View permCard;
    private View statusDot;
    private TextView statusState;
    private TextView statusText;
    private TextView statusTime;
    private TextView statusRecord;
    private TextView recordAuthStatus;
    private Button btnRecordAuth;

    private SharedPreferences statusPrefs;
    // Held in a field: SharedPreferences only keeps a weak reference to listeners.
    private final SharedPreferences.OnSharedPreferenceChangeListener statusListener =
            (prefs, key) -> renderStatus();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);
        AppSettings.ensureFile(this);
        statusPrefs = TaskStatus.prefs(this);

        swRecord = findViewById(R.id.sw_record);
        swBubble = findViewById(R.id.sw_bubble);
        swOverlay = findViewById(R.id.sw_overlay);
        seekScreenshot = findViewById(R.id.seek_screenshot);
        seekCheckpoint = findViewById(R.id.seek_checkpoint);
        seekMaxSteps = findViewById(R.id.seek_max_steps);
        valScreenshot = findViewById(R.id.val_screenshot);
        valCheckpoint = findViewById(R.id.val_checkpoint);
        valMaxSteps = findViewById(R.id.val_max_steps);
        permCard = findViewById(R.id.perm_card);
        statusDot = findViewById(R.id.status_dot);
        statusState = findViewById(R.id.status_state);
        statusText = findViewById(R.id.status_text);
        statusTime = findViewById(R.id.status_time);
        statusRecord = findViewById(R.id.status_record);
        recordAuthStatus = findViewById(R.id.record_auth_status);
        btnRecordAuth = findViewById(R.id.btn_record_auth);
        btnRecordAuth.setOnClickListener(v -> requestRecordConsent());

        swRecord.setOnCheckedChangeListener((b, checked) -> {
            settings.record = checked;
            persist();
        });
        swBubble.setOnCheckedChangeListener((b, checked) -> {
            settings.bubble = checked;
            persist();
            applyBubbleSetting(checked);
        });
        swOverlay.setOnCheckedChangeListener((b, checked) -> {
            settings.overlay = checked;
            persist();
        });

        IntFormatter everyN = v -> getString(R.string.every_n_steps, v);
        wireSeek(seekScreenshot, valScreenshot, R.id.label_screenshot,
                AppSettings.SCREENSHOT_MIN, AppSettings.SCREENSHOT_MAX, everyN,
                v -> settings.screenshotEvery = v);
        wireSeek(seekCheckpoint, valCheckpoint, R.id.label_checkpoint,
                AppSettings.CHECKPOINT_MIN, AppSettings.CHECKPOINT_MAX,
                v -> v == 0 ? getString(R.string.never_send) : everyN.format(v),
                v -> settings.checkpointEvery = v);
        wireSeek(seekMaxSteps, valMaxSteps, R.id.label_max_steps,
                AppSettings.MAX_STEPS_MIN, AppSettings.MAX_STEPS_MAX,
                v -> getString(R.string.n_steps, v),
                v -> settings.maxSteps = v);

        findViewById(R.id.btn_takeover).setOnClickListener(v -> {
            if (Takeover.request(this) && OverlayService.isBubbleShowing) {
                OverlayService.send(this, OverlayService.ACTION_BUBBLE_ON); // turn it grey
            }
        });
        findViewById(R.id.btn_grant).setOnClickListener(v -> startActivity(new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getPackageName()))));
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Re-read every time: the Mac side may have edited settings.json meanwhile.
        settings = AppSettings.load(this);
        bindSettings();
        permCard.setVisibility(Settings.canDrawOverlays(this) ? View.GONE : View.VISIBLE);
        renderStatus();
        statusPrefs.registerOnSharedPreferenceChangeListener(statusListener);
        RecordState.setListener(this::renderRecord);
        renderRecord();
    }

    @Override
    protected void onPause() {
        statusPrefs.unregisterOnSharedPreferenceChangeListener(statusListener);
        RecordState.setListener(null);
        super.onPause();
    }

    // --- Screen-recording consent ---

    /** Ask for notifications first (Android 13+) so "录屏已就绪" shows, then for capture. */
    private void requestRecordConsent() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_NOTIFICATIONS);
            return;
        }
        launchCaptureConsent();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQUEST_NOTIFICATIONS) {
            launchCaptureConsent(); // recording works without the notification, so go on anyway
        }
    }

    private void launchCaptureConsent() {
        MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
        // Android 14+: offer only "entire screen"; a single-app capture goes black once the
        // automation switches apps.
        Intent consent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                ? mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                : mpm.createScreenCaptureIntent();
        startActivityForResult(consent, REQUEST_CAPTURE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_CAPTURE) return;
        if (resultCode == RESULT_OK && data != null) {
            startForegroundService(new Intent(this, RecordService.class)
                    .setAction(RecordService.ACTION_AUTHORIZE)
                    .putExtra(RecordService.EXTRA_RESULT_CODE, resultCode)
                    .putExtra(RecordService.EXTRA_RESULT_DATA, data));
        } else if (!RecordService.isAuthorized) {
            RecordState state = RecordState.get(this);
            state.error = "authorization cancelled by user";
            state.save(this);
        }
    }

    private void renderRecord() {
        RecordState state = RecordState.get(this);
        boolean authorized = RecordService.isAuthorized;
        if (authorized) {
            recordAuthStatus.setText(R.string.record_auth_ok);
        } else {
            if (state.error.isEmpty()) {
                recordAuthStatus.setText(R.string.record_auth_none);
            } else if (RecordService.STOPPED_BY_SYSTEM.equals(state.error)) {
                recordAuthStatus.setText(R.string.record_auth_revoked);
            } else {
                recordAuthStatus.setText(R.string.record_auth_lost);
            }
        }
        btnRecordAuth.setText(authorized ? R.string.record_reauth_button : R.string.record_auth_button);

        if (state.recording) {
            statusRecord.setText(getString(R.string.record_status_recording,
                    state.taskId, state.segments.size() + 1));
        } else {
            statusRecord.setText(authorized ? R.string.record_status_ready : R.string.record_status_off);
        }
    }

    private void bindSettings() {
        binding = true;
        swRecord.setChecked(settings.record);
        swBubble.setChecked(settings.bubble);
        swOverlay.setChecked(settings.overlay);
        seekScreenshot.setProgress(settings.screenshotEvery);
        seekCheckpoint.setProgress(settings.checkpointEvery);
        seekMaxSteps.setProgress(settings.maxSteps);
        binding = false;
    }

    private void persist() {
        if (!binding) {
            settings.save(this);
        }
    }

    /** Turning the bubble on/off mid-task takes effect right away. */
    private void applyBubbleSetting(boolean enabled) {
        if (binding) return;
        if (!enabled && OverlayService.isBubbleShowing) {
            OverlayService.send(this, OverlayService.ACTION_BUBBLE_OFF);
        } else if (enabled && !OverlayService.isBubbleShowing) {
            TaskStatus status = TaskStatus.load(this);
            if (status != null && TaskStatus.RUNNING.equals(status.state)) {
                OverlayService.send(this, OverlayService.ACTION_BUBBLE_ON);
            }
        }
    }

    private void wireSeek(SeekBar bar, TextView valueLabel, int titleId, int min, int max,
                          IntFormatter formatter, IntSetter setter) {
        bar.setMin(min);
        bar.setMax(max);
        ((TextView) findViewById(titleId)).setLabelFor(bar.getId());
        bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            private boolean tracking;

            @Override
            public void onProgressChanged(SeekBar seekBar, int value, boolean fromUser) {
                String text = formatter.format(value);
                valueLabel.setText(text);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    seekBar.setStateDescription(text);
                }
                if (fromUser) {
                    setter.set(value);
                    // Dragging saves once on release; keyboard / TalkBack steps save at once.
                    if (!tracking) persist();
                }
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {
                tracking = true;
            }

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {
                tracking = false;
                persist();
            }
        });
    }

    private void renderStatus() {
        TaskStatus status = TaskStatus.load(this);
        if (status == null) {
            setStatusDot(R.color.status_idle);
            statusState.setText(R.string.status_none);
            statusText.setText(R.string.status_none_detail);
            statusText.setVisibility(View.VISIBLE);
            statusTime.setVisibility(View.GONE);
            return;
        }

        int labelId;
        int colorId;
        switch (status.state) {
            case TaskStatus.RUNNING:
                labelId = R.string.status_running;
                colorId = R.color.status_running;
                break;
            case TaskStatus.PAUSED:
                labelId = R.string.status_paused;
                colorId = R.color.status_paused;
                break;
            case TaskStatus.FINISHED:
                labelId = R.string.status_finished;
                colorId = R.color.status_finished;
                break;
            case TaskStatus.ERROR:
                labelId = R.string.status_error;
                colorId = R.color.status_error;
                break;
            default:
                labelId = 0;
                colorId = R.color.status_idle;
                break;
        }
        String label = labelId != 0 ? getString(labelId) : status.state;
        if (status.step > 0) {
            label = getString(TaskStatus.FINISHED.equals(status.state)
                    ? R.string.status_total_steps : R.string.status_step, label, status.step);
        }
        setStatusDot(colorId);
        statusState.setText(label);
        statusText.setText(status.text);
        statusText.setVisibility(TextUtils.isEmpty(status.text) ? View.GONE : View.VISIBLE);

        DateFormat timeFormat = new SimpleDateFormat("HH:mm:ss", Locale.getDefault());
        statusTime.setText(getString(R.string.status_updated_at,
                timeFormat.format(new Date(status.updatedAt))));
        statusTime.setVisibility(View.VISIBLE);
    }

    private void setStatusDot(int colorId) {
        statusDot.setBackgroundTintList(ColorStateList.valueOf(getColor(colorId)));
    }
}
