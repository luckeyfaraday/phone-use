package dev.phoneuse;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Phone-use: lets an AI agent see and operate any app on this phone, like computer-use does
 * on a desktop. Serves a small JSON API (default port 7333) that requires the token in the
 * x-phone-use-token header. See docs/API.md.
 *
 *   GET  /status                          connected, paused, screenshots ready
 *   GET  /screen                          numbered on-screen elements: role, text, position, abilities
 *   GET  /screenshot?scale=0.5&quality=70 a JPEG of the screen (base64 "data")
 *   GET  /apps                            launchable apps: package, label, system
 *   POST /tap        {id} | {x, y}        tap an element (number from /screen) or a point
 *   POST /longpress  {id} | {x, y}
 *   POST /swipe      {x1, y1, x2, y2, ms}
 *   POST /scroll     {direction: down|up|left|right, id?}
 *   POST /type       {text, id?, append?} set the text of a field (the focused one by default)
 *   POST /key        {key: back|home|recents|notifications|quick_settings|power|lock}
 *   POST /open       {package}
 *   POST /pause                           (resume only on the phone)
 *
 * Every action answers with the screen right after it ("screen"). While an agent acts, a
 * pill shows on screen; tapping Stop pauses phone-use until resumed.
 */
public class PhoneUseService extends AccessibilityService {
    private static final String TAG = "phone-use";
    private static final int MAX_ELEMENTS = 350;
    private static final long PILL_LINGER_MS = 8000;

    static volatile PhoneUseService instance;
    static volatile boolean paused;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private final List<AccessibilityNodeInfo> lastElements = new ArrayList<>();
    private final Object requestLock = new Object();
    private volatile ServerSocket server;
    private Thread listener;
    private volatile long lastActionAt;
    private TextView pill;

    // ------------------------------------------------------------- lifecycle

    @Override
    protected void onServiceConnected() {
        instance = this;
        paused = Prefs.paused(this);
        createPill();
        restartServer();
        if (paused) main.post(() -> showPill("⏸  Phone-use paused  ·  Resume"));
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public void onDestroy() {
        instance = null;
        closeServer();
        stopService(new Intent(this, CaptureService.class));
        workers.shutdownNow();
        main.post(() -> {
            if (pill != null) ((WindowManager) getSystemService(WINDOW_SERVICE)).removeView(pill);
        });
        super.onDestroy();
    }

    // ------------------------------------------------------------------ HTTP

    /** (Re)open the listener: this phone only, or every interface when network mode is on. False if it couldn't. */
    synchronized boolean restartServer() {
        closeServer();
        String host = Prefs.network(this) ? "0.0.0.0" : "127.0.0.1";
        for (int attempt = 1; ; attempt++) {
            ServerSocket socket = null;
            try {
                socket = new ServerSocket();
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(InetAddress.getByName(host), Prefs.port(this)), 8);
                ServerSocket bound = socket;
                server = bound;
                listener = new Thread(() -> serve(bound), "phone-use-http");
                listener.setDaemon(true);
                listener.start();
                return true;
            } catch (Exception e) {
                closeQuietly(socket);
                if (!(e instanceof BindException) || attempt == 20) {
                    Log.e(TAG, "could not start listener", e);
                    return false;
                }
                SystemClock.sleep(50);
            }
        }
    }

    private void closeServer() {
        Thread old = listener;
        closeQuietly(server);
        server = null;
        listener = null;
        // The kernel keeps the port bound until the old listener's accept() returns, so binding again
        // straight away fails with "Address already in use". Wait for that thread to finish.
        if (old != null && old != Thread.currentThread()) {
            try {
                old.join(1000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static void closeQuietly(ServerSocket socket) {
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
    }

    private void serve(ServerSocket socket) {
        try {
            Log.i(TAG, "listening on " + socket.getLocalSocketAddress());
            while (!socket.isClosed()) {
                Socket client = socket.accept();
                workers.execute(() -> handle(client));
            }
        } catch (Exception e) {
            Log.i(TAG, "listener stopped: " + e.getMessage());
        }
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(15000);
            HttpRequest request = HttpRequest.read(new BufferedInputStream(s.getInputStream()));
            if (request == null) return;
            String method = request.method;
            String target = request.target;
            String path = target.split("\\?")[0];
            JSONObject query = new JSONObject();
            if (target.contains("?")) {
                for (String pair : target.substring(target.indexOf('?') + 1).split("&")) {
                    String[] kv = pair.split("=", 2);
                    if (kv.length == 2) query.put(kv[0], URLDecoder.decode(kv[1], "UTF-8"));
                }
            }
            String presented = request.headers.get("x-phone-use-token");

            int status = 200;
            JSONObject out;
            if (!Prefs.token(this).equals(presented)) {
                status = 401;
                out = new JSONObject().put("error", "missing or wrong token (header x-phone-use-token)");
            } else {
                try {
                    JSONObject args = method.equals("GET") ? query : (!request.body.isEmpty() ? new JSONObject(request.body) : new JSONObject());
                    synchronized (requestLock) { out = route(method, path, args); }
                } catch (Paused e) {
                    status = 423;
                    out = new JSONObject().put("error", "Phone-use is paused: the person holding the phone tapped Stop. Ask them before continuing.");
                } catch (IllegalArgumentException | IllegalStateException | org.json.JSONException e) {
                    status = 400;
                    out = new JSONObject().put("error", e.getMessage());
                }
            }
            byte[] bytes = out.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream o = s.getOutputStream();
            o.write(("HTTP/1.1 " + status + " " + (status == 200 ? "OK" : "Error") + "\r\nContent-Type: application/json\r\nContent-Length: "
                + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            o.write(bytes);
            o.flush();
        } catch (Exception e) {
            Log.w(TAG, "request failed", e);
        }
    }

    private static class Paused extends Exception {
    }

    private JSONObject route(String method, String path, JSONObject args) throws Exception {
        boolean status = method.equals("GET") && path.equals("/status");
        boolean pause = method.equals("POST") && path.equals("/pause");
        if (!status && !pause && paused) throw new Paused();
        if (!status && !pause && CaptureService.requesting) throw new IllegalStateException("Approve or dismiss screen sharing on the phone before continuing.");
        if (method.equals("GET")) {
            switch (path) {
                case "/status":
                    return new JSONObject().put("connected", true).put("paused", paused)
                        .put("screenshots", CaptureService.ready()).put("version", BuildInfo.VERSION)
                        .put("android", Build.VERSION.RELEASE).put("device", Build.MANUFACTURER + " " + Build.MODEL);
                case "/screen":
                    acting();
                    return screen();
                case "/apps":
                    return apps();
                case "/screenshot":
                    if (paused) throw new Paused();
                    return screenshot((float) args.optDouble("scale", 0.5), args.optInt("quality", 70));
                default:
                    throw new IllegalArgumentException("unknown route GET " + path);
            }
        }
        if (!method.equals("POST")) throw new IllegalArgumentException("unknown route " + method + " " + path);
        if (path.equals("/pause")) {
            setPaused(true);
            return new JSONObject().put("paused", paused);
        }
        if (path.equals("/resume")) throw new IllegalStateException("Resume agent access on the phone.");
        if (paused) throw new Paused();
        acting();
        boolean ok;
        switch (path) {
            case "/tap":
                ok = tap(args, false);
                break;
            case "/longpress":
                ok = tap(args, true);
                break;
            case "/swipe":
                ok = swipe(args.getInt("x1"), args.getInt("y1"), args.getInt("x2"), args.getInt("y2"), args.optLong("ms", 350));
                break;
            case "/scroll":
                ok = scroll(args.optString("direction", "down"), args.has("id") ? args.getInt("id") : -1);
                break;
            case "/type":
                ok = type(args.getString("text"), args.has("id") ? args.getInt("id") : -1, args.optBoolean("append", false));
                break;
            case "/key":
                ok = key(args.getString("key"));
                break;
            case "/open":
                ok = open(args.has("package") ? args.getString("package") : args.getString("pkg"));
                break;
            default:
                throw new IllegalArgumentException("unknown route POST " + path);
        }
        Thread.sleep(Math.max(0, Math.min(args.optLong("settle_ms", 700), 5000)));
        return new JSONObject().put("ok", ok).put("screen", screen());
    }

    // ---------------------------------------------------------------- screen

    /** Numbered list of what's on screen. Numbers are valid until the next /screen. */
    private synchronized JSONObject screen() throws Exception {
        if (paused) throw new Paused();
        lastElements.clear();
        StringBuilder text = new StringBuilder();
        JSONArray elements = new JSONArray();
        String app = null;
        AccessibilityNodeInfo active = getRootInActiveWindow();
        if (active != null && active.getPackageName() != null) app = active.getPackageName().toString();
        DisplayMetrics m = getResources().getDisplayMetrics();
        text.append("app: ").append(app).append("   screen: ").append(m.widthPixels).append('x').append(m.heightPixels).append('\n');
        // The app first, then the keyboard, then system bars: the agent reads what matters first.
        List<AccessibilityWindowInfo> windows = new ArrayList<>(getWindows());
        Collections.sort(windows, (a, b) -> windowRank(a.getType()) - windowRank(b.getType()));
        for (AccessibilityWindowInfo window : windows) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) continue;
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            CharSequence title = Build.VERSION.SDK_INT >= 24 ? window.getTitle() : null;
            text.append("## ").append(windowType(window.getType()))
                .append(title != null ? " \"" + title + "\"" : "")
                .append(root.getPackageName() != null ? " (" + root.getPackageName() + ")" : "")
                .append('\n');
            walk(root, 0, text, elements);
        }
        if (lastElements.size() >= MAX_ELEMENTS) text.append("… (truncated at ").append(MAX_ELEMENTS).append(" elements)\n");
        return new JSONObject().put("app", app).put("text", text.toString()).put("elements", elements).put("paused", paused);
    }

    private void walk(AccessibilityNodeInfo node, int depth, StringBuilder text, JSONArray elements) throws Exception {
        if (node == null || lastElements.size() >= MAX_ELEMENTS || !node.isVisibleToUser()) return;
        CharSequence label = node.getText();
        CharSequence desc = node.getContentDescription();
        boolean interesting = (label != null && label.length() > 0) || (desc != null && desc.length() > 0)
            || node.isClickable() || node.isLongClickable() || node.isScrollable() || node.isEditable() || node.isCheckable();
        if (interesting) {
            int id = lastElements.size();
            lastElements.add(node);
            Rect r = new Rect();
            node.getBoundsInScreen(r);
            String role = shortClass(node.getClassName());
            String viewId = node.getViewIdResourceName();
            if (viewId != null && viewId.contains("/")) viewId = viewId.substring(viewId.indexOf('/') + 1);
            StringBuilder line = new StringBuilder();
            for (int i = 0; i < Math.min(depth, 12); i++) line.append(' ');
            line.append('[').append(id).append("] ").append(role);
            if (label != null && label.length() > 0) line.append(" \"").append(clip(label)).append('"');
            if (desc != null && desc.length() > 0 && !desc.toString().equals(String.valueOf(label))) line.append(" desc=\"").append(clip(desc)).append('"');
            if (viewId != null) line.append(" #").append(viewId);
            line.append(" @").append(r.centerX()).append(',').append(r.centerY());
            if (node.isClickable()) line.append(" tap");
            if (node.isLongClickable()) line.append(" longpress");
            if (node.isScrollable()) line.append(" scroll");
            if (node.isEditable()) line.append(" edit");
            if (node.isCheckable()) line.append(node.isChecked() ? " [x]" : " [ ]");
            if (node.isFocused()) line.append(" focused");
            if (!node.isEnabled()) line.append(" disabled");
            text.append(line).append('\n');
            elements.put(new JSONObject().put("id", id).put("role", role)
                .put("text", label != null ? label.toString() : null)
                .put("desc", desc != null ? desc.toString() : null)
                .put("view_id", viewId)
                .put("bounds", new JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom))
                .put("clickable", node.isClickable()).put("scrollable", node.isScrollable())
                .put("editable", node.isEditable()));
        }
        for (int i = 0; i < node.getChildCount(); i++) walk(node.getChild(i), depth + 1, text, elements);
    }

    private static String clip(CharSequence s) {
        String t = s.toString().replace('\n', ' ');
        return t.length() > 140 ? t.substring(0, 137) + "…" : t;
    }

    private static String shortClass(CharSequence cls) {
        if (cls == null) return "View";
        String s = cls.toString();
        return s.substring(s.lastIndexOf('.') + 1);
    }

    private static int windowRank(int type) {
        if (type == AccessibilityWindowInfo.TYPE_APPLICATION) return 0;
        if (type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return 1;
        return 2;
    }

    private static String windowType(int type) {
        switch (type) {
            case AccessibilityWindowInfo.TYPE_APPLICATION: return "app";
            case AccessibilityWindowInfo.TYPE_INPUT_METHOD: return "keyboard";
            case AccessibilityWindowInfo.TYPE_SYSTEM: return "system";
            default: return "window";
        }
    }

    private synchronized AccessibilityNodeInfo element(int id) {
        if (id < 0 || id >= lastElements.size()) throw new IllegalArgumentException("no element [" + id + "]: read the screen first");
        return lastElements.get(id);
    }

    /** Launchable apps, sorted by name: [{package, label, system}]. */
    private JSONObject apps() throws Exception {
        android.content.pm.PackageManager pm = getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<android.content.pm.ResolveInfo> found = pm.queryIntentActivities(launcher, 0);
        Collections.sort(found, (a, b) -> String.valueOf(a.loadLabel(pm)).compareToIgnoreCase(String.valueOf(b.loadLabel(pm))));
        JSONArray list = new JSONArray();
        for (android.content.pm.ResolveInfo info : found) {
            boolean system = (info.activityInfo.applicationInfo.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0;
            list.put(new JSONObject().put("package", info.activityInfo.packageName)
                .put("label", String.valueOf(info.loadLabel(pm))).put("system", system));
        }
        return new JSONObject().put("apps", list);
    }

    // ------------------------------------------------------------ screenshot

    /** A JPEG of the screen. The pill is hidden for the shot, then flashes so the person knows. */
    private JSONObject screenshot(float scale, int quality) throws Exception {
        if (!CaptureService.ready()) throw new IllegalStateException("Open Phone-Use on the phone, tap Allow screenshots, and approve Android's screen-sharing prompt. Then retry.");
        CountDownLatch hidden = new CountDownLatch(1);
        main.post(() -> {
            if (pill != null) pill.setVisibility(View.GONE);
            hidden.countDown();
        });
        hidden.await(1, TimeUnit.SECONDS);
        Thread.sleep(60);
        CaptureService.Shot shot;
        try {
            shot = CaptureService.capture(this, scale, quality);
            if (paused) throw new Paused();
        } finally {
            lastActionAt = System.currentTimeMillis();
            main.post(() -> {
                showPill(paused ? "⏸  Phone-use paused  ·  Resume" : "📷  Agent screenshot request  ·  Stop");
                main.postDelayed(this::hidePillIfIdle, PILL_LINGER_MS + 100);
            });
        }
        return new JSONObject().put("mime", "image/jpeg").put("width", shot.width).put("height", shot.height)
            .put("screen_width", shot.screenWidth).put("screen_height", shot.screenHeight)
            .put("scale_to_screen", (double) shot.screenWidth / shot.width)
            .put("data", shot.jpegBase64);
    }

    // --------------------------------------------------------------- actions

    private boolean tap(JSONObject args, boolean longPress) throws Exception {
        if (args.has("id")) {
            AccessibilityNodeInfo node = element(args.getInt("id"));
            for (AccessibilityNodeInfo n = node; n != null; n = n.getParent()) {
                if (longPress ? n.isLongClickable() : n.isClickable()) {
                    if (n.performAction(longPress ? AccessibilityNodeInfo.ACTION_LONG_CLICK : AccessibilityNodeInfo.ACTION_CLICK)) return true;
                    break;
                }
            }
            Rect r = new Rect();
            node.getBoundsInScreen(r);
            return press(r.centerX(), r.centerY(), longPress ? 700 : 60);
        }
        return press(args.getInt("x"), args.getInt("y"), longPress ? 700 : 60);
    }

    private boolean press(int x, int y, long ms) throws InterruptedException {
        Path path = new Path();
        path.moveTo(x, y);
        return gesture(path, ms);
    }

    private boolean swipe(int x1, int y1, int x2, int y2, long ms) throws InterruptedException {
        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
        return gesture(path, Math.max(50, Math.min(ms, 3000)));
    }

    private boolean gesture(Path path, long ms) throws InterruptedException {
        GestureDescription g = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, ms)).build();
        CountDownLatch done = new CountDownLatch(1);
        boolean[] ok = {false};
        main.post(() -> {
            if (paused || CaptureService.requesting) { done.countDown(); return; }
            boolean accepted = dispatchGesture(g, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription d) {
                ok[0] = true;
                done.countDown();
            }

            @Override
            public void onCancelled(GestureDescription d) {
                done.countDown();
            }
            }, null);
            if (!accepted) done.countDown();
        });
        done.await(ms + 3000, TimeUnit.MILLISECONDS);
        return ok[0];
    }

    /** "down" shows what's below (content moves up), like a finger swiping up. */
    private boolean scroll(String direction, int id) throws InterruptedException {
        if (!java.util.Arrays.asList("up", "down", "left", "right").contains(direction)) throw new IllegalArgumentException("invalid scroll direction");
        if (id >= 0) {
            AccessibilityNodeInfo n = element(id);
            while (n != null && !n.isScrollable()) n = n.getParent();
            if (n != null) {
                boolean forward = direction.equals("down") || direction.equals("right");
                if (n.performAction(forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)) return true;
            }
        }
        DisplayMetrics m = getResources().getDisplayMetrics();
        int w = m.widthPixels, h = m.heightPixels;
        switch (direction) {
            case "up": return swipe(w / 2, h * 30 / 100, w / 2, h * 72 / 100, 380);
            case "left": return swipe(w * 25 / 100, h / 2, w * 80 / 100, h / 2, 300);
            case "right": return swipe(w * 80 / 100, h / 2, w * 25 / 100, h / 2, 300);
            default: return swipe(w / 2, h * 72 / 100, w / 2, h * 30 / 100, 380);
        }
    }

    private boolean type(String text, int id, boolean append) {
        AccessibilityNodeInfo target = id >= 0 ? element(id) : null;
        if (target == null) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            target = root != null ? root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) : null;
        }
        if (target == null) {
            synchronized (this) {
                for (AccessibilityNodeInfo n : lastElements) if (n.isEditable()) { target = n; break; }
            }
        }
        if (target == null) throw new IllegalArgumentException("no text field: tap one first or pass its id");
        if (!target.isFocused()) target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        String value = append && target.getText() != null ? target.getText() + text : text;
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
        return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
    }

    private boolean key(String key) {
        switch (key) {
            case "back": return performGlobalAction(GLOBAL_ACTION_BACK);
            case "home": return performGlobalAction(GLOBAL_ACTION_HOME);
            case "recents": return performGlobalAction(GLOBAL_ACTION_RECENTS);
            case "notifications": return performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS);
            case "quick_settings": return performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS);
            case "power": return performGlobalAction(GLOBAL_ACTION_POWER_DIALOG);
            case "lock":
                if (Build.VERSION.SDK_INT < 28) throw new IllegalArgumentException("lock needs Android 9+");
                return performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN);
            default:
                throw new IllegalArgumentException("unknown key " + key + " (back, home, recents, notifications, quick_settings, power, lock)");
        }
    }

    private boolean open(String pkg) {
        Intent intent = getPackageManager().getLaunchIntentForPackage(pkg);
        if (intent == null) throw new IllegalArgumentException("no launchable app " + pkg);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        main.post(() -> startActivity(intent));
        return true;
    }

    // ------------------------------------------------------------- the pill

    /** "● Agent is using the phone · Stop": visible while an agent acts, and while paused. */
    private void createPill() {
        main.post(() -> {
            pill = new TextView(this);
            pill.setTextColor(Color.parseColor("#eef1f4"));
            pill.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            pill.setPadding(dp(14), dp(7), dp(14), dp(7));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(Color.parseColor("#F0202329"));
            bg.setCornerRadius(dp(99));
            bg.setStroke(dp(1), Color.parseColor("#807cc4b0"));
            pill.setBackground(bg);
            pill.setOnClickListener(v -> setPaused(!paused));
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            lp.y = dp(36);
            pill.setVisibility(View.GONE);
            ((WindowManager) getSystemService(WINDOW_SERVICE)).addView(pill, lp);
        });
    }

    private void acting() {
        lastActionAt = System.currentTimeMillis();
        main.post(() -> {
            showPill(paused ? "⏸  Phone-use paused  ·  Resume" : "●  Agent is using the phone  ·  Stop");
            main.postDelayed(this::hidePillIfIdle, PILL_LINGER_MS + 100);
        });
    }

    void setPaused(boolean value) {
        paused = value;
        Prefs.setPaused(this, value);
        if (value) stopService(new Intent(this, CaptureService.class));
        main.post(() -> showPill(paused ? "⏸  Phone-use paused  ·  Resume" : "●  Agent is using the phone  ·  Stop"));
        if (!value) main.postDelayed(this::hidePillIfIdle, PILL_LINGER_MS + 100);
    }

    private void showPill(String text) {
        if (pill == null) return;
        pill.setText(text);
        pill.setVisibility(View.VISIBLE);
    }

    private void hidePillIfIdle() {
        if (pill != null && !paused && System.currentTimeMillis() - lastActionAt >= PILL_LINGER_MS) pill.setVisibility(View.GONE);
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }
}
