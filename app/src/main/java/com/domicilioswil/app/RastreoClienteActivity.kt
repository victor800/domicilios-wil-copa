package com.domicilioswil.app

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import android.widget.TextView

class RastreoClienteActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_rastreo_cliente)

        val idPedido = intent.getStringExtra("idPedido") ?: "???"

        findViewById<TextView>(R.id.tvEstadoPedido).text =
            "✅ Pedido #$idPedido encontrado y activo"
    }
}