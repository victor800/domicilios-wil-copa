package com.domicilioswil.app

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import com.google.android.material.bottomnavigation.BottomNavigationView

class ClienteActivity : AppCompatActivity() {

    private lateinit var bottomNav: BottomNavigationView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_cliente)

        bottomNav = findViewById(R.id.bottomNav)

        // Tab inicial según intent (por defecto Home)
        val tabInicial = intent.getStringExtra("tab") ?: "home"

        if (savedInstanceState == null) {
            when (tabInicial) {
                "rastrear" -> {
                    cargarFragment(RastrearPedidoFragment())
                    bottomNav.selectedItemId = R.id.nav_rastrear
                }
                else -> {
                    cargarFragment(HomeFragment())
                    bottomNav.selectedItemId = R.id.nav_home
                }
            }
        }

        bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_home     -> { cargarFragment(HomeFragment());            true }
                R.id.nav_rastrear -> { cargarFragment(RastrearPedidoFragment());  true }
                R.id.nav_perfil -> { cargarFragment(PerfilClienteFragment()); true }
                else -> false
            }
        }
    }

    private fun cargarFragment(fragment: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.clienteFragmentContainer, fragment)
            .commit()
    }

    override fun onBackPressed() {
        // Si no está en Home, vuelve a Home
        if (bottomNav.selectedItemId != R.id.nav_home) {
            bottomNav.selectedItemId = R.id.nav_home
        } else {
            super.onBackPressed()
        }
    }
}