package de.forensikvision.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Bildschirmaufnahme als Bildquelle fuer die Objekterkennung.
 *
 * Android WebView kennt getDisplayMedia nicht - im Browser laeuft die
 * Bildschirmfreigabe darueber, auf Android muss es nativ sein. Dieses Plugin
 * schliesst genau diese Luecke und liefert Einzelbilder als JPEG.
 *
 * Ablauf:
 *   1. start()      - Systemdialog zur Zustimmung, dann Vordergrunddienst
 *                     und VirtualDisplay
 *   2. grabFrame()  - jeweils das neueste Bild als base64-JPEG
 *   3. stop()       - alles freigeben
 *
 * Die Aufnahme ist ohne ausdrueckliche Zustimmung im Systemdialog nicht
 * moeglich, und waehrend sie laeuft, zeigt eine dauerhafte Benachrichtigung
 * das an. Beides ist so gewollt.
 */
@CapacitorPlugin(name = "ScreenCapture")
public class ScreenCapturePlugin extends Plugin {

    private MediaProjectionManager manager;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;

    private int breite, hoehe, dichte;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private final MediaProjection.Callback callback = new MediaProjection.Callback() {
        @Override
        public void onStop() {
            // Wird ausgeloest, wenn die Aufnahme ueber die Systemleiste beendet wird.
            handler.post(() -> {
                freigeben();
                notifyListeners("screenCaptureStopped", new JSObject());
            });
        }
    };

    @Override
    public void load() {
        manager = (MediaProjectionManager) getContext()
                .getSystemService(Activity.MEDIA_PROJECTION_SERVICE);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", manager != null);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (manager == null) { call.reject("Bildschirmaufnahme wird von diesem Gerät nicht angeboten."); return; }
        if (projection != null) { call.reject("Die Aufnahme läuft bereits."); return; }

        // Zielbreite begrenzen: die Erkennung arbeitet ohnehin auf 320 bzw. 640
        // Pixeln. Eine volle Bildschirmauflösung je Bild zu übertragen wäre
        // reine Verschwendung und würde die Bildrate halbieren.
        int ziel = call.getInt("maxWidth", 720);

        try {
            int pw, ph;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                // getDefaultDisplay() ist veraltet und liefert auf manchen Geraeten
                // null - ein NPE hier riss die ganze App mit.
                android.view.WindowMetrics wm =
                        getActivity().getWindowManager().getCurrentWindowMetrics();
                android.graphics.Rect b = wm.getBounds();
                pw = b.width(); ph = b.height();
                dichte = getContext().getResources().getDisplayMetrics().densityDpi;
            } else {
                DisplayMetrics m = new DisplayMetrics();
                getActivity().getWindowManager().getDefaultDisplay().getRealMetrics(m);
                pw = m.widthPixels; ph = m.heightPixels; dichte = m.densityDpi;
            }
            if (pw <= 0 || ph <= 0) { call.reject("Bildschirmmaße konnten nicht ermittelt werden."); return; }
            if (dichte <= 0) dichte = 320;

            float f = Math.min(1f, (float) ziel / Math.max(1, pw));
            breite = Math.max(2, Math.round(pw * f) & ~1);
            hoehe = Math.max(2, Math.round(ph * f) & ~1);

            startActivityForResult(call, manager.createScreenCaptureIntent(), "zustimmungErhalten");
        } catch (Throwable t) {
            // Nichts darf von hier nach oben durchschlagen: eine nicht gefangene
            // Ausnahme in einem Plugin beendet die App.
            call.reject("Bildschirmaufnahme konnte nicht vorbereitet werden: " + t.getMessage());
        }
    }

    @ActivityCallback
    private void zustimmungErhalten(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Die Bildschirmaufnahme wurde abgelehnt.");
            return;
        }
        try {
            // Reihenfolge ist zwingend: ab Android 14 muss der Vordergrunddienst
            // laufen, BEVOR getMediaProjection aufgerufen wird.
            ScreenCaptureService.starten(getContext());
        } catch (Throwable t) {
            call.reject("Der Vordergrunddienst ließ sich nicht starten: " + t.getMessage());
            return;
        }
        // Dem Dienst Zeit geben, startForeground() zu erreichen - aber OHNE den
        // Hauptthread schlafen zu legen. Ein Thread.sleep hier blockierte die
        // Oberflaeche und konnte eine Reaktionszeit-Warnung ausloesen.
        handler.postDelayed(() -> weiterNachDienst(call, result), 350);
    }

    private void weiterNachDienst(PluginCall call, ActivityResult result) {
        try {
            projection = manager.getMediaProjection(result.getResultCode(), result.getData());
            if (projection == null) { freigeben(); call.reject("Aufnahme konnte nicht gestartet werden."); return; }

            // Ebenfalls zwingend ab Android 14: Rueckruf vor dem VirtualDisplay.
            projection.registerCallback(callback, handler);

            reader = ImageReader.newInstance(breite, hoehe, PixelFormat.RGBA_8888, 2);
            display = projection.createVirtualDisplay(
                    "ForensikVisionCapture", breite, hoehe, dichte,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(), null, handler);
            if (display == null) { freigeben(); call.reject("Virtuelle Anzeige konnte nicht angelegt werden."); return; }

            JSObject r = new JSObject();
            r.put("width", breite);
            r.put("height", hoehe);
            call.resolve(r);
        } catch (Throwable t) {
            freigeben();
            String m = String.valueOf(t.getMessage());
            call.reject("Aufnahme fehlgeschlagen: " + t.getClass().getSimpleName() + " - " + m);
        }
    }

    @PluginMethod
    public void grabFrame(PluginCall call) {
        if (reader == null) { call.reject("Es läuft keine Aufnahme."); return; }
        Image bild = null;
        try {
            bild = reader.acquireLatestImage();
            if (bild == null) {
                // Noch kein neues Bild - das ist normal, kein Fehler.
                JSObject leer = new JSObject();
                leer.put("frame", (String) null);
                call.resolve(leer);
                return;
            }
            Image.Plane ebene = bild.getPlanes()[0];
            ByteBuffer puffer = ebene.getBuffer();
            int pixelStride = ebene.getPixelStride();
            int rowStride = ebene.getRowStride();
            // Zeilen koennen breiter sein als das Bild - dieser Rand muss weg,
            // sonst ist das Ergebnis schraeg verzerrt.
            int rand = rowStride - pixelStride * breite;

            Bitmap voll = Bitmap.createBitmap(
                    breite + rand / pixelStride, hoehe, Bitmap.Config.ARGB_8888);
            voll.copyPixelsFromBuffer(puffer);
            Bitmap bm = (rand == 0) ? voll : Bitmap.createBitmap(voll, 0, 0, breite, hoehe);

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.JPEG, call.getInt("quality", 72), out);
            if (bm != voll) bm.recycle();
            voll.recycle();

            JSObject r = new JSObject();
            r.put("frame", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            r.put("width", breite);
            r.put("height", hoehe);
            call.resolve(r);
        } catch (Throwable t) {
            call.reject("Bild konnte nicht gelesen werden: " + t.getMessage());
        } finally {
            if (bild != null) bild.close();
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        freigeben();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        freigeben();
        super.handleOnDestroy();
    }

    /** Alles freigeben. Mehrfach aufrufbar, ohne dass etwas passiert. */
    private void freigeben() {
        try { if (display != null) display.release(); } catch (Exception ignored) {}
        try { if (reader != null) reader.close(); } catch (Exception ignored) {}
        try {
            if (projection != null) { projection.unregisterCallback(callback); projection.stop(); }
        } catch (Exception ignored) {}
        display = null; reader = null; projection = null;
        try { ScreenCaptureService.beenden(getContext()); } catch (Exception ignored) {}
    }
}
