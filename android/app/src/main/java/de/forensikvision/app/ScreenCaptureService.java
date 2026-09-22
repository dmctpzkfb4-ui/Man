package de.forensikvision.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Vordergrunddienst fuer die Bildschirmaufnahme.
 *
 * Ab Android 14 verweigert das System MediaProjection, wenn nicht VORHER ein
 * Vordergrunddienst mit dem Typ mediaProjection laeuft. Der Dienst tut selbst
 * nichts - er existiert, damit die Aufnahme ueberhaupt starten darf und damit
 * fuer die nutzende Person dauerhaft sichtbar bleibt, dass aufgenommen wird.
 * Diese Sichtbarkeit ist Absicht und wird nicht umgangen.
 */
public class ScreenCaptureService extends Service {

    private static final String CHANNEL_ID = "bildschirmaufnahme";
    private static final int NOTIFICATION_ID = 4711;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null
                && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Bildschirmanalyse", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Zeigt an, dass der Bildschirminhalt gerade analysiert wird.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Bildschirmanalyse läuft")
                .setContentText("Die Objekterkennung wertet den Bildschirminhalt aus. Alles bleibt auf dem Gerät.")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        // startForeground kann werfen - etwa wenn die App gerade nicht im
        // Vordergrund ist oder die Benachrichtigungs-Berechtigung fehlt. Eine
        // ungefangene Ausnahme im Dienst beendet den gesamten Prozess.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable t) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    public static void starten(Context c) {
        Intent i = new Intent(c, ScreenCaptureService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i);
        else c.startService(i);
    }

    public static void beenden(Context c) {
        c.stopService(new Intent(c, ScreenCaptureService.class));
    }
}
