package com.domicilioswil.shared.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

@Composable
expect fun WilLogoImage(modifier: Modifier = Modifier)

/**
 * Equivalente nativo del #welcome-overlay del index.html: logo, título,
 * alianzas oficiales y barra de progreso de 5 segundos antes de mostrar el Home.
 */
@Composable
fun WelcomeOverlay(onFinished: () -> Unit) {
    var visible by remember { mutableStateOf(true) }
    var progreso by remember { mutableStateOf(0f) }

    LaunchedEffect(Unit) {
        val duracionMs = 5000
        val pasoMs = 60
        var transcurrido = 0
        while (transcurrido < duracionMs) {
            delay(pasoMs.toLong())
            transcurrido += pasoMs
            progreso = (transcurrido.toFloat() / duracionMs).coerceIn(0f, 1f)
        }
        visible = false
        onFinished()
    }

    AnimatedVisibility(visible = visible, exit = fadeOut(), enter = fadeIn()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.White)
                .padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            Spacer(Modifier.height(24.dp))

            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier
                        .size(100.dp)
                        .clip(RoundedCornerShape(30.dp))
                        .background(Color(0xFFF8FAFC)),
                    contentAlignment = Alignment.Center
                ) {
                    WilLogoImage(modifier = Modifier.size(72.dp))
                }
                Spacer(Modifier.height(20.dp))
                Text(
                    "Domicilios WIL",
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Black,
                    color = Color(0xFF1E293B)
                )
                Text(
                    "Copacabana, Antioquia",
                    fontSize = 14.sp,
                    color = Color(0xFF64748B),
                    modifier = Modifier.padding(top = 6.dp)
                )
                Spacer(Modifier.height(24.dp))
                Text(
                    "Bienvenido a tu servicio\nde entregas de confianza",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFF1E293B),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center
                )
            }

            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.fillMaxWidth()
            ) {
                LinearProgressIndicator(
                    progress = { progreso },
                    modifier = Modifier
                        .width(180.dp)
                        .height(3.dp)
                        .clip(RoundedCornerShape(2.dp)),
                    color = Color(0xFF10B981),
                    trackColor = Color(0xFFE2E8F0)
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    "Entregas rápidas · Medicamentos y más",
                    fontSize = 11.sp,
                    color = Color(0xFF94A3B8)
                )
            }
        }
    }
}
