package com.domicilioswil.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

public class MainActivity extends Activity {

    private WebView webView;
    private static final String APP_URL    = "https://domicilios-wil.vercel.app/index.html";
    private static final String CHANNEL_ID = "wil_pedidos";
    private static final int    REQ_NOTIF  = 101;
    private static final int    REQ_LOC    = 102;
    private static final int    REQ_LOC_BG = 103;

    private long _ultimoResume = 0;
    private ValueCallback<Uri[]> mFileCallback;
    private static final int REQ_FILE = 200;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        setContentView(R.layout.activity_main);

        crearCanalesNotificacion();
        pedirPermisoNotificaciones();
        pedirPermisoUbicacion();

        webView = findViewById(R.id.webview);
        configurarWebView();
        webView.addJavascriptInterface(new WilBridge(), "WilNativo");
        webView.loadUrl(APP_URL);

        /* Si ya hay sesión guardada, arrancar AMBOS mecanismos sin esperar al JS */
        SharedPreferences prefs = getSharedPreferences("wil_prefs", MODE_PRIVATE);
        String nombreGuardado = prefs.getString("domi_nombre", "");
        if (!nombreGuardado.isEmpty()) {
            android.util.Log.d("WIL_APK", "Sesión en prefs → arrancando servicios");
            iniciarServicioInmediato();    // ← ForegroundService: poll cada 45s
            iniciarPollingBackground();   // ← WorkManager: fallback cada 15min
        }

        manejarIntentNotificacion(getIntent());
    }

    /* ═══════════════════════════════════════════
       SERVICIO EN PRIMER PLANO (inmediato, 45s)
    ═══════════════════════════════════════════ */
    private void iniciarServicioInmediato() {
        Intent svc = new Intent(this, PollForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }
        android.util.Log.d("WIL_APK", "✅ ForegroundService arrancado (poll cada 45s)");
    }

    private void detenerServicioInmediato() {
        stopService(new Intent(this, PollForegroundService.class));
        android.util.Log.d("WIL_APK", "ForegroundService detenido");
    }

    /* ═══════════════════════════════════════════
       WORKMANAGER — fallback cada 15 min
    ═══════════════════════════════════════════ */
    private void iniciarPollingBackground() {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                PollPedidosWorker.class,
                15, TimeUnit.MINUTES
        ).setConstraints(constraints).build();
        WorkManager.getInstance(getApplicationContext())
                .enqueueUniquePeriodicWork(
                        "wil-poll-pedidos",
                        ExistingPeriodicWorkPolicy.KEEP,
                        request
                );
        android.util.Log.d("WIL_APK", "✅ WorkManager en marcha (fallback 15 min)");
    }

    /* ═══════════════════════════════════════════
       CONFIGURAR WEBVIEW
    ═══════════════════════════════════════════ */
    @SuppressLint("SetJavaScriptEnabled")
    private void configurarWebView() {
        WebView.setWebContentsDebuggingEnabled(true);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setGeolocationEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " WilApp/1.0");

        webView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                if (url.startsWith("waze://")) {
                    abrirUriExterno(url); return true;
                }
                if (url.startsWith("intent://")) {
                    try {
                        Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                    } catch (Exception e) {
                        abrirUriExterno("https://play.google.com/store/apps/details?id=com.waze");
                    }
                    return true;
                }
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    abrirUriExterno(url); return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {

            @Override
            public void onGeolocationPermissionsShowPrompt(
                    String origin, GeolocationPermissions.Callback callback) {
                boolean tienePermiso = ContextCompat.checkSelfPermission(
                        MainActivity.this,
                        android.Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED;
                callback.invoke(origin, tienePermiso, tienePermiso);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.grant(request.getResources());
            }

            // ✅ NUEVO — habilita input[type=file] en Android WebView
            @Override
            public boolean onShowFileChooser(WebView wv,
                                             ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {

                // Cancelar callback anterior si existía
                if (mFileCallback != null) {
                    mFileCallback.onReceiveValue(null);
                    mFileCallback = null;
                }
                mFileCallback = filePathCallback;

                // Intent que abre galería Y cámara (chooser)
                Intent gallery = new Intent(Intent.ACTION_GET_CONTENT);
                gallery.addCategory(Intent.CATEGORY_OPENABLE);
                gallery.setType("image/*");

                Intent camera = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);

                Intent chooser = Intent.createChooser(gallery, "Seleccionar comprobante");
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{ camera });

                try {
                    startActivityForResult(chooser, REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    mFileCallback = null;
                    android.util.Log.e("WIL_APK", "No se pudo abrir selector: " + e.getMessage());
                    return false;
                }
                return true;
            }
        });
    }

    /* ═══════════════════════════════════════════
       PUENTE JS ↔ JAVA
    ═══════════════════════════════════════════ */
    private class WilBridge {

        @JavascriptInterface
        public void guardarSesionDomi(String nombre, String id) {
            SharedPreferences prefs = getSharedPreferences("wil_prefs", MODE_PRIVATE);
            prefs.edit()
                    .putString("domi_nombre", nombre != null ? nombre : "")
                    .putString("domi_id",     id     != null ? id     : "")
                    .apply();
            runOnUiThread(() -> {
                iniciarServicioInmediato();   // ← arrancar ForegroundService
                iniciarPollingBackground();   // ← arrancar WorkManager fallback
            });
            android.util.Log.d("WIL_APK", "Sesión guardada: " + nombre + " / " + id);
        }

        @JavascriptInterface
        public void notificarPedidos(int count, String titulo, String cuerpo) {
            mostrarNotificacionPendientes(count, titulo, cuerpo);
        }

        @JavascriptInterface
        public void limpiarBadge() {
            NotificationManagerCompat.from(MainActivity.this).cancel(1001);
            NotificationManagerCompat.from(MainActivity.this).cancel(2001);
        }

        @JavascriptInterface
        public void notificarAsignado(String pedidoId, String titulo, String cuerpo) {
            runOnUiThread(() -> mostrarNotificacionAsignado(pedidoId, titulo, cuerpo));
        }

        @JavascriptInterface
        public void abrirRastreo() {
            android.util.Log.d("WIL_APK", "✅ abrirRastreo() llamado desde JS");
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(MainActivity.this, ClienteActivity.class);
                    intent.putExtra("tab", "rastrear");
                    startActivity(intent);
                    android.util.Log.d("WIL_APK", "✅ ClienteActivity iniciada");
                } catch (Exception e) {
                    android.util.Log.e("WIL_APK", "❌ Error: " + e.getMessage());
                }
            });
        }


        @JavascriptInterface
        public void abrirWaze(String lat, String lng) {
            runOnUiThread(() -> {
                String wazeUri = "waze://?ll=" + lat + "," + lng + "&navigate=yes&zoom=17";
                boolean wazeInstalado = false;
                try {
                    getPackageManager().getPackageInfo("com.waze", 0);
                    wazeInstalado = true;
                } catch (PackageManager.NameNotFoundException e) { }
                if (wazeInstalado) {
                    try {
                        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(wazeUri));
                        i.setPackage("com.waze");
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                        startActivity(i);
                        return;
                    } catch (Exception ignored) { }
                }
                try {
                    Intent maps = new Intent(Intent.ACTION_VIEW,
                            Uri.parse("google.navigation:q=" + lat + "," + lng + "&mode=d"));
                    maps.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(maps);
                } catch (ActivityNotFoundException e) {
                    abrirUriExterno("https://waze.com/ul?ll=" + lat + "," + lng + "&navigate=yes");
                }
            });
        }
    }

    /* ═══════════════════════════════════════════
       NOTIFICACIONES
    ═══════════════════════════════════════════ */
    private void crearCanalesNotificacion() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel chPend = new NotificationChannel(
                CHANNEL_ID, "Pedidos WIL", NotificationManager.IMPORTANCE_HIGH);
        chPend.setDescription("Alertas de pedidos pendientes");
        chPend.enableLights(true);
        chPend.setLightColor(Color.parseColor("#006970"));
        chPend.enableVibration(true);
        chPend.setVibrationPattern(new long[]{0, 400, 150, 400, 150, 600});
        chPend.setShowBadge(true);
        nm.createNotificationChannel(chPend);

        NotificationChannel chAsig = new NotificationChannel(
                "wil_asignado", "Pedido asignado WIL", NotificationManager.IMPORTANCE_HIGH);
        chAsig.setDescription("Cuando te asignan un pedido directamente");
        chAsig.enableVibration(true);
        chAsig.setVibrationPattern(new long[]{0,500,150,500,150,500,300,600});
        chAsig.setShowBadge(true);
        chAsig.enableLights(true);
        chAsig.setLightColor(Color.parseColor("#7c3aed"));
        nm.createNotificationChannel(chAsig);
    }

    private void mostrarNotificacionPendientes(int count, String titulo, String cuerpo) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("abrir_tab", "pedidos");
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            NotificationManagerCompat.from(this).notify(1001,
                    new NotificationCompat.Builder(this, CHANNEL_ID)
                            .setSmallIcon(R.mipmap.ic_launcher)
                            .setContentTitle(titulo != null ? titulo : "🛵 Pedidos WIL")
                            .setContentText(cuerpo  != null ? cuerpo : "Hay pedidos pendientes")
                            .setNumber(count)
                            .setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .setContentIntent(pi)
                            .setColor(Color.parseColor("#006970"))
                            .setVibrate(new long[]{0, 400, 150, 400})
                            .build());
        } catch (SecurityException e) {
            android.util.Log.w("WIL_APK", "Sin permiso notif: " + e.getMessage());
        }
    }

    private void mostrarNotificacionAsignado(String pedidoId, String titulo, String cuerpo) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("abrir_tab", "ruta");
        intent.putExtra("pedido_id", pedidoId);
        PendingIntent pi = PendingIntent.getActivity(this,
                pedidoId != null ? pedidoId.hashCode() : 2001, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            NotificationManagerCompat.from(this).notify(2001,
                    new NotificationCompat.Builder(this, "wil_asignado")
                            .setSmallIcon(R.mipmap.ic_launcher)
                            .setContentTitle(titulo != null ? titulo : "🎯 ¡Pedido asignado!")
                            .setContentText(cuerpo  != null ? cuerpo : "Revisa tu pedido")
                            .setStyle(new NotificationCompat.BigTextStyle().bigText(cuerpo))
                            .setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_MAX)
                            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                            .setContentIntent(pi)
                            .setColor(Color.parseColor("#7c3aed"))
                            .setVibrate(new long[]{0,500,150,500,150,500,300,600})
                            .build());
        } catch (SecurityException e) {
            android.util.Log.w("WIL_APK", "Sin permiso notif asig: " + e.getMessage());
        }
    }

    /* ═══════════════════════════════════════════
       PERMISOS
    ═══════════════════════════════════════════ */
    private void pedirPermisoNotificaciones() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this,
                    android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
            }
        }
    }

    private void pedirPermisoUbicacion() {
        boolean fineOk   = ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean coarseOk = ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (!fineOk || !coarseOk) {
            ActivityCompat.requestPermissions(this, new String[]{
                    android.Manifest.permission.ACCESS_FINE_LOCATION,
                    android.Manifest.permission.ACCESS_COARSE_LOCATION
            }, REQ_LOC);
        } else {
            pedirPermisoUbicacionBackground();
        }
    }

    private void pedirPermisoUbicacionBackground() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        boolean bgOk = ContextCompat.checkSelfPermission(this,
                android.Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        if (!bgOk) {
            ActivityCompat.requestPermissions(this,
                    new String[]{android.Manifest.permission.ACCESS_BACKGROUND_LOCATION},
                    REQ_LOC_BG);
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (req == REQ_LOC) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (ok) {
                pedirPermisoUbicacionBackground();
                if (webView != null) {
                    webView.evaluateJavascript(
                            "if(typeof trkActivar==='function' && !TRK.activo) trkActivar();", null);
                }
            }
            android.util.Log.d("WIL_APK", "Permiso ubicación: " + (ok ? "CONCEDIDO" : "DENEGADO"));
        }
        if (req == REQ_LOC_BG) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            android.util.Log.d("WIL_APK", "Permiso ubicación BG: " + (ok ? "CONCEDIDO" : "DENEGADO"));
        }
        if (req == REQ_NOTIF) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            android.util.Log.d("WIL_APK", "Permiso notificaciones: " + (ok ? "CONCEDIDO" : "DENEGADO"));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_FILE) {
            if (mFileCallback == null) return;

            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                String dataStr = data.getDataString();
                if (dataStr != null) {
                    results = new Uri[]{ Uri.parse(dataStr) };
                } else if (data.getClipData() != null) {
                    // Selección múltiple → tomamos solo la primera
                    results = new Uri[]{ data.getClipData().getItemAt(0).getUri() };
                }
            }
            mFileCallback.onReceiveValue(results);
            mFileCallback = null;
        }
    }

    /* ═══════════════════════════════════════════
       CICLO DE VIDA
    ═══════════════════════════════════════════ */
    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        long ahora = System.currentTimeMillis();
        if (ahora - _ultimoResume > 3000) {
            _ultimoResume = ahora;
            webView.postDelayed(() -> {
                if (webView != null) {
                    webView.evaluateJavascript(
                            "try {" +
                                    "  if(typeof fetchPedidos === 'function')        fetchPedidos();" +
                                    "  if(typeof fetchHistorialSheet === 'function') fetchHistorialSheet();" +
                                    "  if(typeof _tabMap !== 'undefined' && _tabMap) _tabMap.invalidateSize({animate:false});" +
                                    "  if(typeof TRK !== 'undefined' && TRK.activo && TRK.watchId === null) trkActivar();" +
                                    "} catch(e) { console.warn('[onResume JS]', e); }",
                            null);
                }
            }, 600);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        webView.destroy();
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else webView.loadUrl(APP_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        manejarIntentNotificacion(intent);
    }

    private void manejarIntentNotificacion(Intent intent) {
        if (intent == null || webView == null) return;
        String tab = intent.getStringExtra("abrir_tab");
        if (tab == null) return;
        webView.postDelayed(() -> {
            String js = "ruta".equals(tab)
                    ? "if(typeof switchTab==='function') switchTab('ruta');"
                    : "if(typeof fetchPedidos==='function') fetchPedidos();" +
                      "if(typeof switchTab==='function') switchTab('pedidos');";
            webView.evaluateJavascript(js, null);
        }, 900);
    }

    private void abrirUriExterno(String uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException ignored) { }
    }
}
