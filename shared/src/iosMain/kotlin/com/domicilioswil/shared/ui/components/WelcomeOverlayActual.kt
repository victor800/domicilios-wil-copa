package com.domicilioswil.shared.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Box

@Composable
actual fun WilLogoImage(modifier: Modifier) {
    // TODO: reemplazar por el logo real usando compose resources (Res.drawable.logo_wil)
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(Color(0xFF00897A)),
        contentAlignment = Alignment.Center
    ) {
        Text("🛵", fontSize = 32.sp)
    }
}
