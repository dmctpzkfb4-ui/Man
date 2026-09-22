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
 * Vordergrunddienst waehrend einer laufenden Aufnahme.
 *
 * Ohne ihn beendet Android den Vorgang, sobald die App aus dem Blick geraet -
 * und die Aufnahme bricht mitten im Schreiben ab. Ab Android 11 ist ein
 * Dienst vom Typ "camera" ausserdem Voraussetzung dafuer, die Kamera im
 * Hintergrund ueberhaupt weiter nutzen zu duerfen.
 *
 * Die Benachrichtigung bleibt waehrend der gesamten Aufnahme sichtbar. Das
 * ist kein Beiwerk, sondern gewollt: eine Anwendung, die im Hintergrund
 * Kamera oder Bildschirm mitschneidet, muss das erkennbar machen.
 */
public class AufnahmeService extends Service {

    private static final String CHANNEL_ID = "aufnahme";
    private static final int NOTIFICATION_ID = 4712;
    public static final String EXTRA_TYP = "typ";   // "kamera" oder "bildschirm"

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null
                && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Aufnahme", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Zeigt an, dass gerade eine Aufnahme läuft.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String typ = intent != null ? intent.getStringExtra(EXTRA_TYP) : "kamera";
        boolean schirm = "bildschirm".equals(typ);

        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Aufnahme läuft")
                .setContentText(schirm
                        ? "Der Bildschirminhalt wird mitgeschnitten. Alles bleibt auf dem Gerät."
                        : "Die Kamera wird mitgeschnitten. Alles bleibt auf dem Gerät.")
                .setSmallIcon(android.R.drawable.presence_video_online)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int art = schirm
                        ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                        : ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                startForeground(NOTIFICATION_ID, n, art);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable t) {
            // Nicht gefangen wuerde das den ganzen Vorgang beenden.
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    public static void starten(Context c, String typ) {
        Intent i = new Intent(c, AufnahmeService.class);
        i.putExtra(EXTRA_TYP, typ);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) c.startForegroundService(i);
        else c.startService(i);
    }

    public static void beenden(Context c) {
        c.stopService(new Intent(c, AufnahmeService.class));
    }
}
