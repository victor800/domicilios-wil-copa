package com.domicilioswil.shared.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.domicilioswil.shared.model.Farmacia
import com.domicilioswil.shared.ui.theme.Green700
import com.domicilioswil.shared.ui.theme.Outline

expect fun openUrl(url: String)

@Composable
expect fun MapEmbedView(embedUrl: String, modifier: Modifier = Modifier)

@Composable
fun PharmacyCard(farmacia: Farmacia, embedUrl: String) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 16.dp)
            .clip(RoundedCornerShape(28.dp))
            .background(Color.White)
            .border(1.dp, Outline, RoundedCornerShape(28.dp))
    ) {
        MapEmbedView(embedUrl = embedUrl)

        Column(Modifier.padding(16.dp)) {
            Row(
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.SpaceBetween,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.weight(1f)) {
                    Text(farmacia.nombre, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 3.dp)) {
                        Icon(Icons.Default.LocationOn, null, tint = Color.Gray, modifier = Modifier.size(13.dp))
                        Spacer(Modifier.width(3.dp))
                        Text(farmacia.direccion, fontSize = 12.sp, color = Color.Gray)
                    }
                }
                Box(
                    Modifier
                        .size(42.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(Green700.copy(alpha = 0.08f)),
                    contentAlignment = Alignment.Center
                ) {
                    Text(farmacia.icono, fontSize = 20.sp)
                }
            }

            Spacer(Modifier.height(10.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TagChip(text = "Aliada WIL", green = true)
                TagChip(text = farmacia.horario, icon = Icons.Default.Schedule)
                TagChip(text = farmacia.etiqueta)
            }

            Spacer(Modifier.height(14.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { openUrl(farmacia.mapsUrl) },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Green700)
                ) {
                    Icon(Icons.Default.OpenInNew, null, modifier = Modifier.size(15.dp))
                    Spacer(Modifier.width(5.dp))
                    Text("Maps", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                }
                Button(
                    onClick = { openUrl(farmacia.pedidoUrl) },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Green700)
                ) {
                    Icon(Icons.Default.ShoppingCart, null, modifier = Modifier.size(15.dp), tint = Color.White)
                    Spacer(Modifier.width(5.dp))
                    Text("Pedir aquí", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Color.White)
                }
            }
        }
    }
}

@Composable
private fun TagChip(text: String, green: Boolean = false, icon: androidx.compose.ui.graphics.vector.ImageVector? = null) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (green) Green700.copy(alpha = 0.08f) else Color(0xFFF4EDE5))
            .padding(horizontal = 10.dp, vertical = 4.dp)
    ) {
        icon?.let {
            Icon(it, null, modifier = Modifier.size(12.dp), tint = if (green) Green700 else Color.Gray)
            Spacer(Modifier.width(3.dp))
        }
        Text(text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = if (green) Green700 else Color(0xFF3F4946))
    }
}
