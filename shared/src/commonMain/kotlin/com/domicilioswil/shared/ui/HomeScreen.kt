package com.domicilioswil.shared.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.domicilioswil.shared.model.farmaciasWil
import com.domicilioswil.shared.ui.components.OrderSlider
import com.domicilioswil.shared.ui.components.PharmacyCard
import com.domicilioswil.shared.ui.components.openUrl
import com.domicilioswil.shared.ui.theme.*

// URLs de tu web — reemplaza por tu dominio real de Vercel
private const val URL_BASE = "https://domicilios-wil.vercel.app/"
private const val MAP_EMBED_EXPERTOS =
    "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d994.0!2d-75.506191!3d6.34911!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x8e44256a915ed751%3A0x681e80949ed7b12c!2sDROGUERIA%20FARMA%20EXPERTOS!5e0!3m2!1ses!2sco!4v1710000000000!5m2!1ses!2sco"
private const val MAP_EMBED_CENTRAL =
    "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d994.0!2d-75.5073901!3d6.3485472!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x8e44256a5f0a09ef%3A0x77a16509423109b8!2sDroguer%C3%ADa%20Central!5e0!3m2!1ses!2sco!4v1710000000001!5m2!1ses!2sco"

@Composable
fun HomeScreen(onIngresarDomiciliario: () -> Unit) {
    fun abrirWeb(path: String) {
        openUrl(URL_BASE + path)
    }

    Scaffold(
        containerColor = Surface,
        topBar = { WilTopBar() },
        bottomBar = { WilBottomNav(onPedir = { abrirWeb("pedido-wil.html") }, onPoliticas = { abrirWeb("politica.html") }) },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { abrirWeb("pedido-wil.html") },
                containerColor = Lime500,
                shape = RoundedCornerShape(18.dp)
            ) {
                Icon(Icons.Default.Add, contentDescription = "Hacer pedido", tint = Color.White)
            }
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            item { HeroSection() }
            item { CtaSliderSection(onConfirmed = { abrirWeb("pedido-wil.html") }) }
            item { AlliancesHeader() }
            items(farmaciasWil) { farmacia ->
                Box(Modifier.padding(horizontal = 20.dp)) {
                    PharmacyCard(
                        farmacia = farmacia,
                        embedUrl = if (farmacia.nombre.contains("Expertos")) MAP_EMBED_EXPERTOS else MAP_EMBED_CENTRAL
                    )
                }
            }
            item { CorporateAccessSection(onIngresarDomiciliario = onIngresarDomiciliario, onTrabajaConNosotros = { abrirWeb("postulacion.html") }) }
            item { Spacer(Modifier.height(32.dp)) }
        }
    }
}

@Composable
private fun WilTopBar() {
    Box(
        Modifier
            .fillMaxWidth()
            .background(Green700.copy(alpha = 0.92f))
            .padding(horizontal = 20.dp, vertical = 14.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(34.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color.White.copy(alpha = 0.15f)),
                    contentAlignment = Alignment.Center
                ) { Text("🛵", fontSize = 16.sp) }
                Spacer(Modifier.width(10.dp))
                Text(
                    "DOMICILIOS WIL",
                    color = Color.White,
                    fontWeight = FontWeight.Black,
                    fontSize = 14.sp,
                    letterSpacing = 1.sp
                )
            }
            Row {
                IconButton(onClick = { /* notificaciones próximamente */ }) {
                    Icon(Icons.Default.Notifications, null, tint = Color.White.copy(alpha = 0.85f))
                }
                IconButton(onClick = { /* perfil próximamente */ }) {
                    Icon(Icons.Default.AccountCircle, null, tint = Color.White.copy(alpha = 0.85f))
                }
            }
        }
    }
}

@Composable
private fun HeroSection() {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Brush.linearGradient(listOf(Green800, Green600, Green500)))
            .padding(24.dp, 28.dp, 24.dp, 32.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clip(RoundedCornerShape(50))
                .background(Color.White.copy(alpha = 0.12f))
                .padding(horizontal = 12.dp, vertical = 6.dp)
        ) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(Green300))
            Spacer(Modifier.width(6.dp))
            Text("Disponible ahora en Copacabana", color = Color.White.copy(alpha = 0.9f), fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
        }

        Spacer(Modifier.height(16.dp))

        Text(
            buildString { append("Tu entrega\nrápida y segura\nen Copacabana.") },
            color = Color.White,
            fontSize = 28.sp,
            fontWeight = FontWeight.Black,
            lineHeight = 33.sp
        )
        Text(
            "Medicamentos y más, directo a tu puerta.",
            color = Color.White.copy(alpha = 0.7f),
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 10.dp)
        )

        Spacer(Modifier.height(20.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatCard("+500", "Pedidos", Modifier.weight(1f))
            StatCard("~25'", "Tiempo prom.", Modifier.weight(1f))
            StatCard("4.9★", "Calificación", Modifier.weight(1f))
        }
    }
}

@Composable
private fun StatCard(valor: String, etiqueta: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(20.dp))
            .background(Color.White.copy(alpha = 0.1f))
            .padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(valor, color = Green300, fontSize = 18.sp, fontWeight = FontWeight.Black)
        Text(etiqueta, color = Color.White.copy(alpha = 0.6f), fontSize = 10.5.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun CtaSliderSection(onConfirmed: () -> Unit) {
    Column(Modifier.padding(20.dp, 24.dp, 20.dp, 0.dp)) {
        OrderSlider(onConfirmed = onConfirmed)
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 10.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Default.ChatBubble, null, tint = Lime500, modifier = Modifier.size(15.dp))
            Spacer(Modifier.width(5.dp))
            Text("Atención inmediata por chat", fontSize = 12.5.sp, color = OnSurface3, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun AlliancesHeader() {
    Column(Modifier.padding(20.dp, 28.dp, 20.dp, 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Handshake, null, tint = Lime500, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text("Nuestras Alianzas", fontSize = 18.sp, fontWeight = FontWeight.Black, color = Green700)
        }
        Text(
            "Droguerías aliadas en Copacabana, Antioquia",
            fontSize = 13.sp, color = OnSurface3, fontWeight = FontWeight.Medium,
            modifier = Modifier.padding(top = 4.dp)
        )
    }
}

@Composable
private fun CorporateAccessSection(onIngresarDomiciliario: () -> Unit, onTrabajaConNosotros: () -> Unit) {
    Column(Modifier.padding(20.dp, 28.dp, 20.dp, 0.dp)) {
        Text(
            "ACCESOS CORPORATIVOS",
            fontSize = 10.5.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp,
            color = OnSurface3, modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.Center
        )
        Spacer(Modifier.height(14.dp))

        CorporateButton(
            icono = Icons.Default.PedalBike,
            titulo = "Ingresar como Domiciliario",
            subtitulo = "Acceso con clave asignada",
            trailing = Icons.Default.Lock,
            onClick = onIngresarDomiciliario
        )
        Spacer(Modifier.height(8.dp))
        CorporateButton(
            icono = Icons.Default.Work,
            titulo = "Trabaja con Nosotros",
            subtitulo = "Únete al equipo WIL 🛵",
            trailing = Icons.Default.ArrowForwardIos,
            onClick = onTrabajaConNosotros
        )
    }
}

@Composable
private fun CorporateButton(
    icono: androidx.compose.ui.graphics.vector.ImageVector,
    titulo: String,
    subtitulo: String,
    trailing: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(Color.White)
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(38.dp).clip(RoundedCornerShape(12.dp)).background(Green700.copy(alpha = 0.07f)),
                contentAlignment = Alignment.Center
            ) { Icon(icono, null, tint = Green700, modifier = Modifier.size(20.dp)) }
            Spacer(Modifier.width(12.dp))
            Column {
                Text(titulo, fontWeight = FontWeight.SemiBold, fontSize = 13.5.sp)
                Text(subtitulo, fontSize = 11.5.sp, color = OnSurface3, modifier = Modifier.padding(top = 1.dp))
            }
        }
        Icon(trailing, null, tint = OnSurface3, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun WilBottomNav(onPedir: () -> Unit, onPoliticas: () -> Unit) {
    NavigationBar(containerColor = Surface.copy(alpha = 0.95f)) {
        NavigationBarItem(
            selected = true,
            onClick = { /* ya está en Inicio */ },
            icon = { Icon(Icons.Default.Home, null) },
            label = { Text("INICIO", fontSize = 9.sp, fontWeight = FontWeight.Bold) },
            colors = NavigationBarItemDefaults.colors(selectedIconColor = Color.White, selectedTextColor = Green700, indicatorColor = Green700)
        )
        NavigationBarItem(
            selected = false,
            onClick = onPedir,
            icon = { Icon(Icons.Default.ShoppingBag, null) },
            label = { Text("PEDIR", fontSize = 9.sp, fontWeight = FontWeight.Bold) }
        )
        NavigationBarItem(
            selected = false,
            onClick = onPoliticas,
            icon = { Icon(Icons.Default.Policy, null) },
            label = { Text("POLÍTICAS", fontSize = 9.sp, fontWeight = FontWeight.Bold) }
        )
        NavigationBarItem(
            selected = false,
            onClick = onPoliticas,
            icon = { Icon(Icons.Default.AccountCircle, null) },
            label = { Text("PERFIL", fontSize = 9.sp, fontWeight = FontWeight.Bold) }
        )
    }
}
