package dev.phoneuse;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;

/**
 * Asks Android for screen-capture permission and hands the result to {@link CaptureService}.
 * Android displays the screen-sharing consent dialog for the person holding the phone.
 */
public class CaptureActivity extends Activity {
    private static final int REQUEST = 1;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        CaptureService.requesting = true;
        if (state == null) {
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST);
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        CaptureService.requesting = false;
        if (request == REQUEST && result == RESULT_OK && data != null && !PhoneUseService.paused) {
            Intent service = new Intent(this, CaptureService.class)
                .putExtra(CaptureService.EXTRA_CODE, result)
                .putExtra(CaptureService.EXTRA_DATA, data);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
            else startService(service);
        }
        finish();
        overridePendingTransition(0, 0);
    }

    @Override protected void onDestroy() {
        if (!isChangingConfigurations()) CaptureService.requesting = false;
        super.onDestroy();
    }
}
