package com.domicilioswil.app

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class RastrearPedidoFragment : Fragment() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_rastrear_pedido, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        val etCodigo    = view.findViewById<com.google.android.material.textfield.TextInputEditText>(R.id.etCodigo)
        val tilCodigo   = view.findViewById<com.google.android.material.textfield.TextInputLayout>(R.id.tilCodigo)
        val btnRastrear = view.findViewById<com.google.android.material.button.MaterialButton>(R.id.btnRastrear)
        val btnOlvide   = view.findViewById<com.google.android.material.button.MaterialButton>(R.id.btnOlvidecodigo)

        etCodigo.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                tilCodigo.error = null
            }
            override fun afterTextChanged(s: android.text.Editable?) {}
        })

        etCodigo.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH) {
                btnRastrear.performClick(); true
            } else false
        }

        btnRastrear.setOnClickListener {
            val codigo = etCodigo.text?.toString()?.trim() ?: ""
            if (codigo.isBlank()) {
                tilCodigo.error = "Ingresa un código de seguimiento"
                return@setOnClickListener
            }
            validarPedido(codigo, view, btnRastrear, tilCodigo)
        }

        btnOlvide.setOnClickListener {
            android.app.AlertDialog.Builder(requireContext())
                .setTitle("¿Olvidaste tu código?")
                .setMessage("El código llegó por WhatsApp o SMS al hacer tu pedido.\n\nEjemplo: WIL-20481\n\nSi no lo tienes, contáctate con la tienda.")
                .setPositiveButton("Entendido", null)
                .show()
        }
    }

    override fun onDestroyView() { super.onDestroyView(); scope.cancel() }

    private fun validarPedido(
        codigo:      String,
        view:        View,
        btnRastrear: com.google.android.material.button.MaterialButton,
        tilCodigo:   com.google.android.material.textfield.TextInputLayout
    ) {
        val idPuro = codigo.uppercase().removePrefix("WIL-").trim()

        btnRastrear.isEnabled = false
        btnRastrear.text      = "Buscando…"
        btnRastrear.icon      = null
        ocultarTeclado()

        scope.launch {
            try {
                val url = "https://domicilios-wil.vercel.app/api/foto?recurso=pedidos&idPedido=$idPuro"

                val respuesta = withContext(Dispatchers.IO) {
                    val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 10_000
                    conn.readTimeout    = 10_000
                    conn.inputStream.bufferedReader().readText().also { conn.disconnect() }
                }

                val data   = org.json.JSONObject(respuesta).optJSONArray("data")
                val existe = data != null && data.length() > 0

                if (existe) {
                    mostrarBadgeExito(idPuro)
                } else {
                    tilCodigo.error = "No encontramos ese código. Verifica e intenta de nuevo."
                    mostrarBadgeNoEncontrado(view, idPuro)
                }

            } catch (e: Exception) {
                android.util.Log.e("RastrearFragment", "validarPedido: ${e.message}", e)
                tilCodigo.error = "Error de conexión. Revisa tu internet."
                mostrarBadgeError(view)
            } finally {
                btnRastrear.isEnabled = true
                btnRastrear.text      = "Rastrear pedido"
                btnRastrear.setIconResource(R.drawable.ic_radar)
            }
        }
    }

    private fun mostrarBadgeExito(idPedido: String) {
        val ctx   = requireContext()
        val sheet = com.google.android.material.bottomsheet.BottomSheetDialog(ctx)
        val v     = layoutInflater.inflate(R.layout.bottom_sheet_pedido_encontrado, null)

        val ringOuter = v.findViewById<View>(R.id.bsRingOuter)
        val ringInner = v.findViewById<View>(R.id.bsRingInner)

        listOf(ringOuter, ringInner).forEachIndexed { i, ring ->
            val runPulse = object : Runnable {
                override fun run() {
                    ring.scaleX = 1f; ring.scaleY = 1f; ring.alpha = 0.6f
                    ring.animate()
                        .scaleX(1.35f).scaleY(1.35f).alpha(0f)
                        .setDuration(900L)
                        .withEndAction { ring.post(this) }
                        .start()
                }
            }
            ring.postDelayed(runPulse, i * 200L)
        }

        v.findViewById<android.widget.TextView>(R.id.bsFoundEmoji).text  = "✅"
        v.findViewById<android.widget.TextView>(R.id.bsFoundTitulo).text = "¡Pedido activo encontrado!"
        v.findViewById<android.widget.TextView>(R.id.bsFoundSub).text    =
            "Hola 👋 Sí hay un pedido activo con el código #$idPedido"
        v.findViewById<android.widget.TextView>(R.id.bsFoundId).text     = "#$idPedido"

        v.findViewById<com.google.android.material.button.MaterialButton>(R.id.bsFoundBtnVer)
            .setOnClickListener {
                sheet.dismiss()
                navegarARastreoCliente(idPedido)
            }

        v.findViewById<com.google.android.material.button.MaterialButton>(R.id.bsFoundBtnCerrar)
            .setOnClickListener { sheet.dismiss() }

        sheet.setContentView(v)
        sheet.show()
    }

    private fun mostrarBadgeNoEncontrado(view: View, codigo: String) {
        com.google.android.material.snackbar.Snackbar.make(
            view,
            "❌  No encontramos el código #$codigo",
            com.google.android.material.snackbar.Snackbar.LENGTH_LONG
        ).setBackgroundTint(android.graphics.Color.parseColor("#7F1D1D"))
            .setTextColor(android.graphics.Color.parseColor("#FCA5A5"))
            .show()
    }

    private fun mostrarBadgeError(view: View) {
        com.google.android.material.snackbar.Snackbar.make(
            view,
            "⚠️  Sin conexión. Intenta de nuevo.",
            com.google.android.material.snackbar.Snackbar.LENGTH_LONG
        ).setBackgroundTint(android.graphics.Color.parseColor("#1E3A5F"))
            .setTextColor(android.graphics.Color.parseColor("#93C5FD"))
            .show()
    }

    private fun navegarARastreoCliente(idPedido: String) {
        val intent = android.content.Intent(requireContext(), RastreoClienteActivity::class.java)
        intent.putExtra("idPedido", idPedido)
        startActivity(intent)
    }

    private fun ocultarTeclado() {
        val imm = requireContext().getSystemService(android.content.Context.INPUT_METHOD_SERVICE)
                as android.view.inputmethod.InputMethodManager
        imm.hideSoftInputFromWindow(requireView().windowToken, 0)
    }
}