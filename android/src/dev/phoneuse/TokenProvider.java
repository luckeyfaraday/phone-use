package dev.phoneuse;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Binder;

/**
 * Lets the setup tool read and change settings over USB:
 *   adb shell content query  --uri content://dev.phoneuse.token/token
 *   adb shell content update --uri content://dev.phoneuse.token/token --bind network:i:1
 *   adb shell content update --uri content://dev.phoneuse.token/token --bind regenerate:i:1
 * Only `adb shell` (uid 2000) or root may use it: other apps on the phone get nothing.
 */
public class TokenProvider extends ContentProvider {
    private static final int SHELL_UID = 2000;

    @Override
    public boolean onCreate() {
        return true;
    }

    private static void requireShell() {
        int caller = Binder.getCallingUid();
        if (caller != SHELL_UID && caller != 0) throw new SecurityException("only adb shell may use the phone-use settings");
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        requireShell();
        MatrixCursor cursor = new MatrixCursor(new String[] {"token", "port", "network", "version"});
        cursor.addRow(new Object[] {Prefs.token(getContext()), Prefs.port(getContext()), Prefs.network(getContext()) ? 1 : 0, BuildInfo.VERSION});
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    /** network=1|0 listens on Wi-Fi/Tailscale too (or this phone only); regenerate=1 makes a new token. */
    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        requireShell();
        int changed = 0;
        if (values.containsKey("network")) {
            boolean previous = Prefs.network(getContext());
            Prefs.setNetwork(getContext(), values.getAsInteger("network") == 1);
            PhoneUseService service = PhoneUseService.instance;
            if (service != null && !service.restartServer()) {
                // Put the old listener back so the phone stays reachable, then tell the caller.
                Prefs.setNetwork(getContext(), previous);
                service.restartServer();
                throw new IllegalStateException("could not reopen the listener; network access is still " + (previous ? "on" : "off"));
            }
            changed++;
        }
        if (values.containsKey("regenerate") && values.getAsInteger("regenerate") == 1) {
            Prefs.regenerateToken(getContext());
            changed++;
        }
        return changed;
    }
}
