package com.domicilioswil.shared.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.domicilioswil.shared.ui.theme.Green400
import com.domicilioswil.shared.ui.theme.Green600
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * Equivalente nativo del slider "Desliza para pedir ahora" del index.html.
 * onConfirmed() se dispara cuando el usuario desliza más del 70% del recorrido,
 * igual que el umbral que ya tenías en el JS original.
 */
@Composable
fun OrderSlider(modifier: Modifier = Modifier, onConfirmed: () -> Unit) {
    var trackWidthPx by remember { mutableStateOf(0f) }
    val thumbSizeDp = 52.dp
    val density = androidx.compose.ui.platform.LocalDensity.current
    val thumbSizePx = with(density) { thumbSizeDp.toPx() }
    val margin = with(density) { 12.dp.toPx() }
    val offsetX = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var confirmado by remember { mutableStateOf(false) }
    val maxOffset = (trackWidthPx - thumbSizePx - margin).coerceAtLeast(0f)
    Box(
        modifier
            .fillMaxWidth()
            .height(64.dp)
            .onGloballyPositioned { trackWidthPx = it.size.width.toFloat() }
            .clip(RoundedCornerShape(50))
            .background(Brush.linearGradient(listOf(Green600, Green400)))
    ) {
        Text(
            text = if (confirmado) "🛵  ¡Vamos allá!" else "Desliza para pedir ahora  ›  ›  ›",
            color = Color.White.copy(alpha = if (confirmado) 1f else 0.85f),
            fontWeight = FontWeight.ExtraBold,
            fontSize = 15.sp,
            modifier = Modifier.align(Alignment.Center)
        )
        Box(
            Modifier
                .padding(6.dp)
                .offset { IntOffset(offsetX.value.roundToInt(), 0) }
                .size(thumbSizeDp)
                .clip(CircleShape)
                .background(Color.White)
                .pointerInput(maxOffset) {
                    detectDragGestures(
                        onDragEnd = {
                            scope.launch {
                                if (offsetX.value >= maxOffset * 0.7f && maxOffset > 0f) {
                                    offsetX.animateTo(maxOffset, tween(180))
                                    confirmado = true
                                    onConfirmed()
                                } else {
                                    offsetX.animateTo(0f, tween(300))
                                }
                            }
                        },
                        onDrag = { change, dragAmount ->
                            change.consume()
                            scope.launch {
                                val nuevo = (offsetX.value + dragAmount.x).coerceIn(0f, maxOffset)
                                offsetX.snapTo(nuevo)
                            }
                        }
                    )
                },
            contentAlignment = Alignment.Center
        ) {
            Text("🛵", fontSize = 22.sp)
        }
    }
}
