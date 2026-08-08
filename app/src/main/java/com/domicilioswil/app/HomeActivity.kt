// Ubicación: app/src/main/java/com/domicilioswil/app/HomeActivity.kt
package com.domicilioswil.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.domicilioswil.shared.ui.components.WelcomeOverlay
import com.domicilioswil.shared.ui.components.initPlatformContext
import com.domicilioswil.shared.ui.HomeScreen

class HomeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initPlatformContext(this)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    var mostrarBienvenida by remember { mutableStateOf(true) }
                    if (mostrarBienvenida) {
                        WelcomeOverlay(onFinished = { mostrarBienvenida = false })
                    } else {
                        HomeScreen(
                            onIngresarDomiciliario = {
                                startActivity(Intent(this, LoginActivity::class.java))
                            }
                        )
                    }
                }
            }
        }
    }
}
