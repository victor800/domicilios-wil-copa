package com.domicilioswil.app

import android.content.Intent
import android.graphics.*
import android.net.Uri
import android.os.Bundle
import android.view.*
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.bumptech.glide.Glide
import com.domicilioswil.app.databinding.FragmentPerfilBinding
import kotlinx.coroutines.*
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*

class PerfilFragment : Fragment() {

    private var _binding: FragmentPerfilBinding? = null
    private val binding get() = _binding!!
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(requireContext())
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            requireContext(), "wil_session", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentPerfilBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        mostrarDatosSesion()
        cargarStats()
        configurarBotones()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
        scope.cancel()
    }

    /* ── Datos guardados en sesión ── */
    private fun mostrarDatosSesion() {
        val nombre   = prefs.getString("domi_nombre", "") ?: ""
        val id       = prefs.getString("domi_id",     "") ?: ""
        val telefono = prefs.getString("domi_tel",    "") ?: ""
        val foto     = prefs.getString("domi_foto",   "") ?: ""

        binding.perfilTvNombre.text   = nombre.uppercase()
        binding.perfilTvId.text       = id.ifBlank { "—" }
        binding.perfilTvTelefono.text = telefono.ifBlank { "—" }

        if (foto.isNotBlank()) {
            // Ocultar iniciales, mostrar imagen
            binding.perfilTvIniciales.visibility  = View.GONE
            binding.perfilImgAvatar.visibility    = View.VISIBLE

            // FaceCircleCrop: recorta en círculo desplazando el crop
            // hacia la parte superior para mostrar bien el rostro
            Glide.with(this)
                .load(foto)
                .transform(FaceCircleCrop(yOffset = 0.35f))
                .placeholder(R.drawable.ic_logo_wil)
                .error(R.drawable.ic_logo_wil)
                .into(binding.perfilImgAvatar)
        } else {
            binding.perfilImgAvatar.visibility   = View.GONE
            binding.perfilTvIniciales.visibility = View.VISIBLE
            binding.perfilTvIniciales.text       = iniciales(nombre)
        }
    }

    /* ── Cargar stats del servidor ── */
    private fun cargarStats() {
        val domiId = prefs.getString("domi_id", "") ?: ""
        if (domiId.isBlank()) return

        scope.launch {
            try {
                val urlTotal = "https://domicilios-wil.vercel.app/api/foto" +
                        "?recurso=pedidos&estado=entregado&domiId=$domiId&limit=500"

                val respTotal = withContext(Dispatchers.IO) {
                    val conn = java.net.URL(urlTotal).openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 10_000; conn.readTimeout = 10_000
                    conn.inputStream.bufferedReader().readText().also { conn.disconnect() }
                }

                val dataTotal     = JSONObject(respTotal).optJSONArray("data")
                val totalEntregas = dataTotal?.length() ?: 0

                val hoy = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())
                var entregasHoy = 0
                if (dataTotal != null) {
                    for (i in 0 until dataTotal.length()) {
                        val p     = dataTotal.getJSONObject(i)
                        val fecha = normalizarFecha(p.optString("fecha", ""))
                        if (fecha == hoy) entregasHoy++
                    }
                }

                binding.perfilTvEntregasTotales.text = totalEntregas.toString()
                binding.perfilTvEntregasHoy.text     = entregasHoy.toString()
                binding.perfilTvEntregasChip.text    = "$totalEntregas entregas"
                binding.perfilTvCalificacion.text    = "—"
                binding.perfilTvAceptacion.text      = "—"

            } catch (_: Exception) { /* mantiene valores por defecto */ }
        }
    }

    /* ── Botones ── */
    private fun configurarBotones() {
        val telefono = prefs.getString("domi_tel", "") ?: ""

        binding.perfilBtnWhatsapp.setOnClickListener {
            val num = telefono.replace("[^0-9]".toRegex(), "")
            if (num.isNotBlank()) {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/57$num")))
            }
        }

        binding.perfilBtnCerrarSesion.setOnClickListener {
            prefs.edit().clear().apply()
            val intent = Intent(requireActivity(), LoginActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            requireActivity().startActivity(intent)
            requireActivity().overridePendingTransition(
                android.R.anim.fade_in, android.R.anim.fade_out
            )
            requireActivity().finish()
        }
    }

    /* ── Helpers ── */
    private fun iniciales(nombre: String): String =
        nombre.trim().split(" ").take(2)
            .joinToString("") { it.firstOrNull()?.uppercase() ?: "" }

    private fun generarBitmapIniciales(nombre: String): Bitmap {
        val size   = 128
        val bmp    = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val paintBg = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#005F5B")
        }
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paintBg)
        val ini      = iniciales(nombre)
        val paintTxt = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; textSize = 46f
            textAlign = Paint.Align.CENTER; isFakeBoldText = true
        }
        val y = size / 2f - (paintTxt.descent() + paintTxt.ascent()) / 2f
        canvas.drawText(ini, size / 2f, y, paintTxt)
        return bmp
    }

    private fun normalizarFecha(fecha: String): String = try {
        when {
            fecha.contains("T") -> fecha.take(10)
            fecha.contains("/") -> {
                val p = fecha.split("/")
                "${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}"
            }
            else -> fecha.take(10)
        }
    } catch (_: Exception) { fecha }
}