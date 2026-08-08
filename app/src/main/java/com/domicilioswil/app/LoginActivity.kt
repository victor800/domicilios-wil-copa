package com.domicilioswil.app

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.domicilioswil.app.databinding.ActivityLoginBinding
import com.domicilioswil.shared.network.ApiClient
import com.domicilioswil.shared.network.LoginRequest
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private var mostrandoClave = false

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(this)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            this,
            "wil_session",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (prefs.getString("domi_id", null) != null) {
            irAlPanel()
            return
        }

        configurarUI()
        configurarProblemas()
    }

    private fun configurarUI() {
        binding.btnTogglePassword.setOnClickListener {
            mostrandoClave = !mostrandoClave
            val tipo = if (mostrandoClave) {
                android.text.InputType.TYPE_CLASS_TEXT or
                        android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            } else {
                android.text.InputType.TYPE_CLASS_TEXT or
                        android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            binding.etPassword.inputType = tipo
            binding.etPassword.setSelection(binding.etPassword.text?.length ?: 0)
            binding.btnTogglePassword.alpha = if (mostrandoClave) 0.85f else 0.45f
        }

        binding.etPassword.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                cerrarTeclado()
                intentarLogin()
                true
            } else false
        }

        binding.btnLogin.setOnClickListener {
            cerrarTeclado()
            intentarLogin()
        }

        binding.btnVolver.setOnClickListener {
            finish()
        }
    }

    private fun intentarLogin() {
        val id  = binding.etIdWil.text.toString().trim().uppercase()
        val pwd = binding.etPassword.text.toString()

        if (id.isEmpty()) {
            mostrarError("Ingresa tu ID domiciliario")
            binding.etIdWil.requestFocus()
            return
        }
        if (pwd.isEmpty()) {
            mostrarError("Ingresa tu clave de acceso")
            binding.etPassword.requestFocus()
            return
        }

        setCargando(true)

        lifecycleScope.launch {
                try {
                val body = ApiClient.login(LoginRequest(idWil = id, password = pwd, rol = "domiciliario"))
                if (body.ok) {
                    prefs.edit()
                        .putString("domi_id",     body.id)
                        .putString("domi_nombre", body.nombre)
                        .putString("domi_rol",    body.rol)
                        .putString("domi_tel",    body.tel)
                        .putString("domi_foto",   body.foto)
                        .apply()

                    val primerNombre = body.nombre?.trim()?.split(" ")?.firstOrNull()
                        ?: body.nombre
                        ?: "Domiciliario"

                    binding.tvError.setTextColor(Color.parseColor("#00897A"))
                    binding.tvError.textSize   = 15f
                    binding.tvError.text       = "¡Bienvenido, $primerNombre! 🛵"

                    android.os.Handler(android.os.Looper.getMainLooper())
                        .postDelayed({ irAlPanel() }, 800L)

                } else {
                    val msg = body.error ?: "Error al ingresar"
                    mostrarError(msg)
                    setCargando(false)
                }

            } catch (e: Exception) {
                mostrarError("DEBUG: ${e::class.simpleName} - ${e.message}")
                setCargando(false)
            }
        }
    }

    private fun irAlPanel() {
        // ── Arrancar servicio de notificaciones nativo ──
        val svc = Intent(this, PedidosPollingService::class.java)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(svc)
        } else {
            startService(svc)
        }

        val intent = Intent(this, PanelDomiActivity::class.java)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        startActivity(intent)
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
        finish()
    }

    private fun setCargando(cargando: Boolean) {
        binding.progressLogin.visibility = if (cargando) View.VISIBLE else View.GONE
        binding.btnLogin.isEnabled       = !cargando
        binding.etIdWil.isEnabled        = !cargando
        binding.etPassword.isEnabled     = !cargando
        if (cargando) ocultarError()
    }

    private fun mostrarError(msg: String) {
        binding.tvError.text       = msg
        binding.tvError.visibility = View.VISIBLE
    }

    private fun ocultarError() {
        binding.tvError.visibility = View.GONE
    }

    private fun cerrarTeclado() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(binding.root.windowToken, 0)
    }

    private fun configurarProblemas() {
        val texto  = "¿Problemas para acceder? Contactar soporte WIL"
        val ssb    = SpannableStringBuilder(texto)
        val inicio = texto.indexOf("Contactar soporte WIL")

        val link = object : ClickableSpan() {
            override fun onClick(widget: View) {
                startActivity(Intent(Intent.ACTION_VIEW,
                    Uri.parse("https://wa.me/573023452213?text=Hola+soporte+WIL")))
            }
            override fun updateDrawState(ds: TextPaint) {
                super.updateDrawState(ds)
                ds.color           = Color.parseColor("#00B5B0")
                ds.isUnderlineText = true
            }
        }

        ssb.setSpan(link, inicio, texto.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        binding.tvProblemas.text           = ssb
        binding.tvProblemas.movementMethod = LinkMovementMethod.getInstance()
        binding.tvProblemas.highlightColor = Color.TRANSPARENT
    }
}