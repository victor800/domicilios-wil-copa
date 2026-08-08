package com.domicilioswil.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class PollPedidosWorker extends Worker {

    private static final String TAG             = "WIL_POLL";
    private static final String SHEET_ID        = "1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU";
    private static final String CHANNEL_PEND    = "wil_pedidos";
    private static final String CHANNEL_ASIG    = "wil_asignado";
    private static final int    NOTIF_ID_PEND   = 1001;
    private static final int    NOTIF_ID_ASIG   = 2001;

    public PollPedidosWorker(@NonNull Context ctx, @NonNull WorkerParameters p) {
        super(ctx, p);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx   = getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences("wil_prefs", Context.MODE_PRIVATE);

        String domiNombre = prefs.getString("domi_nombre", "");
        String domiId     = prefs.getString("domi_id",     "");

        Log.d(TAG, "doWork — nombre=" + domiNombre + " | id=" + domiId);

        /* Sin sesión → no hacer nada */
        if (domiNombre.isEmpty() && domiId.isEmpty()) {
            Log.w(TAG, "Sin sesión en prefs, saltando poll");
            return Result.success();
        }

        crearCanales(ctx);

        try {
            String csv = descargarCSV();
            if (csv == null || csv.length() < 50) {
                Log.w(TAG, "CSV vacío o error de red");
                return Result.retry();
            }

            /* ── 1. Pedidos pendientes sin asignar ── */
            // ── DESPUÉS ──
            int pendientes  = contarPendientes(csv);
            int ultimoPend  = prefs.getInt("ultimo_conteo_pend", -1);
            long ahora      = System.currentTimeMillis();
            long ultimoRecordatorio = prefs.getLong("ts_ultimo_recordatorio", 0L);
            final long INTERVALO_RECORDATORIO = 5 * 60 * 1000L; // 5 minutos

            if (pendientes == 0) {
                // Limpiar todo
                NotificationManagerCompat.from(ctx).cancel(NOTIF_ID_PEND);
                prefs.edit()
                        .putInt("ultimo_conteo_pend", 0)
                        .putLong("ts_ultimo_recordatorio", 0L)
                        .apply();

            } else if (pendientes > ultimoPend) {
                // ── Pedidos NUEVOS → notificar normal y resetear timer recordatorio ──
                mostrarNotifPendientes(ctx, pendientes, false);
                prefs.edit()
                        .putInt("ultimo_conteo_pend", pendientes)
                        .putLong("ts_ultimo_recordatorio", ahora)
                        .apply();

            } else {
                // ── Misma cantidad → recordatorio silencioso cada 5 min ──
                if ((ahora - ultimoRecordatorio) >= INTERVALO_RECORDATORIO) {
                    Log.d(TAG, "Recordatorio: " + pendientes + " pedidos siguen esperando");
                    mostrarNotifPendientes(ctx, pendientes, true); // true = esRecordatorio
                    prefs.edit()
                            .putLong("ts_ultimo_recordatorio", ahora)
                            .apply();
                } else {
                    long faltan = (INTERVALO_RECORDATORIO - (ahora - ultimoRecordatorio)) / 1000;
                    Log.d(TAG, "Sin recordatorio aún — faltan " + faltan + "s");
                }
            }

            /* ── 2. Pedidos asignados a este domi ── */
            Set<String> asignadosPrev = new HashSet<>(
                    prefs.getStringSet("asignados_notif", new HashSet<>()));
            Set<String> asignadosActuales = buscarAsignados(csv, domiNombre, domiId);

            for (String idAsig : asignadosActuales) {
                if (!asignadosPrev.contains(idAsig)) {
                    Log.d(TAG, "¡Pedido asignado nuevo! id=" + idAsig);
                    mostrarNotifAsignado(ctx, idAsig);
                    asignadosPrev.add(idAsig);
                }
            }
            /* ── Pedidos tomados por este domi (en proceso) ── */
            Set<String> tomadosPrev = new HashSet<>(
                    prefs.getStringSet("tomados_notif", new HashSet<>()));
            Set<String> tomadosActuales = buscarTomadosPorMi(csv, domiNombre, domiId);

            for (String idTom : tomadosActuales) {
                if (!tomadosPrev.contains(idTom)) {
                    Log.d(TAG, "¡Pedido tomado por mí! id=" + idTom);
                    mostrarNotifTomado(ctx, idTom);
                    tomadosPrev.add(idTom);
                }
            }
            tomadosPrev.retainAll(tomadosActuales);
            prefs.edit().putStringSet("tomados_notif", tomadosPrev).apply();
            /* Limpiar asignados viejos que ya no están activos */
            asignadosPrev.retainAll(asignadosActuales);
            asignadosPrev.addAll(asignadosActuales);
            prefs.edit().putStringSet("asignados_notif", asignadosPrev).apply();



        } catch (Exception e) {
            Log.e(TAG, "Excepción en doWork: " + e.getMessage());
            return Result.retry();
        }

        return Result.success();
    }

    /* ══════════════════════════════════════
   BUSCAR PEDIDOS TOMADOS POR ESTE DOMI
   (En proceso, En camino, Asignado a él)
══════════════════════════════════════ */
    private Set<String> buscarTomadosPorMi(String csv, String nombre, String id) {
        Set<String> resultado = new HashSet<>();
        Set<String> vistos    = new HashSet<>();

        /* Normalizar para comparar */
        String nombreBase = normStr(nombre);
        if (nombreBase.contains(" "))
            nombreBase = nombreBase.split(" ")[0];
        String idUpper = id.toUpperCase().trim();

        for (String linea : csv.split("\n")) {
            linea = linea.trim();
            if (linea.isEmpty()) continue;

            String[] cols = parseCsvLine(linea);
            if (cols.length < 16) continue;

            String pedId = cols[0].trim().replaceAll("[\"' ]", "");
            if (!pedId.matches("\\d{2,5}")) continue;
            if (vistos.contains(pedId)) continue;
            vistos.add(pedId);

            String estado   = normStr(cols[4]);   // col E = ESTADO
            String asignado = cols[15].replaceAll("[\"']", "").trim(); // col P = NOMBRE_DOMI
            String asigNorm = normStr(asignado);

            /* Estados que indican que el pedido está "tomado" por alguien */
            boolean estadoTomado = estado.contains("en proceso")
                    || estado.contains("en camino")
                    || estado.contains("asignad")
                    || estado.contains("tomado");

            if (!estadoTomado) continue;

            /* ¿Está tomado por mí? */
            boolean esMio = (!nombreBase.isEmpty() && asigNorm.contains(nombreBase))
                    || (!idUpper.isEmpty() && asignado.toUpperCase().contains(idUpper));

            if (esMio) {
                resultado.add(pedId);
                Log.d(TAG, "  Tomado por mí: id=" + pedId + " | estado=" + estado + " | asignado=" + asignado);
            }
        }
        return resultado;
    }

    private void mostrarNotifTomado(Context ctx, String pedidoId) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("abrir_tab", "ruta");
        intent.putExtra("pedido_id", pedidoId);
        PendingIntent pi = PendingIntent.getActivity(ctx,
                pedidoId.hashCode() + 1000, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        try {
            NotificationManagerCompat.from(ctx).notify(
                    NOTIF_ID_ASIG + Integer.parseInt(pedidoId) % 100,
                    new NotificationCompat.Builder(ctx, CHANNEL_ASIG)
                            .setSmallIcon(R.mipmap.ic_launcher)
                            .setContentTitle("📦 Pedido en proceso")
                            .setContentText("Pedido #" + pedidoId + " — Ya lo tomaste, continúa con la ruta")
                            .setStyle(new NotificationCompat.BigTextStyle()
                                    .bigText("Pedido #" + pedidoId + "\nYa está en tu lista. Toca para ver la ruta y entregarlo."))
                            .setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                            .setCategory(NotificationCompat.CATEGORY_REMINDER)
                            .setContentIntent(pi)
                            .setColor(Color.parseColor("#15803d"))
                            .build());
            Log.d(TAG, "✅ Notif recordatorio enviada: pedido #" + pedidoId + " (ya tomado)");
        } catch (SecurityException e) {
            Log.w(TAG, "Sin permiso POST_NOTIFICATIONS: " + e.getMessage());
        }
    }

    /* ══════════════════════════════════════
       DESCARGAR CSV
    ══════════════════════════════════════ */
    private String descargarCSV() {
        try {
            String urlStr = "https://docs.google.com/spreadsheets/d/" + SHEET_ID
                    + "/gviz/tq?tqx=out:csv&sheet=Pedidos&cachebust="
                    + System.currentTimeMillis();

            HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Cache-Control", "no-cache, no-store");
            conn.setRequestProperty("Pragma", "no-cache");

            int code = conn.getResponseCode();
            Log.d(TAG, "HTTP " + code + " — url=" + urlStr.substring(0, 60) + "...");
            if (code != 200) return null;

            BufferedReader br = new BufferedReader(
                    new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append("\n");
            br.close();

            String csv = sb.toString();
            Log.d(TAG, "CSV descargado, chars=" + csv.length());
            return csv;

        } catch (Exception e) {
            Log.e(TAG, "Error descargando CSV: " + e.getMessage());
            return null;
        }
    }

    /* ══════════════════════════════════════
       CONTAR PENDIENTES SIN ASIGNAR
    ══════════════════════════════════════ */
    private int contarPendientes(String csv) {
        int count = 0;
        Set<String> vistos = new HashSet<>();

        for (String linea : csv.split("\n")) {
            linea = linea.trim();
            if (linea.isEmpty()) continue;

            String[] cols = parseCsvLine(linea);
            if (cols.length < 16) continue;

            String pedId = cols[0].trim().replaceAll("[\"' ]", "");
            if (!pedId.matches("\\d{2,5}")) continue;
            if (vistos.contains(pedId)) continue;
            vistos.add(pedId);

            String estado   = normStr(cols[4]);
            String asignado = cols[15].replaceAll("[\"']", "").trim();

            boolean esPendiente = estado.contains("pendiente") || estado.isEmpty();
            boolean sinAsignar  = asignado.isEmpty();

            if (esPendiente && sinAsignar) {
                count++;
                Log.d(TAG, "  Pendiente encontrado: id=" + pedId);
            }
        }
        return count;
    }

    /* ══════════════════════════════════════
       BUSCAR PEDIDOS ASIGNADOS A ESTE DOMI
    ══════════════════════════════════════ */
    private Set<String> buscarAsignados(String csv, String nombre, String id) {
        Set<String> resultado = new HashSet<>();
        Set<String> vistos    = new HashSet<>();

        /* Normalizar para comparar */
        String nombreBase = normStr(nombre);
        if (nombreBase.contains(" "))
            nombreBase = nombreBase.split(" ")[0];
        String idUpper = id.toUpperCase().trim();

        for (String linea : csv.split("\n")) {
            linea = linea.trim();
            if (linea.isEmpty()) continue;

            String[] cols = parseCsvLine(linea);
            if (cols.length < 16) continue;

            String pedId = cols[0].trim().replaceAll("[\"' ]", "");
            if (!pedId.matches("\\d{2,5}")) continue;
            if (vistos.contains(pedId)) continue;
            vistos.add(pedId);

            String estado   = normStr(cols[4]);
            String asignado = cols[15].replaceAll("[\"']", "").trim();
            String asigNorm = normStr(asignado);

            /* Estado asignado / en proceso / en camino */
            boolean estOk = estado.contains("asignad")
                    || estado.contains("camino");
            if (!estOk) continue;

            /* ¿Es para mí? */
            boolean esMio = (!nombreBase.isEmpty() && asigNorm.contains(nombreBase))
                    || (!idUpper.isEmpty() && asignado.toUpperCase().contains(idUpper));

            if (esMio) {
                resultado.add(pedId);
                Log.d(TAG, "  Asignado a mí: id=" + pedId + " | asignado=" + asignado);
            }
        }
        return resultado;
    }

    /* ══════════════════════════════════════
       MOSTRAR NOTIFICACIONES
    ══════════════════════════════════════ */
    private void mostrarNotifPendientes(Context ctx, int cantidad, boolean esRecordatorio) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("abrir_tab", "pedidos");
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String titulo, cuerpo;
        if (esRecordatorio) {
            // Recordatorio: texto diferente, sin vibración fuerte, sin badge nuevo
            titulo = "⏰ Recordatorio WIL";
            cuerpo = cantidad == 1
                    ? "Aún hay 1 pedido pendiente sin tomar"
                    : "Aún hay " + cantidad + " pedidos esperando domiciliario";
        } else {
            titulo = cantidad == 1 ? "🛵 ¡Nuevo pedido disponible!" : "🛵 " + cantidad + " pedidos esperando";
            cuerpo = cantidad == 1 ? "Hay 1 pedido pendiente — toca para verlo"
                    : "Hay " + cantidad + " pedidos pendientes sin tomar";
        }

        NotificationCompat.Builder builder =
                new NotificationCompat.Builder(ctx, CHANNEL_PEND)
                        .setSmallIcon(R.mipmap.ic_launcher)
                        .setContentTitle(titulo)
                        .setContentText(cuerpo)
                        .setAutoCancel(true)
                        .setPriority(esRecordatorio
                                ? NotificationCompat.PRIORITY_DEFAULT   // más silencioso
                                : NotificationCompat.PRIORITY_HIGH)
                        .setContentIntent(pi)
                        .setColor(Color.parseColor("#006970"))
                        .setNumber(cantidad);

        if (!esRecordatorio) {
            // Vibración solo en notif nueva, no en recordatorio
            builder.setVibrate(new long[]{0, 300, 100, 300, 100, 500});
        }

        try {
            // Mismo ID → reemplaza la notif anterior (no apila)
            NotificationManagerCompat.from(ctx).notify(NOTIF_ID_PEND, builder.build());
            Log.d(TAG, (esRecordatorio ? "📢 Recordatorio" : "✅ Notif nueva")
                    + " enviada: " + cantidad + " pedidos");
        } catch (SecurityException e) {
            Log.w(TAG, "Sin permiso POST_NOTIFICATIONS: " + e.getMessage());
        }
    }

    private void mostrarNotifAsignado(Context ctx, String pedidoId) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("abrir_tab", "ruta");
        intent.putExtra("pedido_id", pedidoId);
        PendingIntent pi = PendingIntent.getActivity(ctx,
                pedidoId.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        try {
            NotificationManagerCompat.from(ctx).notify(NOTIF_ID_ASIG,
                    new NotificationCompat.Builder(ctx, CHANNEL_ASIG)
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
            Log.d(TAG, "✅ Notif asignado enviada: pedido #" + pedidoId);
        } catch (SecurityException e) {
            Log.w(TAG, "Sin permiso POST_NOTIFICATIONS: " + e.getMessage());
        }
    }

    /* ══════════════════════════════════════
       CREAR CANALES (idempotente)
    ══════════════════════════════════════ */
    private void crearCanales(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        /* Pendientes */
        NotificationChannel chPend = new NotificationChannel(
                CHANNEL_PEND, "Pedidos WIL", NotificationManager.IMPORTANCE_HIGH);
        chPend.setDescription("Nuevos pedidos sin tomar");
        chPend.enableVibration(true);
        chPend.setVibrationPattern(new long[]{0, 300, 100, 300, 100, 500});
        chPend.setLightColor(Color.parseColor("#006970"));
        chPend.enableLights(true);
        chPend.setShowBadge(true);
        nm.createNotificationChannel(chPend);

        /* Asignado */
        NotificationChannel chAsig = new NotificationChannel(
                CHANNEL_ASIG, "Pedido asignado WIL", NotificationManager.IMPORTANCE_HIGH);
        chAsig.setDescription("Te asignaron un pedido directamente");
        chAsig.enableVibration(true);
        chAsig.setVibrationPattern(new long[]{0,500,150,500,150,500,300,600});
        chAsig.setLightColor(Color.parseColor("#7c3aed"));
        chAsig.enableLights(true);
        chAsig.setShowBadge(true);
        nm.createNotificationChannel(chAsig);
    }

    /* ══════════════════════════════════════
       HELPERS
    ══════════════════════════════════════ */
    private String normStr(String s) {
        if (s == null) return "";
        return s.toLowerCase()
                .replaceAll("[\"']", "")
                .replaceAll("[áàä]", "a")
                .replaceAll("[éèë]", "e")
                .replaceAll("[íìï]", "i")
                .replaceAll("[óòö]", "o")
                .replaceAll("[úùü]", "u")
                .replaceAll("[ñ]",   "n")
                .trim();
    }

    private String[] parseCsvLine(String line) {
        List<String> cols = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inQ = false;
        for (char ch : line.toCharArray()) {
            if      (ch == '"')           inQ = !inQ;
            else if (ch == ',' && !inQ) { cols.add(cur.toString()); cur = new StringBuilder(); }
            else                          cur.append(ch);
        }
        cols.add(cur.toString());
        return cols.toArray(new String[0]);
    }
}