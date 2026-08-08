package com.domicilioswil.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.util.Log;
import org.maplibre.android.maps.MapView;
import org.maplibre.android.camera.CameraPosition;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class PollForegroundService extends Service {

    private static final String TAG           = "WIL_SVC";
    private static final String SHEET_ID      = "1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU";
    private static final String CH_SVC        = "wil_servicio";
    private static final String CH_PEND       = "wil_pedidos";
    private static final String CH_ASIG       = "wil_asignado";
    private static final int    NOTIF_SVC_ID  = 9001;
    private static final int    NOTIF_PEND_ID = 1001;
    private static final int    NOTIF_ASIG_ID = 2001;
    private static final long   POLL_MS       = 45_000L;

    // Throttle voz pendientes — 5 minutos
    private static final long   TTS_PENDIENTES_INTERVALO_MS = 5 * 60 * 1000L;
    private long ultimaTtsPendientes = 0L;

    private final Handler  handler  = new Handler(Looper.getMainLooper());
    private       Runnable pollTask;

    private final Set<String> idsPendNotif = new HashSet<>();
    private final Set<String> idsAsigNotif = new HashSet<>();
    private       int         ultimoPendientes = -1;

    // ── TTS ──
    private TextToSpeech tts;
    private boolean      ttsListo = false;

    /* ─── Ciclo de vida ─── */

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "Servicio creado");
        crearCanales();
        iniciarTTS();
        startForeground(NOTIF_SVC_ID, notifServicio("Iniciando…"));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "onStartCommand — arrancando poll cada " + (POLL_MS / 1000) + "s");
        startForeground(NOTIF_SVC_ID, notifServicio("En servicio"));
        arrancarPoll();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        liberarTTS();
        Log.d(TAG, "Servicio destruido");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    /* ─── TTS ─── */

    private void iniciarTTS() {
        tts = new TextToSpeech(getApplicationContext(), status -> {
            if (status == TextToSpeech.SUCCESS) {
                int result = tts.setLanguage(new Locale("es", "CO"));
                ttsListo = result != TextToSpeech.LANG_MISSING_DATA
                        && result != TextToSpeech.LANG_NOT_SUPPORTED;
                if (!ttsListo) {
                    // fallback español genérico
                    result = tts.setLanguage(new Locale("es", "ES"));
                    ttsListo = result != TextToSpeech.LANG_MISSING_DATA
                            && result != TextToSpeech.LANG_NOT_SUPPORTED;
                }
                Log.d(TAG, "TTS listo=" + ttsListo);
            } else {
                Log.w(TAG, "TTS init falló, status=" + status);
            }
        });
    }

    private void liberarTTS() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
            ttsListo = false;
        }
    }

    private void hablar(String texto) {
        if (!ttsListo || tts == null) return;
        tts.speak(texto, TextToSpeech.QUEUE_ADD, null, String.valueOf(texto.hashCode()));
    }

    /* ─── Polling ─── */

    private void arrancarPoll() {
        handler.removeCallbacksAndMessages(null);
        pollTask = new Runnable() {
            @Override
            public void run() {
                ejecutarPoll();
                handler.postDelayed(this, POLL_MS);
            }
        };
        handler.post(pollTask);
    }

    private void ejecutarPoll() {
        new Thread(() -> {
            SharedPreferences prefs = getSharedPreferences("wil_prefs", MODE_PRIVATE);
            String nombre = prefs.getString("domi_nombre", "");
            String id     = prefs.getString("domi_id",     "");

            if (nombre.isEmpty() && id.isEmpty()) {
                Log.w(TAG, "Sin sesión — deteniendo servicio");
                stopSelf();
                return;
            }

            try {
                String csv = descargarCSV();
                if (csv == null || csv.length() < 50) {
                    Log.w(TAG, "CSV vacío");
                    return;
                }

                /* ── Pendientes sin asignar ── */
                int pendientes = contarPendientes(csv);
                if (pendientes > 0 && pendientes != ultimoPendientes) {
                    ultimoPendientes = pendientes;
                    mostrarNotifPendientes(pendientes);

                    // Voz pendientes — respeta throttle de 5 min
                    long ahora = System.currentTimeMillis();
                    if (ahora - ultimaTtsPendientes >= TTS_PENDIENTES_INTERVALO_MS) {
                        ultimaTtsPendientes = ahora;
                        if (pendientes == 1) {
                            hablar("Hay un pedido pendiente sin atender");
                        } else {
                            hablar("Hay " + pendientes + " pedidos pendientes sin atender");
                        }
                    }

                } else if (pendientes == 0) {
                    ultimoPendientes = 0;
                    NotificationManagerCompat.from(this).cancel(NOTIF_PEND_ID);
                }

                /* ── Asignados a este domi ── */
                Set<String> asignados = buscarAsignados(csv, nombre, id);
                for (String pedId : asignados) {
                    if (!idsAsigNotif.contains(pedId)) {
                        idsAsigNotif.add(pedId);
                        Log.d(TAG, "¡ASIGNADO NUEVO! id=" + pedId);
                        mostrarNotifAsignado(pedId);
                        actualizarNotifServicio("Pedido #" + pedId + " asignado a ti 🎯");
                        // Voz asignado — siempre de inmediato
                        hablar("Te asignaron el pedido número " + pedId);
                    }
                }

                /* ── Tomados por este domi ── */
                Set<String> tomados = buscarTomadosPorMi(csv, nombre, id);
                for (String pedId : tomados) {
                    if (!idsPendNotif.contains(pedId)) {
                        idsPendNotif.add(pedId);
                        mostrarNotifTomado(pedId);
                        // Sin voz extra aquí — ya habló en asignado
                    }
                }

                Log.d(TAG, "Poll OK — pendientes=" + pendientes
                        + " | asignadosMíos=" + asignados.size());

                // ✅ Rastreo pedido cliente
                PollClienteService.ejecutar(getApplicationContext());

            } catch (Exception e) {
                Log.e(TAG, "Error en poll: " + e.getMessage());
            }
        }).start();
    }

    private Set<String> buscarTomadosPorMi(String csv, String nombre, String id) {
        Set<String> resultado = new HashSet<>();
        Set<String> vistos    = new HashSet<>();
        String nombreBase = normStr(nombre).split(" ")[0];
        String idUpper    = id.toUpperCase().trim();

        for (String linea : csv.split("\n")) {
            String[] cols = parseCsvLine(linea.trim());
            if (cols.length < 16) continue;
            String pedId = cols[0].trim().replaceAll("[\"' ]", "");
            if (!pedId.matches("\\d{2,5}") || vistos.contains(pedId)) continue;
            vistos.add(pedId);

            String estado   = normStr(cols[4]);
            String asignado = cols[15].replaceAll("[\"']", "").trim();
            String asigNorm = normStr(asignado);

            if (!estado.contains("proceso")) continue;

            boolean esMio = (!nombreBase.isEmpty() && asigNorm.contains(nombreBase))
                    || (!idUpper.isEmpty() && asignado.toUpperCase().contains(idUpper));
            if (esMio) resultado.add(pedId);
        }
        return resultado;
    }

    private void mostrarNotifTomado(String pedidoId) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("abrir_tab", "ruta");
        intent.putExtra("pedido_id", pedidoId);
        PendingIntent pi = PendingIntent.getActivity(this, pedidoId.hashCode() + 500, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            NotificationManagerCompat.from(this).notify(pedidoId.hashCode(),
                    new NotificationCompat.Builder(this, CH_ASIG)
                            .setSmallIcon(R.mipmap.ic_launcher)
                            .setContentTitle("✅ Pedido #" + pedidoId + " tomado")
                            .setContentText("Tienes el pedido #" + pedidoId + " — ve a la ruta")
                            .setStyle(new NotificationCompat.BigTextStyle()
                                    .bigText("Pedido #" + pedidoId + "\nLo tomaste correctamente. Toca para abrir la ruta."))
                            .setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .setContentIntent(pi)
                            .setColor(Color.parseColor("#006970"))
                            .setVibrate(new long[]{0, 200, 100, 200})
                            .build());
        } catch (SecurityException e) {
            Log.w(TAG, "Sin permiso notif tomado: " + e.getMessage());
        }
    }

    /* ─── Descarga CSV ─── */

    private String descargarCSV() {
        try {
            String urlStr = "https://docs.google.com/spreadsheets/d/" + SHEET_ID
                    + "/gviz/tq?tqx=out:csv&sheet=Pedidos&cachebust=" + System.currentTimeMillis();
            HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setRequestProperty("Cache-Control", "no-cache, no-store");
            conn.setRequestProperty("Pragma", "no-cache");
            if (conn.getResponseCode() != 200) return null;
            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append("\n");
            br.close();
            return sb.toString();
        } catch (Exception e) {
            Log.e(TAG, "Error CSV: " + e.getMessage());
            return null;
        }
    }

    /* ─── Lógica de negocio ─── */

    private int contarPendientes(String csv) {
        int count = 0;
        Set<String> vistos = new HashSet<>();
        for (String linea : csv.split("\n")) {
            String[] cols = parseCsvLine(linea.trim());
            if (cols.length < 16) continue;
            String pedId = cols[0].trim().replaceAll("[\"' ]", "");
            if (!pedId.matches("\\d{2,5}") || vistos.contains(pedId)) continue;
            vistos.add(pedId);
            String estado   = normStr(cols[4]);
            String asignado = cols[15].replaceAll("[\"']", "").trim();
            if ((estado.contains("pendiente") || estado.isEmpty()) && asignado.isEmpty()) count++;
        }
        return count;
    }

    private Set<String> buscarAsignados(String csv, String nombre, String id) {
        Set<String> resultado = new HashSet<>();
        Set<String> vistos    = new HashSet<>();
        String nombreBase = normStr(nombre).split(" ")[0];
        String idUpper    = id.toUpperCase().trim();
        for (String linea : csv.split("\n")) {
            String[] cols = parseCsvLine(linea.trim());
            if (cols.length < 16) continue;
            String pedId = cols[0].trim().replaceAll("[\"' ]", "");
            if (!pedId.matches("\\d{2,5}") || vistos.contains(pedId)) continue;
            vistos.add(pedId);
            String estado   = normStr(cols[4]);
            String asignado = cols[15].replaceAll("[\"']", "").trim();
            String asigNorm = normStr(asignado);
            boolean estOk = estado.contains("asignad") || estado.contains("camino");
            if (!estOk) continue;
            boolean esMio = (!nombreBase.isEmpty() && asigNorm.contains(nombreBase))
                    || (!idUpper.isEmpty() && asignado.toUpperCase().contains(idUpper));
            if (esMio) resultado.add(pedId);
        }
        return resultado;
    }

    /* ─── Notificaciones ─── */

    private Notification notifServicio(String texto) {
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CH_SVC)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("🛵 WIL Domicilios")
                .setContentText(texto)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pi)
                .setColor(Color.parseColor("#006970"))
                .build();
    }

    private void actualizarNotifServicio(String texto) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_SVC_ID, notifServicio(texto));
    }

    private void mostrarNotifPendientes(int cantidad) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("abrir_tab", "pedidos");
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String titulo = cantidad == 1 ? "🛵 ¡Nuevo pedido disponible!"
                : "🛵 " + cantidad + " pedidos esperando";
        String cuerpo = cantidad == 1 ? "1 pedido pendiente — toca para verlo"
                : cantidad + " pedidos pendientes sin tomar";
        try {
            NotificationManagerCompat.from(this).notify(NOTIF_PEND_ID,
                    new NotificationCompat.Builder(this, CH_PEND)
                            .setSmallIcon(R.mipmap.ic_launcher)
                            .setContentTitle(titulo)
                            .setContentText(cuerpo)
                            .setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .setContentIntent(pi)
                            .setColor(Color.parseColor("#006970"))
                            .setVibrate(new long[]{0, 300, 100, 300, 100, 500})
                            .setNumber(cantidad)
                            .build());
        } catch (SecurityException e) {
            Log.w(TAG, "Sin permiso notif: " + e.getMessage());
        }
    }

    private void mostrarNotifAsignado(String pedidoId) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("abrir_tab", "ruta");
        intent.putExtra("pedido_id", pedidoId);
        PendingIntent pi = PendingIntent.getActivity(this, pedidoId.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            NotificationManagerCompat.from(this).notify(NOTIF_ASIG_ID,
                    new NotificationCompat.Builder(this, CH_ASIG)
                            .setSmallIcon(R.mipmap.ic_launcher)
                            .setContentTitle("🎯 ¡Te asignaron un pedido!")
                            .setContentText("Pedido #" + pedidoId + " — Toca para ver los detalles")
                            .setStyle(new NotificationCompat.BigTextStyle()
                                    .bigText("Pedido #" + pedidoId + "\nToca para abrir la ruta en WIL Domicilios"))
                            .setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_MAX)
                            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                            .setContentIntent(pi)
                            .setColor(Color.parseColor("#7c3aed"))
                            .setVibrate(new long[]{0,500,150,500,150,500,300,300,100,300,100,300,200,600})
                            .build());
        } catch (SecurityException e) {
            Log.w(TAG, "Sin permiso notif asig: " + e.getMessage());
        }
    }

    /* ─── Canales ─── */

    private void crearCanales() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel chSvc = new NotificationChannel(
                CH_SVC, "WIL en servicio", NotificationManager.IMPORTANCE_LOW);
        chSvc.setDescription("Indicador de servicio activo");
        chSvc.setShowBadge(false);
        chSvc.enableVibration(false);
        chSvc.enableLights(false);
        nm.createNotificationChannel(chSvc);

        NotificationChannel chPend = new NotificationChannel(
                CH_PEND, "Pedidos WIL", NotificationManager.IMPORTANCE_HIGH);
        chPend.setDescription("Nuevos pedidos sin tomar");
        chPend.enableVibration(true);
        chPend.setVibrationPattern(new long[]{0, 300, 100, 300, 100, 500});
        chPend.setLightColor(Color.parseColor("#006970"));
        chPend.enableLights(true);
        chPend.setShowBadge(true);
        nm.createNotificationChannel(chPend);

        NotificationChannel chAsig = new NotificationChannel(
                CH_ASIG, "Pedido asignado WIL", NotificationManager.IMPORTANCE_HIGH);
        chAsig.setDescription("Te asignaron un pedido directamente");
        chAsig.enableVibration(true);
        chAsig.setVibrationPattern(new long[]{0,500,150,500,150,500,300,600});
        chAsig.setLightColor(Color.parseColor("#7c3aed"));
        chAsig.enableLights(true);
        chAsig.setShowBadge(true);
        nm.createNotificationChannel(chAsig);

        NotificationChannel chCliente = new NotificationChannel(
                "wil_cliente", "Estado de mi pedido", NotificationManager.IMPORTANCE_HIGH);
        chCliente.setDescription("Actualizaciones del pedido del cliente");
        chCliente.enableVibration(true);
        chCliente.setLightColor(Color.parseColor("#003f87"));
        chCliente.enableLights(true);
        chCliente.setShowBadge(true);
        nm.createNotificationChannel(chCliente);
    }

    /* ─── Helpers ─── */

    private String normStr(String s) {
        if (s == null) return "";
        return s.toLowerCase()
                .replaceAll("[\"']", "")
                .replaceAll("[áàä]", "a").replaceAll("[éèë]", "e")
                .replaceAll("[íìï]", "i").replaceAll("[óòö]", "o")
                .replaceAll("[úùü]", "u").replaceAll("[ñ]",   "n")
                .trim();
    }

    private String[] parseCsvLine(String line) {
        List<String> cols = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inQ = false;
        for (char ch : line.toCharArray()) {
            if      (ch == '"')         inQ = !inQ;
            else if (ch == ',' && !inQ) { cols.add(cur.toString()); cur = new StringBuilder(); }
            else                        cur.append(ch);
        }
        cols.add(cur.toString());
        return cols.toArray(new String[0]);
    }
}