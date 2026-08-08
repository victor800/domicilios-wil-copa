package com.domicilioswil.app

import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

class PedidosPollingService : Service() {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Intervalo de polling (15 seg activo, 30 seg en background)
    private val INTERVALO_MS = 15_000L

    // Estado previo para detectar cambios
    private var pendientesAnterior = -1
    private var asignadosAnteriores = setOf<String>()

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(this)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            this, "wil_session", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    private val domiId get() = prefs.getString("domi_id", "") ?: ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        NotificationHelper.crearCanales(this)
        startForeground(
            NotificationHelper.ID_FOREGROUND,
            NotificationHelper.notifForeground(this)
        )
        iniciarPolling()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY: el sistema reinicia el servicio si lo mata
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }

    /* ══ POLLING LOOP ══ */
    private fun iniciarPolling() {
        scope.launch {
            while (isActive) {
                try {
                    verificarPedidos()
                } catch (_: Exception) { }
                delay(INTERVALO_MS)
            }
        }
    }

    private suspend fun verificarPedidos() {
        if (domiId.isBlank()) return

        // ── 1. Pedidos PENDIENTES (sin tomar aún) ──
        val pendientes = consultarEstado("pendiente", "")
        val cantPendientes = pendientes.length()

        if (pendientesAnterior >= 0) {
            when {
                // Llegaron pedidos nuevos
                cantPendientes > pendientesAnterior -> {
                    val nuevos = cantPendientes - pendientesAnterior
                    withContext(Dispatchers.Main) {
                        NotificationHelper.notifPedidoNuevo(this@PedidosPollingService, nuevos)
                    }
                }
                // Siguen habiendo pendientes sin atender (recuerda cada 2 ciclos)
                cantPendientes > 0 && pendientesAnterior == cantPendientes -> {
                    withContext(Dispatchers.Main) {
                        NotificationHelper.notifPendientes(this@PedidosPollingService, cantPendientes)
                    }
                }
            }
        }
        pendientesAnterior = cantPendientes

        // ── 2. Pedidos ASIGNADOS a este domi (en ruta) ──
        val enRuta = consultarEstado("en ruta", domiId)
        val idsActuales = mutableSetOf<String>()

        for (i in 0 until enRuta.length()) {
            val p = enRuta.getJSONObject(i)
            val id = p.optString("idPedido", "")
            if (id.isNotBlank()) idsActuales.add(id)
        }

        // Detectar pedidos recién asignados (que no estaban antes)
        val recienAsignados = idsActuales - asignadosAnteriores
        recienAsignados.forEach { idPedido ->
            withContext(Dispatchers.Main) {
                NotificationHelper.notifAsignado(this@PedidosPollingService, idPedido)
            }
        }
        asignadosAnteriores = idsActuales
    }

    /* ── Consulta REST al servidor ── */
    private fun consultarEstado(estado: String, filtroDomiId: String): JSONArray {
        val domiParam = if (filtroDomiId.isNotBlank()) "&domiId=$filtroDomiId" else ""
        val url = "https://domicilios-wil.vercel.app/api/foto" +
                "?recurso=pedidos&estado=${estado.replace(" ", "%20")}&limit=50$domiParam"

        val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        conn.connectTimeout = 8_000
        conn.readTimeout    = 8_000
        val body = conn.inputStream.bufferedReader().readText()
        conn.disconnect()

        return JSONObject(body).optJSONArray("data") ?: JSONArray()
    }
}