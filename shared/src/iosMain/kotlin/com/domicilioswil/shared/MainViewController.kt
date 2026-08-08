package com.domicilioswil.shared

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.window.ComposeUIViewController
import com.domicilioswil.shared.ui.HomeScreen
import com.domicilioswil.shared.ui.components.WelcomeOverlay
import platform.UIKit.UIViewController

@Composable
fun App() {
    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            var mostrarBienvenida by remember { mutableStateOf(true) }
            if (mostrarBienvenida) {
                WelcomeOverlay(onFinished = { mostrarBienvenida = false })
            } else {
                HomeScreen(
                    onIngresarDomiciliario = {
                        // TODO: navegación a login en iOS
                    }
                )
            }
        }
    }
}

fun MainViewController(): UIViewController = ComposeUIViewController { App() }
