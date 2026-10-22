package dev.phoneuse;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Screenshots. Android only lets an app capture the screen through MediaProjection, held by
 * a foreground service. One virtual display belongs to each consent session; its surface
 * is attached only while taking a frame. Nothing is written to disk.
 */
public class CaptureService extends Service {
    private static final String TAG = "phone-use.capture";
    private static final String CHANNEL = "phone_use_capture";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_DATA = "data";

    private static volatile MediaProjection projection;
    static volatile boolean requesting;
    private static VirtualDisplay display;
    private static HandlerThread thread;
    private static Handler handler;

    static boolean ready() {
        return projection != null;
    }

    /** One frame of the current screen as a JPEG, scaled by `scale` (0.25–1). */
    static synchronized Shot capture(Context context, float scale, int quality) throws Exception {
        MediaProjection p = projection;
        if (p == null) throw new IllegalStateException("screen capture isn't ready");
        DisplayMetrics metrics = new DisplayMetrics();
        ((WindowManager) context.getSystemService(Context.WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(metrics);
        int width = metrics.widthPixels, height = metrics.heightPixels;
        ImageReader reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        AtomicReference<Bitmap> frame = new AtomicReference<>();
        Object frameLock = new Object();
        boolean[] accepting = {true};
        CountDownLatch got = new CountDownLatch(1);
        reader.setOnImageAvailableListener(r -> {
            if (frame.get() != null) return;
            try (Image image = r.acquireLatestImage()) {
                if (image == null) return;
                Image.Plane plane = image.getPlanes()[0];
                ByteBuffer buffer = plane.getBuffer();
                int rowPadding = plane.getRowStride() - plane.getPixelStride() * width;
                Bitmap padded = Bitmap.createBitmap(width + rowPadding / plane.getPixelStride(), height, Bitmap.Config.ARGB_8888);
                padded.copyPixelsFromBuffer(buffer);
                Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, width, height);
                if (cropped != padded) padded.recycle();
                synchronized (frameLock) {
                    if (accepting[0] && frame.get() == null) frame.set(cropped);
                    else cropped.recycle();
                }
                got.countDown();
            } catch (Exception e) {
                Log.w(TAG, "frame failed", e);
            }
        }, handler);
        try {
            if (display == null) {
                display = p.createVirtualDisplay("phone-use-screenshot", width, height, metrics.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
            } else {
                display.resize(width, height, metrics.densityDpi);
                display.setSurface(reader.getSurface());
            }
            if (!got.await(4, TimeUnit.SECONDS)) throw new IllegalStateException("no frame from the screen within 4 s");
        } catch (Exception e) {
            synchronized (frameLock) {
                accepting[0] = false;
                Bitmap failed = frame.getAndSet(null);
                if (failed != null) failed.recycle();
            }
            throw e;
        } finally {
            synchronized (frameLock) { accepting[0] = false; }
            if (display != null) display.setSurface(null);
            reader.setOnImageAvailableListener(null, null);
            reader.close();
        }
        Bitmap full = frame.get();
        if (full == null) throw new IllegalStateException("screen capture ended before a frame arrived");
        float s = Math.max(0.25f, Math.min(scale, 1f));
        Bitmap out = s < 1f ? Bitmap.createScaledBitmap(full, Math.round(width * s), Math.round(height * s), true) : full;
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
        out.compress(Bitmap.CompressFormat.JPEG, Math.max(30, Math.min(quality, 95)), jpeg);
        Shot shot = new Shot(out.getWidth(), out.getHeight(), width, height, Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP));
        if (out != full) out.recycle();
        full.recycle();
        return shot;
    }

    static final class Shot {
        final int width, height, screenWidth, screenHeight;
        final String jpegBase64;

        Shot(int width, int height, int screenWidth, int screenHeight, String jpegBase64) {
            this.width = width;
            this.height = height;
            this.screenWidth = screenWidth;
            this.screenHeight = screenHeight;
            this.jpegBase64 = jpegBase64;
        }
    }

    // ------------------------------------------------------------- service

    @Override
    @SuppressWarnings("deprecation")
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Agent screenshots", NotificationManager.IMPORTANCE_MIN));
            builder = new Notification.Builder(this, CHANNEL);
        } else {
            builder = new Notification.Builder(this).setPriority(Notification.PRIORITY_MIN);
        }
        Notification notification = builder.setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Phone-Use")
            .setContentText("Your agent can take screenshots (only when it asks)")
            .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(7333, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(7333, notification);

        if (thread == null) {
            thread = new HandlerThread("phone-use-capture");
            thread.start();
            handler = new Handler(thread.getLooper());
        }
        int code = intent != null ? intent.getIntExtra(EXTRA_CODE, Activity.RESULT_CANCELED) : Activity.RESULT_CANCELED;
        Intent data = intent != null ? intent.getParcelableExtra(EXTRA_DATA) : null;
        if (code == Activity.RESULT_OK && data != null && projection == null) {
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            projection = manager.getMediaProjection(code, data);
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    projection = null;
                    stopSelf();
                }
            }, handler);
            Log.i(TAG, "screen capture ready");
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override public void onDestroy() {
        synchronized (CaptureService.class) {
            MediaProjection current = projection;
            projection = null;
            if (display != null) { display.release(); display = null; }
            if (current != null) current.stop();
            if (thread != null) { thread.quitSafely(); thread = null; handler = null; }
        }
        super.onDestroy();
    }
}
