package dev.phoneuse;

import android.content.Context;
import android.content.SharedPreferences;

import java.security.SecureRandom;

/** Settings that live in the app's private storage: the token, the port, Wi-Fi mode. */
final class Prefs {
    static final int DEFAULT_PORT = 7333;

    private Prefs() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("phone-use", Context.MODE_PRIVATE);
    }

    /** The secret every request must carry (header x-phone-use-token). Created on first use. */
    static synchronized String token(Context context) {
        String token = prefs(context).getString("token", null);
        return token != null ? token : regenerateToken(context);
    }

    static synchronized String regenerateToken(Context context) {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b));
        prefs(context).edit().putString("token", hex.toString()).apply();
        return hex.toString();
    }

    static int port(Context context) {
        return prefs(context).getInt("port", DEFAULT_PORT);
    }

    /** Off: only this phone (reach it over USB with `adb forward`). On: also the local network / Tailscale. */
    static boolean network(Context context) {
        return prefs(context).getBoolean("network", false);
    }

    static void setNetwork(Context context, boolean on) {
        prefs(context).edit().putBoolean("network", on).apply();
    }

    static boolean paused(Context context) { return prefs(context).getBoolean("paused", false); }
    static void setPaused(Context context, boolean paused) { prefs(context).edit().putBoolean("paused", paused).apply(); }
}
