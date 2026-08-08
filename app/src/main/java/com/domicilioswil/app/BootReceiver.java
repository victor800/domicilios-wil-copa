package com.domicilioswil.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "WIL_BOOT";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        boolean esBoot = action.equals(Intent.ACTION_BOOT_COMPLETED)
                || action.equals("android.intent.action.QUICKBOOT_POWERON")
                || action.equals("com.htc.intent.action.QUICKBOOT_POWERON");

        if (!esBoot) return;

        Log.d(TAG, "Boot detectado — restaurando servicios WIL");

        // Solo restaurar si había sesión guardada
        SharedPreferences prefs = context.getSharedPreferences("wil_prefs", Context.MODE_PRIVATE);
        String nombre = prefs.getString("domi_nombre", "");
        String id     = prefs.getString("domi_id", "");

        if (nombre.isEmpty() && id.isEmpty()) {
            Log.d(TAG, "Sin sesión guardada, no se restauran servicios");
            return;
        }

        Log.d(TAG, "Sesión encontrada: " + nombre + " / " + id + " → restaurando");

        // 1. Reiniciar ForegroundService (poll cada 45s)
        try {
            Intent svc = new Intent(context, PollForegroundService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
            Log.d(TAG, "✅ ForegroundService reiniciado");
        } catch (Exception e) {
            Log.e(TAG, "Error reiniciando ForegroundService: " + e.getMessage());
        }

        // 2. Reiniciar WorkManager (fallback cada 15min)
        try {
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();

            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                    PollPedidosWorker.class,
                    15, TimeUnit.MINUTES
            ).setConstraints(constraints).build();

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                    "wil-poll-pedidos",
                    ExistingPeriodicWorkPolicy.KEEP,
                    request
            );
            Log.d(TAG, "✅ WorkManager reiniciado");
        } catch (Exception e) {
            Log.e(TAG, "Error reiniciando WorkManager: " + e.getMessage());
        }
    }
}