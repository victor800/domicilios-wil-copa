package com.domicilioswil.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class PollClienteService {

    private static final String TAG         = "WIL_CLIENT";
    private static final String CHANNEL     = "wil_cliente";   // canal que ya creas en PollForegroundService
    private static final int    NOTIF_ID    = 7001;            // notif del cliente

    public static void ejecutar(Context context) {
        new Thread(() -> {
            SharedPreferences prefs   = context.getSharedPreferences("wil_prefs", Context.MODE_PRIVATE);
            String              pedidoId = prefs.getString("cliente_pedido_id", "");


            if (pedidoId.isEmpty()) {
                Log.d(TAG, "No hay pedido activo para el cliente, no hay que notificar");
                return;
            }

            try {
                String csv = descargarCSV(context);
                if (csv == null || csv.length() < 50) {
                    Log.w(TAG, "CSV vacío para cliente");
                    return;
                }

                String estado = obtenerEstadoPedido(csv, pedidoId);
                if (estado == null) {
                    Log.w(TAG, "Pedido #" + pedidoId + " no encontrado en CSV");
                    return;
                }

                // Guardar el último estado para evitar repetir notificaciones
                String estadoPrev = prefs.getString("cliente_ultimo_estado", "");
                if (estado.equals(estadoPrev)) {
                    Log.d(TAG, "Mismo estado cliente, no notifico");
                    return;
                }

                prefs.edit()
                        .putString("cliente_ultimo_estado", estado)
                        .apply();

                // Notificar según el estado
                if (estado.contains("pendiente")) {
                    notificarCliente(context, pedidoId, "Pedido en espera", "Tu pedido está pendiente de asignación.", false);
                } else if (estado.contains("asignad") || estado.contains("domicil")) {
                    notificarCliente(context, pedidoId, "🛵 Pedido asignado", "Un domiciliario fue asignado a tu pedido.", false);
                } else if (estado.contains("camino")) {
                    notificarCliente(context, pedidoId, "🚚 En camino", "El domiciliario está en camino a tu dirección.", true);
                } else if (estado.contains("entregado")) {
                    notificarCliente(context, pedidoId, "✅ Pedido entregado", "Tu pedido ha sido entregado satisfactoriamente.", false);
                } else if (estado.contains("cancelad")) {
                    notificarCliente(context, pedidoId, "❌ Pedido cancelado", "Tu pedido ha sido cancelado.", false);
                } else {
                    notificarCliente(context, pedidoId, "Pedido #" + pedidoId, "Estado: " + estado, false);
                }

            } catch (Exception e) {
                Log.e(TAG, "Error en PollClienteService: " + e.getMessage());
            }
        }).start();
    }

    private static String descargarCSV(Context context) {
        try {
            String sheetId = "1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU"; // <- igual que tu PollForegroundService
            String urlStr = "https://docs.google.com/spreadsheets/d/" + sheetId
                    + "/gviz/tq?tqx=out:csv&sheet=Pedidos&cachebust=" + System.currentTimeMillis();

            HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setDoInput(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Cache-Control", "no-cache, no-store");
            conn.setRequestProperty("Pragma", "no-cache");

            if (conn.getResponseCode() != 200) {
                Log.w(TAG, "Error HTTP en CSV cliente: " + conn.getResponseCode());
                return null;
            }

            BufferedReader br = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line).append("\n");
            }
            br.close();
            conn.disconnect();

            Log.d(TAG, "CSV cliente descargado, tamaño: " + sb.length());
            return sb.toString();

        } catch (Exception e) {
            Log.e(TAG, "Error descargando CSV cliente: " + e.getMessage());
            return null;
        }
    }

    private static String obtenerEstadoPedido(String csv, String pedidoId) {
        Set<String> vistos = new HashSet<>();
        for (String linea : csv.split("\n")) {
            linea = linea.trim();
            if (linea.isEmpty()) continue;

            String[] cols = parseCsvLine(linea);
            if (cols.length < 16) continue;

            String pedId = cols[0].trim().replaceAll("[\"' ]", "");
            if (!pedId.matches("\\d{2,5}") || vistos.contains(pedId)) continue;
            vistos.add(pedId);

            if (!pedId.equals(pedidoId)) continue;

            return normStr(cols[4]); // columna 4 = estado
        }
        return null;
    }

    private static void notificarCliente(Context context, String pedidoId, String titulo, String cuerpo, boolean sonidoDefault) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        intent.putExtra("abrir_tab", "pedido_cliente");
        intent.putExtra("pedido_id", pedidoId);

        PendingIntent pi = PendingIntent.getActivity(
                context, 7001, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(titulo)
                .setContentText(cuerpo)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pi)
                .setColor(Color.parseColor("#003f87"));

        if (sonidoDefault) {
            builder.setDefaults(Notification.DEFAULT_SOUND);
        }

        try {
            NotificationManagerCompat.from(context).notify(NOTIF_ID, builder.build());
            Log.d(TAG, "✅ Notif cliente: " + pedidoId + " | " + titulo);
        } catch (SecurityException e) {
            Log.w(TAG, "Sin permiso POST_NOTIFICATIONS cliente: " + e.getMessage());
        }
    }

    private static String normStr(String s) {
        if (s == null) return "";
        return s.toLowerCase()
                .replaceAll("[\"']", "")
                .replaceAll("[áàä]", "a").replaceAll("[éèë]", "e")
                .replaceAll("[íìï]", "i").replaceAll("[óòö]", "o")
                .replaceAll("[úùü]", "u").replaceAll("[ñ]", "n")
                .trim();
    }



    private static String[] parseCsvLine(String line) {
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