package dev.phoneuse;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** On-device setup and controls. Android owns the accessibility and capture consent screens. */
public class MainActivity extends Activity {
    @Override public void onCreate(Bundle state) { super.onCreate(state); }

    @Override public void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(body);
        setContentView(scroll);
        text(body, "Phone-Use", 30);
        text(body, "Let your agent read the screen, tap, type and scroll on this phone. You stay in control.", 17);
        PhoneUseService service = PhoneUseService.instance;
        text(body, service == null ? "Accessibility: off" : PhoneUseService.paused ? "Agent access: paused" : "Agent access: ready", 18);
        text(body, "1. Enable accessibility", 21);
        text(body, "Android will explain the access you are granting. Choose Phone-Use and turn it on.", 16);
        button(body, "Enable accessibility", () -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        text(body, "2. Allow screenshots (optional)", 21);
        text(body, "Approve Android's screen-sharing prompt. Images are made only on request and are not saved on this phone. Android may ask again after a restart or when sharing stops.", 16);
        button(body, CaptureService.ready() ? "Screen sharing is active" : "Allow screenshots", () -> {
            if (!CaptureService.ready()) startActivity(new Intent(this, CaptureActivity.class));
        });
        text(body, "Control agent access", 21);
        text(body, "Stop blocks screen reads and actions. Resume here or with the pill on the phone. To revoke access entirely, turn Phone-Use off in accessibility settings.", 16);
        button(body, PhoneUseService.paused ? "Resume agent access" : "Stop agent access", () -> {
            if (service != null) service.setPaused(!PhoneUseService.paused);
            render();
        });
        text(body, "Connection", 21);
        text(body, Prefs.network(this)
            ? "Network access is on. Use your phone's Tailscale address for an encrypted connection."
            : "USB only. Your computer connects through the USB debugging connection you approved.", 16);
        button(body, Prefs.network(this) ? "Use USB only" : "Enable Wi-Fi / Tailscale access", () -> {
            Prefs.setNetwork(this, !Prefs.network(this));
            if (service != null) service.restartServer();
            render();
        });
        text(body, "Phone-Use  " + BuildInfo.VERSION, 13);
    }

    private void text(LinearLayout parent, String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(Color.rgb(235, 240, 244));
        view.setTextSize(size);
        view.setPadding(0, 12, 0, 12);
        parent.addView(view);
    }

    private void button(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(v -> action.run());
        parent.addView(button, new LinearLayout.LayoutParams(-1, -2));
    }
}
