package com.domicilioswil.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.speech.tts.TextToSpeech
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.Locale

object NotificationHelper {

    // Canales
    const val CANAL_PEDIDOS    = "wil_pedidos"
    const val CANAL_FOREGROUND = "wil_servicio"

    // IDs notificación
    const val ID_FOREGROUND    = 1
    const val ID_PEDIDO_NUEVO  = 2
    const val ID_PENDIENTES    = 3
    const val ID_ASIGNADO      = 4

    // Throttle pendientes — 5 minutos en ms
    private const val INTERVALO_PENDIENTES_MS = 5 * 60 * 1000L
    private var ultimaNotifPendientes: Long = 0L

    // TTS singleton
    private var tts: TextToSpeech? = null
    private var ttsListo = false

    /* ── Inicializar TTS (llamar desde Application.onCreate o Service.onCreate) ── */
    fun iniciarTTS(ctx: Context) {
        if (tts != null) return
        tts = TextToSpeech(ctx.applicationContext) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val result = tts?.setLanguage(Locale("es", "ES"))
                ttsListo = result != TextToSpeech.LANG_MISSING_DATA
                        && result != TextToSpeech.LANG_NOT_SUPPORTED
            }
        }
    }

    /* ── Liberar TTS (llamar desde Service.onDestroy) ── */
    fun liberarTTS() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsListo = false
    }

    private fun hablar(texto: String) {
        if (!ttsListo) return
        tts?.speak(texto, TextToSpeech.QUEUE_ADD, null, texto.hashCode().toString())
    }

    // ─────────────────────────────────────────────

    fun crearCanales(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        val sonido = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val audioAttr = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        val canalPedidos = NotificationChannel(
            CANAL_PEDIDOS,
            "Pedidos WIL",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description      = "Avisos de pedidos nuevos, pendientes y asignaciones"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 300, 200, 300)
            setSound(sonido, audioAttr)
        }

        val canalFg = NotificationChannel(
            CANAL_FOREGROUND,
            "Servicio WIL activo",
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = "Notificación silenciosa que mantiene el servicio activo"
            setSound(null, null)
            enableVibration(false)
        }

        nm.createNotificationChannel(canalPedidos)
        nm.createNotificationChannel(canalFg)
    }

    /* ── Foreground (silenciosa) ── */
    fun notifForeground(ctx: Context): android.app.Notification {
        val intent = Intent(ctx, PanelDomiActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            ctx, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(ctx, CANAL_FOREGROUND)
            .setSmallIcon(R.drawable.ic_logo_wil)
            .setContentTitle("WIL Domicilios")
            .setContentText("Monitoreando pedidos…")
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
    }

    /* ── Pedido nuevo — de inmediato + voz ── */
    fun notifPedidoNuevo(ctx: Context, cantidad: Int) {
        val texto = if (cantidad == 1)
            "¡Hay 1 pedido nuevo disponible!"
        else
            "¡Hay $cantidad pedidos nuevos disponibles!"

        hablar(if (cantidad == 1) "Nuevo pedido disponible" else "Hay $cantidad pedidos nuevos disponibles")
        mostrar(ctx, ID_PEDIDO_NUEVO, "🛵 Pedido nuevo", texto, cantidad)
    }

    /* ── Pedidos pendientes — cada 5 min + voz ── */
    fun notifPendientes(ctx: Context, cantidad: Int) {
        val ahora = System.currentTimeMillis()
        if (ahora - ultimaNotifPendientes < INTERVALO_PENDIENTES_MS) return
        ultimaNotifPendientes = ahora

        val texto = "$cantidad pedido${if (cantidad != 1) "s" else ""} pendiente${if (cantidad != 1) "s" else ""} sin atender"
        hablar("Hay $cantidad pedido${if (cantidad != 1) "s" else ""} pendiente${if (cantidad != 1) "s" else ""} sin atender")
        mostrar(ctx, ID_PENDIENTES, "⏳ Pedidos pendientes", texto, cantidad)
    }

    /* ── Pedido asignado + voz ── */
    fun notifAsignado(ctx: Context, idPedido: String) {
        hablar("Te asignaron el pedido número $idPedido")
        mostrar(ctx, ID_ASIGNADO, "📦 Pedido asignado", "Se te asignó el pedido #$idPedido", 1)
    }

    /* ── Helper interno ── */
    private fun mostrar(ctx: Context, id: Int, titulo: String, texto: String, badgeCount: Int = 1) {
        val intent = Intent(ctx, PanelDomiActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            ctx, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val sonido = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

        val notif = NotificationCompat.Builder(ctx, CANAL_PEDIDOS)
            .setSmallIcon(R.drawable.ic_logo_wil)
            .setContentTitle(titulo)
            .setContentText(texto)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setSound(sonido)
            .setVibrate(longArrayOf(0, 300, 200, 300))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setNumber(badgeCount)
            .build()

        try {
            NotificationManagerCompat.from(ctx).notify(id, notif)
        } catch (_: SecurityException) { /* permiso no concedido */ }
    }
}