package com.agent.helper;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

public class DialogActivity extends Activity {

    private Handler timeoutHandler;
    private Runnable timeoutRunnable;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        Intent intent = getIntent();
        String title = intent.getStringExtra("title");
        String message = intent.getStringExtra("message");
        String type = intent.getStringExtra("type");
        int timeout = intent.getIntExtra("timeout", 0);

        if (TextUtils.isEmpty(type)) {
            type = "info";
        }

        switch (type) {
            case "yesno":
                setupYesNo(title, message);
                break;
            case "text_input":
                setupTextInput(title, message);
                break;
            case "info":
            default:
                setupInfo(title, message);
                break;
        }

        // Setup timeout auto-dismiss
        if (timeout > 0) {
            timeoutHandler = new Handler(Looper.getMainLooper());
            final String finalType = type;
            timeoutRunnable = () -> {
                ResponseWriter.writeResponse(DialogActivity.this, finalType, "timeout");
                finish();
            };
            timeoutHandler.postDelayed(timeoutRunnable, timeout * 1000L);
        }
    }

    private void setupYesNo(String title, String message) {
        setContentView(R.layout.dialog_yesno);

        TextView tvTitle = findViewById(R.id.dialog_title);
        TextView tvMessage = findViewById(R.id.dialog_message);
        Button btnYes = findViewById(R.id.btn_yes);
        Button btnNo = findViewById(R.id.btn_no);

        if (!TextUtils.isEmpty(title)) tvTitle.setText(title);
        if (!TextUtils.isEmpty(message)) tvMessage.setText(message);

        btnYes.setOnClickListener(v -> {
            ResponseWriter.writeResponse(this, "yesno", "yes");
            cancelTimeout();
            finish();
        });

        btnNo.setOnClickListener(v -> {
            ResponseWriter.writeResponse(this, "yesno", "no");
            cancelTimeout();
            finish();
        });
    }

    private void setupTextInput(String title, String message) {
        setContentView(R.layout.dialog_text_input);

        TextView tvTitle = findViewById(R.id.dialog_title);
        TextView tvMessage = findViewById(R.id.dialog_message);
        EditText etInput = findViewById(R.id.edit_input);
        Button btnSubmit = findViewById(R.id.btn_submit);
        TextView charCount = findViewById(R.id.char_count);

        if (!TextUtils.isEmpty(title)) tvTitle.setText(title);
        if (!TextUtils.isEmpty(message)) tvMessage.setText(message);

        // Character counter
        etInput.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {}

            @Override
            public void afterTextChanged(Editable s) {
                int len = s.length();
                if (len > 0) {
                    charCount.setText(len + " 字");
                    charCount.setVisibility(View.VISIBLE);
                } else {
                    charCount.setVisibility(View.INVISIBLE);
                }

                // Enable/disable submit based on content
                btnSubmit.setEnabled(len > 0);
                btnSubmit.setAlpha(len > 0 ? 1.0f : 0.5f);
            }
        });

        // Initially disable submit
        btnSubmit.setEnabled(false);
        btnSubmit.setAlpha(0.5f);

        // Auto-focus and show keyboard
        etInput.requestFocus();
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE
                | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        btnSubmit.setOnClickListener(v -> {
            String text = etInput.getText().toString().trim();
            if (!text.isEmpty()) {
                ResponseWriter.writeResponse(this, "text_input", text);
                cancelTimeout();
                finish();
            }
        });
    }

    private void setupInfo(String title, String message) {
        setContentView(R.layout.activity_dialog);

        TextView tvTitle = findViewById(R.id.dialog_title);
        TextView tvMessage = findViewById(R.id.dialog_message);
        Button btnOk = findViewById(R.id.btn_ok);

        if (!TextUtils.isEmpty(title)) tvTitle.setText(title);
        if (!TextUtils.isEmpty(message)) tvMessage.setText(message);

        btnOk.setOnClickListener(v -> {
            ResponseWriter.writeResponse(this, "info", "ok");
            cancelTimeout();
            finish();
        });
    }

    private void cancelTimeout() {
        if (timeoutHandler != null && timeoutRunnable != null) {
            timeoutHandler.removeCallbacks(timeoutRunnable);
        }
    }

    @Override
    protected void onDestroy() {
        cancelTimeout();
        super.onDestroy();
    }
}
