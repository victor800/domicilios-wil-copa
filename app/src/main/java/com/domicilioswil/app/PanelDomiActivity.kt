package com.domicilioswil.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.*
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.location.Location
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.view.*
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.Animation
import android.view.animation.ScaleAnimation
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import androidx.viewpager2.adapter.FragmentStateAdapter
import com.bumptech.glide.Glide
import com.bumptech.glide.load.resource.bitmap.CircleCrop
import com.google.android.gms.location.*
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.switchmaterial.SwitchMaterial
import com.google.android.material.textfield.TextInputEditText
import com.domicilioswil.app.databinding.ActivityPanelDomiBinding
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap

import org.maplibre.android.maps.Style
import org.maplibre.android.plugins.annotation.LineManager
import org.maplibre.android.plugins.annotation.LineOptions
import org.maplibre.android.plugins.annotation.Symbol
import org.maplibre.android.plugins.annotation.SymbolManager
import org.maplibre.android.plugins.annotation.SymbolOptions
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.*
import org.maplibre.android.maps.MapView;
import org.maplibre.android.camera.CameraPosition;

// ── Globals del tracker sheet ──────────────────────────────────────────────
private var sheetView: View? = null
private var trackerSheet: BottomSheetDialog? = null
private var enviosCount = 0

/* ══════════════════════════════════════════
   MODELO
══════════════════════════════════════════ */
data class PedidoDomi(
    val idPedido:   String,
    val estado:     String,
    val nombre:     String,
    val telefono:   String,
    val direccion:  String,
    val comercio:   String,
    val hora:       String,
    val fecha:      String,
    val total:      Double,
    val domicilio:  Double,
    val metodoPago: String,
    val domiId:     String,
    val domiNombre: String,
    val productos:  String = "",
    val horaToma:   String = ""
)

/* ══════════════════════════════════════════
   ESTADOS
══════════════════════════════════════════ */
object Estados {
    const val PENDIENTE = "pendiente"
    const val EN_RUTA   = "en ruta"
    const val EN_CAMINO = "en camino"
    const val ENTREGADO = "entregado"
    const val CANCELADO = "cancelado"
    const val ASIGNADO  = "asignado"
}

/* ══════════════════════════════════════════
   ACTIVITY PRINCIPAL
══════════════════════════════════════════ */
class PanelDomiActivity : AppCompatActivity() {

    internal lateinit var binding: ActivityPanelDomiBinding

    private lateinit var fusedClient: FusedLocationProviderClient
    private var locationCallback: LocationCallback? = null
    private val PERM_LOCATION = 1001
    var trackerActivo = false
    var tienePedidoEnRuta: Boolean = false

    private val contadores = mutableMapOf(0 to 0, 1 to 0, 2 to 0)

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(this)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            this, "wil_session", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    val domiId     get() = prefs.getString("domi_id",     "") ?: ""
    val domiNombre get() = prefs.getString("domi_nombre", "") ?: ""
    val domiFoto   get() = prefs.getString("domi_foto",   "") ?: ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPanelDomiBinding.inflate(layoutInflater)
        setContentView(binding.root)
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
        configurarHeader()
        configurarBottomNav()
        configurarRefresh()
        configurarFabTracker()
        mostrarFragmento(PedidosTabFragment.newInstance("Pendiente"), 0)
    }

    private fun configurarHeader() {
        val primerNombre = domiNombre.trim().split(" ").firstOrNull() ?: domiNombre
        binding.tvNombreDomi.text = primerNombre.ifBlank { "Domiciliario" }
        val fotoUrl = domiFoto
        if (fotoUrl.isNotBlank()) {
            Glide.with(this).load(fotoUrl).transform(CircleCrop())
                .placeholder(R.drawable.ic_logo_wil)
                .error(generarBitmapIniciales(domiNombre))
                .into(binding.imgAvatar)
        } else {
            binding.imgAvatar.setImageBitmap(generarBitmapIniciales(domiNombre))
        }
    }

    private fun configurarFabTracker() {
        binding.fabTracker.setOnClickListener { mostrarTrackerSheet() }
        actualizarFabEstado(trackerActivo)
    }

    private fun actualizarFabEstado(activo: Boolean) {
        if (activo) {
            binding.fabTracker.backgroundTintList =
                android.content.res.ColorStateList.valueOf(Color.parseColor("#0F766E"))
            binding.fabTracker.imageTintList =
                android.content.res.ColorStateList.valueOf(Color.WHITE)
            binding.fabTracker.setImageResource(R.drawable.ic_location_on)
            animarFabPulso(true)
        } else {
            binding.fabTracker.backgroundTintList =
                android.content.res.ColorStateList.valueOf(Color.parseColor("#1E293B"))
            binding.fabTracker.imageTintList =
                android.content.res.ColorStateList.valueOf(Color.parseColor("#64748B"))
            binding.fabTracker.setImageResource(R.drawable.ic_location_off)
            animarFabPulso(false)
        }
    }

    private fun animarFabPulso(activo: Boolean) {
        binding.fabTracker.clearAnimation()
        if (activo) {
            val anim = ScaleAnimation(
                1f, 1.08f, 1f, 1.08f,
                Animation.RELATIVE_TO_SELF, 0.5f,
                Animation.RELATIVE_TO_SELF, 0.5f
            ).apply {
                duration = 800; repeatMode = Animation.REVERSE
                repeatCount = Animation.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
            }
            binding.fabTracker.startAnimation(anim)
        }
    }

    private fun mostrarTrackerSheet() {
        val sheet = BottomSheetDialog(this)
        val v = layoutInflater.inflate(R.layout.bottom_sheet_tracker, null)
        sheetView = v

        val switchTracker  = v.findViewById<SwitchMaterial>(R.id.switchTracker)
        val tvEnvios       = v.findViewById<TextView>(R.id.tvEnviosCount)
        val switchThumbAct = android.content.res.ColorStateList.valueOf(Color.parseColor("#0D9488"))
        val switchTrackAct = android.content.res.ColorStateList.valueOf(Color.parseColor("#134E4A"))
        val switchThumbIn  = android.content.res.ColorStateList.valueOf(Color.parseColor("#475569"))
        val switchTrackIn  = android.content.res.ColorStateList.valueOf(Color.parseColor("#1E293B"))

        switchTracker.isChecked = trackerActivo
        actualizarUIEstadoSheet(v, trackerActivo)
        tvEnvios.text = enviosCount.toString()

        switchTracker.thumbTintList = if (trackerActivo) switchThumbAct else switchThumbIn
        switchTracker.trackTintList = if (trackerActivo) switchTrackAct else switchTrackIn

        switchTracker.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) iniciarTracker() else detenerTracker()
            actualizarUIEstadoSheet(v, isChecked)
            switchTracker.thumbTintList = if (isChecked) switchThumbAct else switchThumbIn
            switchTracker.trackTintList = if (isChecked) switchTrackAct else switchTrackIn
        }

        sheet.setOnDismissListener { sheetView = null }
        sheet.setContentView(v)
        sheet.show()
        trackerSheet = sheet
    }

    private fun actualizarUIEstadoSheet(v: View, activo: Boolean) {
        val tvEstado = v.findViewById<TextView>(R.id.tvTrackerEstado)
        val tvSub    = v.findViewById<TextView>(R.id.tvTrackerSub)
        val tvIcono  = v.findViewById<TextView>(R.id.tvTrackerIcono)
        if (activo) {
            tvEstado.text = "Tracker activo ✅"; tvEstado.setTextColor(Color.parseColor("#4ADE80"))
            tvSub.text    = "Enviando posición cada 10 seg."; tvSub.setTextColor(Color.parseColor("#86EFAC"))
            tvIcono.text  = "📡"
        } else {
            tvEstado.text = "Tracker inactivo"; tvEstado.setTextColor(Color.parseColor("#CBD5E1"))
            tvSub.text    = "Activa para enviar tu posición"; tvSub.setTextColor(Color.parseColor("#64748B"))
            tvIcono.text  = "📍"
        }
    }

    private fun generarBitmapIniciales(nombre: String): Bitmap {
        val size = 128
        val bmp  = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f,
            Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#007A76") })
        val iniciales = nombre.trim().split(" ")
            .take(2).joinToString("") { it.firstOrNull()?.uppercase() ?: "" }
        val paintTxt = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; textSize = 46f
            textAlign = Paint.Align.CENTER; isFakeBoldText = true
        }
        canvas.drawText(iniciales, size / 2f,
            size / 2f - (paintTxt.descent() + paintTxt.ascent()) / 2f, paintTxt)
        return bmp
    }

    private var currentTabIndex = 0

    private fun configurarBottomNav() {
        binding.bottomNav.setOnItemSelectedListener { item ->
            val (frag, idx) = when (item.itemId) {
                R.id.navPendientes -> PedidosTabFragment.newInstance("Pendiente") to 0
                R.id.navEnRuta     -> EnRutaFragment()    to 1
                R.id.navHistorial  -> HistorialFragment() to 2
                R.id.navPerfil     -> PerfilFragment()    to 3
                else               -> return@setOnItemSelectedListener false
            }
            currentTabIndex = idx
            mostrarFragmento(frag, idx)
            true
        }
        binding.bottomNav.selectedItemId = R.id.navPendientes
    }

    fun navegarAEnRuta() { binding.bottomNav.selectedItemId = R.id.navEnRuta }

    private fun mostrarFragmento(frag: Fragment, idx: Int) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, frag).commit()
    }

    fun actualizarBadge(tabIdx: Int, count: Int) {
        val menuId = when (tabIdx) { 0 -> R.id.navPendientes; 1 -> R.id.navEnRuta; 2 -> R.id.navHistorial; else -> return }
        val badge  = binding.bottomNav.getOrCreateBadge(menuId)
        when (tabIdx) {
            0 -> if (count > 0) { badge.isVisible = true; badge.number = count; badge.backgroundColor = Color.parseColor("#DC2626"); badge.badgeTextColor = Color.WHITE } else { badge.isVisible = false }
            1 -> if (tienePedidoEnRuta) { badge.isVisible = true; badge.number = 1; badge.backgroundColor = Color.parseColor("#2563EB"); badge.badgeTextColor = Color.WHITE } else { badge.isVisible = false }
            2 -> if (count > 0) { badge.isVisible = true; badge.number = count; badge.backgroundColor = Color.parseColor("#16A34A"); badge.badgeTextColor = Color.WHITE } else { badge.isVisible = false }
        }
        contadores[tabIdx] = count
    }

    private fun configurarRefresh() {
        binding.btnRefresh.setOnClickListener {
            supportFragmentManager.fragments.filterIsInstance<PedidosTabFragment>()
                .firstOrNull()?.cargarPedidos()
        }
    }

    fun iniciarTracker() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                PERM_LOCATION)
            return
        }
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10_000L)
            .setMinUpdateIntervalMillis(8_000L).build()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { loc ->
                    enviarUbicacion(loc)
                    actualizarSheetConCoordenadas(loc)
                }
            }
        }
        fusedClient.requestLocationUpdates(request, locationCallback!!, Looper.getMainLooper())
        trackerActivo = true
        actualizarFabEstado(true)
    }

    fun detenerTracker() {
        locationCallback?.let { fusedClient.removeLocationUpdates(it) }
        trackerActivo = false
        actualizarFabEstado(false)
    }

    private fun actualizarSheetConCoordenadas(loc: Location) {
        val v = sheetView ?: return
        if (!v.isAttachedToWindow) { sheetView = null; return }
        enviosCount++
        val tvEnvios    = v.findViewById<TextView>(R.id.tvEnviosCount)
        val tvCoord     = v.findViewById<TextView>(R.id.tvUltimaCoord)
        val tvPrecision = v.findViewById<TextView>(R.id.tvPrecision)
        val layoutLog   = v.findViewById<LinearLayout>(R.id.layoutLog)
        tvEnvios.text  = enviosCount.toString()
        tvCoord.text   = "${"%.5f".format(loc.latitude)}\n${"%.5f".format(loc.longitude)}"
        tvPrecision.text = if (loc.accuracy > 0) "${"%.0f".format(loc.accuracy)}m" else "–"
        val colorPrec = when {
            loc.accuracy <= 10f -> "#4ADE80"
            loc.accuracy <= 30f -> "#FACC15"
            else                -> "#F87171"
        }
        tvPrecision.setTextColor(Color.parseColor(colorPrec))
        val hora = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        val logLine = TextView(this).apply {
            text = "✅  $hora  →  ${"%.4f".format(loc.latitude)}, ${"%.4f".format(loc.longitude)}"
            textSize = 10.5f; setTextColor(Color.parseColor("#4ADE80"))
            typeface = Typeface.MONOSPACE; setPadding(0, 3, 0, 3)
        }
        layoutLog.addView(logLine, 0)
        if (layoutLog.childCount > 20) layoutLog.removeViewAt(layoutLog.childCount - 1)
        flashFab()
    }

    private fun flashFab() {
        val colorFlash  = android.content.res.ColorStateList.valueOf(Color.parseColor("#059669"))
        val colorNormal = android.content.res.ColorStateList.valueOf(Color.parseColor("#0F766E"))
        binding.fabTracker.backgroundTintList = colorFlash
        Handler(Looper.getMainLooper()).postDelayed({
            if (trackerActivo) binding.fabTracker.backgroundTintList = colorNormal
        }, 400)
    }

    private fun enviarUbicacion(loc: Location) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val body = JSONObject().apply {
                    put("domiId", domiId); put("lat", loc.latitude); put("lng", loc.longitude)
                }.toString()
                val conn = java.net.URL("https://domicilios-wil.vercel.app/api/foto?recurso=ubicacion-domi")
                    .openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "PATCH"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.outputStream.write(body.toByteArray())
                conn.responseCode; conn.disconnect()
            } catch (_: Exception) {}
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_LOCATION && grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
            iniciarTracker()
    }

    override fun onDestroy() { super.onDestroy(); detenerTracker() }
}

/* ══════════════════════════════════════════
   PAGER ADAPTER
══════════════════════════════════════════ */
class PanelPagerAdapter(fa: FragmentActivity) : FragmentStateAdapter(fa) {
    override fun getItemCount() = 4
    override fun createFragment(position: Int): Fragment = when (position) {
        0    -> PedidosTabFragment.newInstance("Pendiente")
        1    -> PedidosTabFragment.newInstance("En ruta")
        2    -> PedidosTabFragment.newInstance("Historial")
        else -> PerfilFragment()
    }
}

/* ══════════════════════════════════════════
   FRAGMENT PEDIDOS
══════════════════════════════════════════ */
class PedidosTabFragment : Fragment() {

    private var estadoFiltro = "Pendiente"
    private val handler = Handler(Looper.getMainLooper())
    private val scope   = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private lateinit var adapter: PedidosAdapter
    private val INTERVALO = 10_000L

    companion object {
        fun newInstance(estado: String) = PedidosTabFragment().apply {
            arguments = Bundle().apply { putString("estado", estado) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        estadoFiltro = arguments?.getString("estado") ?: "Pendiente"
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_pedidos_tab, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val act = activity as? PanelDomiActivity ?: return
        adapter = PedidosAdapter(
            estadoFiltro  = estadoFiltro,
            domiId        = act.domiId,
            onTomarPedido = { pedido -> mostrarBottomSheetTomar(pedido) },
            onVerDetalle  = { pedido -> verDetalle(pedido) }
        )
        val rv = view.findViewById<RecyclerView>(R.id.rvPedidos)
        rv.layoutManager = LinearLayoutManager(requireContext())
        rv.adapter = adapter; rv.setHasFixedSize(false)
        view.findViewById<View?>(R.id.cardTracker)?.visibility = View.GONE
        view.findViewById<TextView>(R.id.tvEmptySub).text = when (estadoFiltro) {
            "Pendiente" -> "Estás en línea. Los nuevos pedidos aparecen cada 10 seg."
            "En ruta"   -> "No tienes pedidos en camino ahora."
            "Historial" -> "Sin pedidos entregados aún."
            else        -> ""
        }
        cargarPedidos(); iniciarPolling()
    }

    override fun onDestroyView() { super.onDestroyView(); detenerPolling(); scope.cancel() }

    private val pollingRunnable = object : Runnable {
        override fun run() { cargarPedidos(); handler.postDelayed(this, INTERVALO) }
    }
    private fun iniciarPolling() { handler.postDelayed(pollingRunnable, INTERVALO) }
    private fun detenerPolling() { handler.removeCallbacks(pollingRunnable) }

    fun cargarPedidos() {
        val view        = view ?: return
        val progress    = view.findViewById<ProgressBar>(R.id.progressPedidos)
        val rvPedidos   = view.findViewById<RecyclerView>(R.id.rvPedidos)
        val layoutEmpty = view.findViewById<View>(R.id.layoutEmpty)
        val act         = activity as? PanelDomiActivity ?: return

        progress.visibility = View.VISIBLE; rvPedidos.visibility = View.GONE; layoutEmpty.visibility = View.GONE

        scope.launch {
            try {
                val estadoQuery = when (estadoFiltro) { "En ruta" -> "en ruta,en camino"; "Historial" -> "entregado"; else -> "pendiente" }
                val domiParam   = if (estadoFiltro == "En ruta") "&domiId=${act.domiId}" else ""
                val url = "https://domicilios-wil.vercel.app/api/foto?recurso=pedidos&estado=${estadoQuery}&limit=50$domiParam"
                val response = withContext(Dispatchers.IO) {
                    val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 10_000; conn.readTimeout = 10_000
                    conn.inputStream.bufferedReader().readText().also { conn.disconnect() }
                }
                val data  = JSONObject(response).optJSONArray("data") ?: JSONArray()
                val lista = mutableListOf<PedidoDomi>()
                for (i in 0 until data.length()) {
                    val p = data.getJSONObject(i)
                    if (estadoFiltro == "En ruta") {
                        val pedidoDomiId = p.optString("domiciliarioId", "")
                        if (pedidoDomiId.isBlank() || pedidoDomiId != act.domiId) continue
                    }
                    val itemsArr = p.optJSONArray("items")
                    val productosTexto = buildString {
                        if (itemsArr != null) for (j in 0 until itemsArr.length()) {
                            val it = itemsArr.getJSONObject(j)
                            appendLine("• ${it.optString("producto")} x${it.optInt("cantidad")} — $${it.optDouble("subtotal").toLong()}")
                        }
                    }.trim()
                    lista.add(PedidoDomi(
                        idPedido   = p.optString("idPedido",   "–"),
                        estado     = p.optString("estado",     "pendiente"),
                        nombre     = p.optString("nombre",     "–"),
                        telefono   = p.optString("telefono",   ""),
                        direccion  = p.optString("direccion",  "–"),
                        comercio   = p.optString("comercio",   "–"),
                        hora       = p.optString("hora",       ""),
                        fecha      = p.optString("fecha",      ""),
                        total      = p.optDouble("total",      0.0),
                        domicilio  = p.optDouble("domicilio",  0.0),
                        metodoPago = p.optString("metodoPago", ""),
                        domiId     = p.optString("domiciliarioId",     ""),
                        domiNombre = p.optString("domiciliarioNombre", ""),
                        productos  = productosTexto,
                        horaToma   = p.optString("horaToma", "")
                    ))
                }
                progress.visibility = View.GONE
                if (lista.isEmpty()) {
                    rvPedidos.visibility = View.GONE; layoutEmpty.visibility = View.VISIBLE
                    act.actualizarBadge(when (estadoFiltro) { "En ruta" -> 1; "Historial" -> 2; else -> 0 }, 0)
                } else {
                    adapter.submitList(lista); rvPedidos.visibility = View.VISIBLE; layoutEmpty.visibility = View.GONE
                    act.actualizarBadge(when (estadoFiltro) { "En ruta" -> 1; "Historial" -> 2; else -> 0 }, lista.size)
                }
            } catch (_: Exception) {
                view.findViewById<ProgressBar>(R.id.progressPedidos).visibility = View.GONE
                if (adapter.itemCount == 0) view.findViewById<View>(R.id.layoutEmpty).visibility = View.VISIBLE
            }
        }
    }

    private fun mostrarBottomSheetTomar(pedido: PedidoDomi) {
        val ctx = context ?: return
        val fmt = NumberFormat.getNumberInstance(Locale("es", "CO"))
        val act = activity as? PanelDomiActivity ?: return
        if (act.tienePedidoEnRuta) {
            Toast.makeText(ctx, "⚠️ Debes entregar tu pedido actual antes de tomar otro.", Toast.LENGTH_LONG).show()
            return
        }
        val sheet = BottomSheetDialog(ctx)
        val v = LayoutInflater.from(ctx).inflate(R.layout.bottom_sheet_detalle_pedido, null)
        v.findViewById<TextView>(R.id.bsIdPedido).text   = "#${pedido.idPedido}"
        v.findViewById<TextView>(R.id.bsEstado).text     = pedido.estado
        v.findViewById<TextView>(R.id.bsNombre).text     = pedido.nombre
        v.findViewById<TextView>(R.id.bsDireccion).text  = pedido.direccion
        v.findViewById<View>(R.id.btnAbrirMaps).setOnClickListener {
            val uri = android.net.Uri.parse("geo:0,0?q=${android.net.Uri.encode(pedido.direccion)}")
            val intent = Intent(Intent.ACTION_VIEW, uri).apply { setPackage("com.google.android.apps.maps") }
            if (intent.resolveActivity(requireActivity().packageManager) != null) startActivity(intent)
            else startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://maps.google.com/?q=${android.net.Uri.encode(pedido.direccion)}")))
        }
        v.findViewById<TextView>(R.id.bsComercio).text   = pedido.comercio
        v.findViewById<TextView>(R.id.bsHora).text       = "${pedido.hora} ${pedido.fecha}"
        v.findViewById<TextView>(R.id.bsTotal).text      = "$ ${fmt.format(pedido.total.toLong())}"
        v.findViewById<TextView>(R.id.bsDomicilio).text  = "$ ${fmt.format(pedido.domicilio.toLong())}"
        v.findViewById<TextView>(R.id.bsMetodoPago).text = pedido.metodoPago
        aplicarColorEstado(v.findViewById(R.id.bsEstado), pedido.estado)
        if (pedido.productos.isNotBlank()) poblarProductosSheet(v, pedido.productos, ctx)
        val btnLlamar = v.findViewById<Button>(R.id.bsBtnLlamar)
        if (pedido.telefono.isNotBlank()) {
            btnLlamar.visibility = View.VISIBLE
            btnLlamar.setOnClickListener { startActivity(Intent(Intent.ACTION_DIAL, android.net.Uri.parse("tel:${pedido.telefono}"))) }
        }
        v.findViewById<Button>(R.id.bsBtnCerrar).apply {
            text = "🛵 Tomar pedido"
            setOnClickListener { sheet.dismiss(); confirmarTomar(pedido, act) }
        }
        sheet.setContentView(v); sheet.show()
    }

    private fun confirmarTomar(pedido: PedidoDomi, act: PanelDomiActivity) {
        if (act.tienePedidoEnRuta) {
            Toast.makeText(act, "⚠️ Ya tienes un pedido en ruta. Entrégalo primero.", Toast.LENGTH_LONG).show(); return
        }
        scope.launch {
            try {
                val horaToma = SimpleDateFormat("hh:mm a", Locale("es", "CO")).format(Date())
                val body = JSONObject().apply {
                    put("pedidoId", pedido.idPedido); put("estado", Estados.EN_RUTA)
                    put("domiciliarioId", act.domiId); put("domiciliarioNombre", act.domiNombre)
                    put("horaToma", horaToma)
                }.toString()
                withContext(Dispatchers.IO) {
                    val conn = java.net.URL("https://domicilios-wil.vercel.app/api/foto?recurso=estado")
                        .openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "PATCH"; conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true; conn.outputStream.write(body.toByteArray()); conn.responseCode; conn.disconnect()
                }
                act.tienePedidoEnRuta = true; act.iniciarTracker()
                act.runOnUiThread { act.actualizarBadge(1, 1); act.navegarAEnRuta() }
            } catch (_: Exception) {
                act.runOnUiThread { Toast.makeText(act, "Error al tomar el pedido", Toast.LENGTH_SHORT).show() }
            }
        }
    }

    private fun verDetalle(pedido: PedidoDomi) {
        val ctx = context ?: return
        val fmt = NumberFormat.getNumberInstance(Locale("es", "CO"))
        val sheet = BottomSheetDialog(ctx)
        val v = LayoutInflater.from(ctx).inflate(R.layout.bottom_sheet_detalle_pedido, null)
        v.findViewById<TextView>(R.id.bsIdPedido).text   = "#${pedido.idPedido}"
        v.findViewById<TextView>(R.id.bsEstado).text     = pedido.estado
        v.findViewById<TextView>(R.id.bsNombre).text     = pedido.nombre
        v.findViewById<TextView>(R.id.bsDireccion).text  = pedido.direccion
        v.findViewById<View>(R.id.btnAbrirMaps).setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://maps.google.com/?q=${android.net.Uri.encode(pedido.direccion)}")))
        }
        v.findViewById<TextView>(R.id.bsComercio).text   = pedido.comercio
        v.findViewById<TextView>(R.id.bsHora).text       = if (pedido.horaToma.isNotBlank())
            "${pedido.hora} ${pedido.fecha}  •  tomado: ${pedido.horaToma}" else "${pedido.hora} ${pedido.fecha}"
        v.findViewById<TextView>(R.id.bsTotal).text      = "$ ${fmt.format(pedido.total.toLong())}"
        v.findViewById<TextView>(R.id.bsDomicilio).text  = "$ ${fmt.format(pedido.domicilio.toLong())}"
        v.findViewById<TextView>(R.id.bsMetodoPago).text = pedido.metodoPago
        aplicarColorEstado(v.findViewById(R.id.bsEstado), pedido.estado)
        if (pedido.productos.isNotBlank()) poblarProductosSheet(v, pedido.productos, ctx)
        val btnLlamar = v.findViewById<Button>(R.id.bsBtnLlamar)
        if (pedido.telefono.isNotBlank()) {
            btnLlamar.visibility = View.VISIBLE
            btnLlamar.setOnClickListener { startActivity(Intent(Intent.ACTION_DIAL, android.net.Uri.parse("tel:${pedido.telefono}"))) }
        }
        v.findViewById<Button>(R.id.bsBtnCerrar).setOnClickListener { sheet.dismiss() }
        sheet.setContentView(v); sheet.show()
    }

    private fun poblarProductosSheet(v: View, productos: String, ctx: android.content.Context) {
        v.findViewById<View>(R.id.bsProductosLabel).visibility = View.VISIBLE
        v.findViewById<View>(R.id.bsTicketContainer).visibility = View.VISIBLE
        val rows = v.findViewById<LinearLayout>(R.id.bsProductosRows)
        rows.removeAllViews()
        productos.lines().filter { it.isNotBlank() }.forEach { linea ->
            val fila = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 4 }
            }
            fila.addView(TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = linea.removePrefix("• ").substringBefore(" —").trim()
                textSize = 11f; typeface = Typeface.MONOSPACE; setTextColor(Color.parseColor("#3F4946"))
            })
            fila.addView(TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                text = linea.substringAfter("—").trim()
                textSize = 11f; typeface = Typeface.MONOSPACE; setTextColor(Color.parseColor("#3F4946"))
            })
            rows.addView(fila)
        }
    }

    private fun aplicarColorEstado(tv: TextView, estado: String) {
        val (colorTxt, colorBg) = when (estado.lowercase().trim()) {
            Estados.PENDIENTE -> "#D97706" to "#FEF3C7"
            Estados.ASIGNADO  -> "#7C3AED" to "#EDE9FE"
            Estados.EN_RUTA, Estados.EN_CAMINO, "proceso", "encamino" -> "#2563EB" to "#DBEAFE"
            Estados.ENTREGADO -> "#16A34A" to "#DCFCE7"
            Estados.CANCELADO -> "#DC2626" to "#FEE2E2"
            else              -> "#D97706" to "#FEF3C7"
        }
        tv.setTextColor(Color.parseColor(colorTxt))
        tv.backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor(colorBg))
    }
}

/* ══════════════════════════════════════════
   ADAPTER RECYCLER
══════════════════════════════════════════ */
class PedidosAdapter(
    private val estadoFiltro:  String,
    private val domiId:        String,
    private val onTomarPedido: (PedidoDomi) -> Unit,
    private val onVerDetalle:  (PedidoDomi) -> Unit
) : RecyclerView.Adapter<PedidosAdapter.VH>() {

    private val items = mutableListOf<PedidoDomi>()
    private val fmt   = NumberFormat.getNumberInstance(Locale("es", "CO"))

    fun submitList(list: List<PedidoDomi>) { items.clear(); items.addAll(list); notifyDataSetChanged() }

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        val tvId       = v.findViewById<TextView>(R.id.tvIdPedido)
        val tvEstado   = v.findViewById<TextView>(R.id.tvEstado)
        val tvCliente  = v.findViewById<TextView>(R.id.tvCliente)
        val tvDirec    = v.findViewById<TextView>(R.id.tvDireccion)
        val tvComercio = v.findViewById<TextView>(R.id.tvComercio)
        val tvHora     = v.findViewById<TextView>(R.id.tvHora)
        val tvTotal    = v.findViewById<TextView>(R.id.tvTotal)
        val btnDetalle = v.findViewById<Button>(R.id.btnVerDetalle)
        val btnTomar   = v.findViewById<Button>(R.id.btnTomarPedido)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(LayoutInflater.from(parent.context).inflate(R.layout.item_pedido_domi, parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(h: VH, pos: Int) {
        val p = items[pos]
        h.tvId.text = "#${p.idPedido}"; h.tvEstado.text = p.estado; h.tvCliente.text = p.nombre
        h.tvDirec.text = p.direccion; h.tvComercio.text = p.comercio; h.tvHora.text = p.hora
        h.tvTotal.text = "$ ${fmt.format(p.total.toLong())}"
        val (colorTxt, colorBg) = when (p.estado.lowercase().trim()) {
            Estados.PENDIENTE -> "#D97706" to "#FEF3C7"; Estados.ASIGNADO -> "#7C3AED" to "#EDE9FE"
            Estados.EN_RUTA, Estados.EN_CAMINO, "proceso", "encamino" -> "#2563EB" to "#DBEAFE"
            Estados.ENTREGADO -> "#16A34A" to "#DCFCE7"; Estados.CANCELADO -> "#DC2626" to "#FEE2E2"
            else -> "#D97706" to "#FEF3C7"
        }
        h.tvEstado.setTextColor(Color.parseColor(colorTxt))
        h.tvEstado.backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor(colorBg))
        if (estadoFiltro == "Pendiente") {
            h.btnTomar.visibility = View.VISIBLE; h.btnTomar.stateListAnimator = null
            h.btnTomar.setOnClickListener { onTomarPedido(p) }
        } else { h.btnTomar.visibility = View.GONE }
        h.btnDetalle.setOnClickListener { onVerDetalle(p) }
    }
}

/* ══════════════════════════════════════════
   FRAGMENT EN RUTA
══════════════════════════════════════════ */
class EnRutaFragment : Fragment() {

    companion object {
        private const val TAG = "EnRuta"
        private const val STYLE_URL_PRIMARY  = "https://tiles.openfreemap.org/styles/liberty"
        private const val STYLE_URL_FALLBACK = "https://demotiles.maplibre.org/style.json"
        private const val TRACKING_INTERVAL_MS = 8_000L
        private const val BASE_LAT = 6.3460765
        private const val BASE_LNG = -75.5083194
        private const val ICON_DOMI_BASE = "icon-domi-base"
        private const val ICON_DOMI_LIVE = "icon-domi-live"
        private const val ICON_DESTINO   = "icon-destino"
        private const val PULSE_INTERVAL_MS = 600L
        private const val PULSE_PHASES      = 4

        // ── Cronómetro: cada 15 minutos = $2.000 ──
        private const val INTERVALO_TARDANZA_SEG = 15 * 60L  // 900 segundos
        private const val COSTO_POR_INTERVALO    = 2_000
    }

    private var vistaActiva     = false
    private var mapaDestruido   = false
    private var intentoFallback = false
    private var mapaListo = false

    private var ticksSinActualizarEta = 0
    private val FORZAR_ETA_CADA_N_TICKS = 3

    private val handler = Handler(Looper.getMainLooper())
    private val fmt     = NumberFormat.getNumberInstance(Locale("es", "CO"))

    private var pedidoActivo: PedidoDomi? = null
    private var horaEnRuta:   String = ""
    private var horaEnCamino: String = ""

    private lateinit var mapView: MapView
    private var mapLibreMap: MapLibreMap? = null
    private var lineManager:   LineManager?   = null
    private var symbolManager: SymbolManager? = null

    private var mapaCoordsPendientes: Pair<Double, Double>? = null
    private var mapaOrigPendiente:    Pair<Double, Double>? = null
    private var trackingJob: Job? = null

    private var lastDomiLat = BASE_LAT
    private var lastDomiLng = BASE_LNG
    private var gpsActivo   = false

    private var symbolDomi: Symbol? = null
    private var symbolDest: Symbol? = null

    private var pulsePhase = 0
    private val pulseRunnable = object : Runnable {
        override fun run() {
            if (!vistaActiva || mapaDestruido || gpsActivo) return
            pulsePhase = (pulsePhase + 1) % PULSE_PHASES
            animarPulso()
            handler.postDelayed(this, PULSE_INTERVAL_MS)
        }
    }

    // ── Cronómetro de tardanza ─────────────────────────────────────────────
    private var cronometroActivo  = false
    private var segundosTardanza  = 0L
    private var intervalosGuardados = 0
    private val cronometroRunnable = object : Runnable {
        override fun run() {
            if (!cronometroActivo) return
            segundosTardanza++
            actualizarCronometroUI()

            val intervalosActuales = (segundosTardanza / INTERVALO_TARDANZA_SEG).toInt()
            if (intervalosActuales > intervalosGuardados) {
                intervalosGuardados = intervalosActuales
                cronometroActivo = false
                handler.removeCallbacks(this)
                val costoActual = intervalosGuardados * COSTO_POR_INTERVALO
                actualizarBtnCronometro(activo = false)
                layoutCronometro.visibility = View.VISIBLE
                actualizarCronometroUI()

                val nota = if (::etNotaTardanza.isInitialized)
                    etNotaTardanza.text?.toString()?.trim() ?: "" else ""
                pedidoActivo?.let { pedido ->
                    guardarTiempoExtraInmediato(
                        pedido     = pedido,
                        segundos   = segundosTardanza,
                        costo      = costoActual,
                        intervalos = intervalosGuardados,
                        nota       = nota
                    )
                }

                Toast.makeText(
                    requireContext(),
                    "⏱ 15 min cumplidos — +$${fmt.format(costoActual)} guardado ✅",
                    Toast.LENGTH_LONG
                ).show()
                return
            }
            handler.postDelayed(this, 1000L)
        }
    }

    private val fotosFacturas  = mutableListOf<String>()
    private val fotosTardanza  = mutableListOf<String>()
    private var modoFotoActual = "factura"
    private var uriCamaraTemp: Uri? = null

    private var ultimaDurSeg:        Long   = -1L
    private var ultimaDistM:         Double = 0.0
    private var distInicialEnRuta:   Double = 0.0
    private var distInicialEnCamino: Double = 0.0

    // ── Views ──────────────────────────────────────────────────────────────
    private lateinit var tvNombreCliente:       TextView
    private lateinit var tvEstadoBadge:         TextView
    private lateinit var tvCronometro:          TextView
    private lateinit var tvCostoExtra:          TextView
    private lateinit var tvEta:                 TextView
    private lateinit var btnAccionPrincipal:    com.google.android.material.button.MaterialButton
    private lateinit var btnVerDetalle:         com.google.android.material.button.MaterialButton
    private lateinit var btnAgregarFactura:     com.google.android.material.button.MaterialButton
    private lateinit var btnAgregarTardanza:    com.google.android.material.button.MaterialButton
    private lateinit var btnGuardarFactura:     com.google.android.material.button.MaterialButton
    private lateinit var btnGuardarTardanza:    com.google.android.material.button.MaterialButton
    private lateinit var btnNavegar:            com.google.android.material.button.MaterialButton
    private lateinit var btnZoomIn:             com.google.android.material.button.MaterialButton
    private lateinit var btnZoomOut:            com.google.android.material.button.MaterialButton
    private lateinit var btnMiUbicacion:        com.google.android.material.button.MaterialButton
    // ── FIX: una sola declaración lateinit var en lugar de dos val con get() ──
    private lateinit var btnCronometro:         com.google.android.material.button.MaterialButton
    private lateinit var tvZoomLevel:           TextView
    private lateinit var chipGroupFacturas:     ChipGroup
    private lateinit var chipGroupTardanza:     ChipGroup
    private lateinit var layoutCronometro:      View
    private lateinit var progressBar:           ProgressBar
    private lateinit var layoutVacio:           View
    private lateinit var layoutContenido:       View
    private lateinit var switchFacturas:        SwitchMaterial
    private lateinit var switchTardanza:        SwitchMaterial
    private lateinit var layoutFacturasContent: View
    private lateinit var layoutTardanzaContent: View
    private lateinit var etNotaTardanza:        TextInputEditText
    private lateinit var etValorFactura:        TextInputEditText
    private lateinit var progressEta:           ProgressBar
    private lateinit var tvEtaProgreso:         TextView

    private lateinit var btnStep0:        ImageButton
    private lateinit var btnStep1:        ImageButton
    private lateinit var btnStep2:        ImageButton
    private lateinit var tvStepEnRuta:    TextView
    private lateinit var tvStepEnCamino:  TextView
    private lateinit var tvStepEntregado: TextView
    private lateinit var tvHoraEnRuta:    TextView
    private lateinit var tvHoraEnCamino:  TextView
    private lateinit var tvHoraEntregado: TextView
    private lateinit var progressConector01: ProgressBar
    private lateinit var progressConector12: ProgressBar
    private lateinit var radarRing0a: View
    private lateinit var radarRing0b: View
    private lateinit var radarRing1a: View
    private lateinit var radarRing1b: View
    private lateinit var radarRing2a: View
    private lateinit var radarRing2b: View

    private val launcherGaleria = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) result.data?.data?.let { uri -> uriABase64(uri)?.let { agregarFotoB64(it) } }
    }
    private val launcherCamara = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (ok) uriCamaraTemp?.let { uri -> uriABase64(uri)?.let { agregarFotoB64(it) } }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        MapLibre.getInstance(requireContext())
        return inflater.inflate(R.layout.fragment_en_ruta, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        vistaActiva = true; mapaDestruido = false; intentoFallback = false; mapaListo = false
        ticksSinActualizarEta = 0
        bindViews(view)
        iniciarMapView(savedInstanceState)
        configurarBotones()
        configurarToggles()
        cargarPedidoActivo()
    }

    override fun onStart()     { super.onStart();     mapView.onStart() }
    override fun onResume()    { super.onResume();    mapView.onResume() }
    override fun onPause()     { super.onPause();     mapView.onPause() }
    override fun onStop()      { super.onStop();      mapView.onStop() }
    override fun onLowMemory() { super.onLowMemory(); mapView.onLowMemory() }

    override fun onDestroyView() {
        vistaActiva = false; mapaDestruido = true; mapaListo = false
        detenerCronometro(); detenerTracking()
        handler.removeCallbacksAndMessages(null)
        try { lineManager?.onDestroy()   } catch (e: Exception) { Log.w(TAG, e.message ?: "") }
        try { symbolManager?.onDestroy() } catch (e: Exception) { Log.w(TAG, e.message ?: "") }
        lineManager = null; symbolManager = null; symbolDomi = null; symbolDest = null
        try { mapLibreMap?.setStyle(Style.Builder().fromUri("")) { } } catch (_: Exception) { }
        mapLibreMap = null
        super.onDestroyView()
        try { mapView.onDestroy() } catch (_: Exception) { }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (vistaActiva) mapView.onSaveInstanceState(outState)
    }

    private fun bindViews(v: View) {
        mapView               = v.findViewById(R.id.mapView)
        tvNombreCliente       = v.findViewById(R.id.tvNombreCliente)
        tvEstadoBadge         = v.findViewById(R.id.tvEstadoBadge)
        tvCronometro          = v.findViewById(R.id.tvCronometro)
        tvCostoExtra          = v.findViewById(R.id.tvCostoExtra)
        tvEta                 = v.findViewById(R.id.tvEta)
        btnAccionPrincipal    = v.findViewById(R.id.btnAccionPrincipal)
        btnVerDetalle         = v.findViewById(R.id.btnVerDetalle)
        btnAgregarFactura     = v.findViewById(R.id.btnAgregarFactura)
        btnAgregarTardanza    = v.findViewById(R.id.btnAgregarTardanza)
        btnGuardarFactura     = v.findViewById(R.id.btnGuardarFactura)
        btnGuardarTardanza    = v.findViewById(R.id.btnGuardarTardanza)
        btnNavegar            = v.findViewById(R.id.btnNavegar)
        btnZoomIn             = v.findViewById(R.id.btnZoomIn)
        btnZoomOut            = v.findViewById(R.id.btnZoomOut)
        btnMiUbicacion        = v.findViewById(R.id.btnMiUbicacion)
        // ── FIX: inicializar btnCronometro aquí junto al resto de views ──
        btnCronometro         = v.findViewById(R.id.btnCronometro)
        tvZoomLevel           = v.findViewById(R.id.tvZoomLevel)
        chipGroupFacturas     = v.findViewById(R.id.chipGroupFacturas)
        chipGroupTardanza     = v.findViewById(R.id.chipGroupTardanza)
        layoutCronometro      = v.findViewById(R.id.layoutCronometro)
        progressBar           = v.findViewById(R.id.progressBar)
        layoutVacio           = v.findViewById(R.id.layoutVacio)
        layoutContenido       = v.findViewById(R.id.layoutContenido)
        switchFacturas        = v.findViewById(R.id.switchFacturas)
        switchTardanza        = v.findViewById(R.id.switchTardanza)
        layoutFacturasContent = v.findViewById(R.id.layoutFacturasContent)
        layoutTardanzaContent = v.findViewById(R.id.layoutTardanzaContent)
        etNotaTardanza        = v.findViewById(R.id.etNotaTardanza)
        etValorFactura        = v.findViewById(R.id.etValorFactura)
        progressEta           = v.findViewById(R.id.progressEta)
        tvEtaProgreso         = v.findViewById(R.id.tvEtaProgreso)
        btnStep0              = v.findViewById(R.id.btnStep0)
        btnStep1              = v.findViewById(R.id.btnStep1)
        btnStep2              = v.findViewById(R.id.btnStep2)
        tvStepEnRuta          = v.findViewById(R.id.tvStepEnRuta)
        tvStepEnCamino        = v.findViewById(R.id.tvStepEnCamino)
        tvStepEntregado       = v.findViewById(R.id.tvStepEntregado)
        tvHoraEnRuta          = v.findViewById(R.id.tvHoraEnRuta)
        tvHoraEnCamino        = v.findViewById(R.id.tvHoraEnCamino)
        tvHoraEntregado       = v.findViewById(R.id.tvHoraEntregado)
        progressConector01    = v.findViewById(R.id.progressConector01)
        progressConector12    = v.findViewById(R.id.progressConector12)
        radarRing0a = v.findViewById(R.id.radarRing0a); radarRing0b = v.findViewById(R.id.radarRing0b)
        radarRing1a = v.findViewById(R.id.radarRing1a); radarRing1b = v.findViewById(R.id.radarRing1b)
        radarRing2a = v.findViewById(R.id.radarRing2a); radarRing2b = v.findViewById(R.id.radarRing2b)
    }

    private fun configurarToggles() {
        switchFacturas.setOnCheckedChangeListener { _, isChecked ->
            layoutFacturasContent.visibility = if (isChecked) View.VISIBLE else View.GONE
            switchFacturas.thumbTintList = android.content.res.ColorStateList.valueOf(Color.parseColor(if (isChecked) "#22C55E" else "#94A3B8"))
            switchFacturas.trackTintList = android.content.res.ColorStateList.valueOf(Color.parseColor(if (isChecked) "#14532D" else "#334155"))
        }
        switchTardanza.setOnCheckedChangeListener { _, isChecked ->
            layoutTardanzaContent.visibility = if (isChecked) View.VISIBLE else View.GONE
            if (!isChecked && cronometroActivo) detenerCronometro()
            switchTardanza.thumbTintList = android.content.res.ColorStateList.valueOf(Color.parseColor(if (isChecked) "#F59E0B" else "#94A3B8"))
            switchTardanza.trackTintList = android.content.res.ColorStateList.valueOf(Color.parseColor(if (isChecked) "#78350F" else "#334155"))
        }
    }

    private fun iniciarMapView(savedState: Bundle?) {
        mapView.onCreate(savedState)
        mapView.setOnTouchListener { vv, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN   -> vv.parent?.requestDisallowInterceptTouchEvent(true)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> vv.parent?.requestDisallowInterceptTouchEvent(false)
            }
            false
        }
        Log.d(TAG, "🗺️ iniciarMapView: llamando getMapAsync")
        mapView.getMapAsync { map ->
            if (!vistaActiva || mapaDestruido) { Log.w(TAG, "🗺️ getMapAsync callback: vista destruida"); return@getMapAsync }
            mapLibreMap = map
            tvZoomLevel.text = map.cameraPosition.zoom.toInt().toString()
            Log.d(TAG, "🗺️ getMapAsync OK → cargando estilo primario")
            mapView.addOnDidFailLoadingMapListener { errorMessage: String ->
                Log.e(TAG, "🗺️ MapLibre falló: $errorMessage")
                if (!intentoFallback && vistaActiva && !mapaDestruido) {
                    intentoFallback = true; cargarEstilo(map, STYLE_URL_FALLBACK)
                }
            }
            cargarEstilo(map, STYLE_URL_PRIMARY)
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(BASE_LAT, BASE_LNG), 12.0))
        }
    }

    private fun cargarEstilo(map: MapLibreMap, styleUrl: String) {
        if (mapaDestruido) return
        map.setStyle(Style.Builder().fromUri(styleUrl)) { style ->
            if (!vistaActiva || mapaDestruido) return@setStyle
            registrarIconos(style)
            lineManager   = LineManager(mapView, map, style)
            symbolManager = SymbolManager(mapView, map, style).apply {
                iconAllowOverlap = true; textAllowOverlap = true
            }
            mapaListo = true
            val dest = mapaCoordsPendientes; val orig = mapaOrigPendiente
            if (dest != null && orig != null) {
                dibujarRutaCompleta(dest.first, dest.second, orig.first, orig.second, pedidoActivo?.nombre ?: "")
            } else { colocarMarkerBase() }
        }
    }

    private fun registrarIconos(style: Style) {
        style.addImage(ICON_DOMI_BASE, crearIconoMotoConRadar(fase = 0))
        style.addImage(ICON_DESTINO,   crearBitmapDestino())
    }

    private fun registrarIconoDomiFoto(style: Style?, b64: String?) {
        if (style == null) return
        val bmp = if (!b64.isNullOrBlank()) {
            try {
                val bytes = Base64.decode(b64, Base64.NO_WRAP)
                crearAvatarCircularConMoto(BitmapFactory.decodeByteArray(bytes, 0, bytes.size), 52)
            } catch (_: Exception) { crearIconoMotoSolido() }
        } else crearIconoMotoSolido()
        style.addImage(ICON_DOMI_LIVE, bmp)
    }

    private fun crearIconoMotoConRadar(fase: Int): Bitmap {
        val dp = resources.displayMetrics.density; val size = (64 * dp).toInt()
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888); val canvas = Canvas(bmp)
        val cx = size / 2f; val cy = size / 2f; val radarColor = Color.parseColor("#3B82F6")
        if (fase >= 1) canvas.drawCircle(cx, cy, size * 0.28f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = radarColor; style = Paint.Style.STROKE; strokeWidth = 2.5f * dp; alpha = if (fase == 1) 180 else if (fase == 2) 120 else 60 })
        if (fase >= 2) canvas.drawCircle(cx, cy, size * 0.38f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = radarColor; style = Paint.Style.STROKE; strokeWidth = 2f * dp; alpha = if (fase == 2) 160 else 80 })
        if (fase >= 3) canvas.drawCircle(cx, cy, size * 0.47f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = radarColor; style = Paint.Style.STROKE; strokeWidth = 1.5f * dp; alpha = 50 })
        val nucleoR = size * 0.22f
        canvas.drawCircle(cx, cy, nucleoR, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#1E293B") })
        canvas.drawCircle(cx, cy, nucleoR, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#2563EB"); style = Paint.Style.STROKE; strokeWidth = 2.5f * dp })
        val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = nucleoR * 1.15f; textAlign = Paint.Align.CENTER }
        canvas.drawText("🛵", cx, cy + tp.textSize * 0.38f, tp)
        return bmp
    }

    private fun crearIconoMotoSolido(): Bitmap {
        val dp = resources.displayMetrics.density; val size = (48 * dp).toInt()
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888); val c = Canvas(bmp); val cx = size / 2f
        c.drawCircle(cx, cx, cx, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#1E293B") })
        c.drawCircle(cx, cx, cx, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#2563EB"); style = Paint.Style.STROKE; strokeWidth = 2.5f * dp })
        val tp = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = cx * 1.1f; textAlign = Paint.Align.CENTER }
        c.drawText("🛵", cx, cx + tp.textSize * 0.38f, tp); return bmp
    }

    private fun crearBitmapDestino(): Bitmap {
        val dp = resources.displayMetrics.density; val w = (28 * dp).toInt(); val h = (40 * dp).toInt()
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888); val c = Canvas(bmp); val cx = w / 2f
        val pinPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#DC2626") }
        val r = w / 2f; c.drawCircle(cx, r, r, pinPaint)
        val path = android.graphics.Path().apply { moveTo(cx - r * 0.55f, r * 1.3f); lineTo(cx + r * 0.55f, r * 1.3f); lineTo(cx, h.toFloat()); close() }
        c.drawPath(path, pinPaint); c.drawCircle(cx, r, r * 0.38f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE })
        return bmp
    }

    private fun crearAvatarCircularConMoto(src: Bitmap, sizeDp: Int): Bitmap {
        val dp = resources.displayMetrics.density; val size = (sizeDp * dp).toInt(); val border = (3 * dp).toInt()
        val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888); val c = Canvas(output)
        c.drawCircle(size / 2f, size / 2f, size / 2f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#2563EB") })
        val inner = size - border * 2; val scaled = Bitmap.createScaledBitmap(src, inner, inner, true)
        val mask = Bitmap.createBitmap(inner, inner, Bitmap.Config.ARGB_8888); val mc = Canvas(mask); val rr = inner / 2f
        mc.drawCircle(rr, rr, rr, Paint(Paint.ANTI_ALIAS_FLAG))
        mc.drawBitmap(scaled, 0f, 0f, Paint(Paint.ANTI_ALIAS_FLAG).apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN) })
        c.drawBitmap(mask, border.toFloat(), border.toFloat(), null); return output
    }

    private fun animarPulso() {
        val style = mapLibreMap?.style ?: return; if (mapaDestruido) return
        style.addImage(ICON_DOMI_BASE, crearIconoMotoConRadar(fase = pulsePhase))
        symbolDomi?.let { symbolManager?.update(it) }
    }

    private fun iniciarRadarStep(vararg rings: View) {
        rings.forEach { ring ->
            ring.visibility = View.VISIBLE
            val anim = ScaleAnimation(0.88f, 1.18f, 0.88f, 1.18f,
                Animation.RELATIVE_TO_SELF, 0.5f, Animation.RELATIVE_TO_SELF, 0.5f).apply {
                duration = 1100; repeatMode = Animation.REVERSE
                repeatCount = Animation.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
            }
            ring.startAnimation(anim)
        }
    }

    private fun detenerRadarStep(vararg rings: View) {
        rings.forEach { it.clearAnimation(); it.visibility = View.GONE }
    }

    private fun configurarBotones() {
        btnAccionPrincipal.setOnClickListener {
            val p = pedidoActivo ?: return@setOnClickListener
            when (p.estado.lowercase().trim()) {
                "en ruta"   -> ponermeEnCamino(p)
                "en camino" -> confirmarEntrega(p)
                else        -> ponermeEnCamino(p)
            }
        }
        btnAgregarFactura.setOnClickListener  { modoFotoActual = "factura";  mostrarOpcionesFoto() }
        btnAgregarTardanza.setOnClickListener { modoFotoActual = "tardanza"; mostrarOpcionesFoto() }
        btnVerDetalle.setOnClickListener      { pedidoActivo?.let { mostrarDetalleCompleto(it) } }
        btnNavegar.setOnClickListener         { abrirNavegacionMaps() }
        btnStep1.setOnClickListener {
            val p = pedidoActivo ?: return@setOnClickListener
            if (p.estado.lowercase().trim() == "en ruta") ponermeEnCamino(p)
        }
        btnStep2.setOnClickListener {
            val p = pedidoActivo ?: return@setOnClickListener
            val est = p.estado.lowercase().trim()
            if (est == "en camino" || est == "en ruta") confirmarEntrega(p)
        }
        // ── btnCronometro ya está inicializado en bindViews, sin ambigüedad ──
        btnCronometro.setOnClickListener {
            if (!cronometroActivo) iniciarCronometro() else detenerCronometro()
        }

        btnGuardarFactura.setOnClickListener {
            val pedido = pedidoActivo ?: return@setOnClickListener
            val valor  = etValorFactura.text?.toString()?.trim() ?: ""
            if (fotosFacturas.isEmpty() && valor.isBlank()) {
                Toast.makeText(requireContext(), "Agrega al menos una foto o el valor de la factura", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            btnGuardarFactura.isEnabled = false
            btnGuardarFactura.text = "Guardando…"
            guardarFacturaInmediata(pedido, valor)
        }

        btnGuardarTardanza.setOnClickListener {
            val pedido = pedidoActivo ?: return@setOnClickListener
            val nota   = etNotaTardanza.text?.toString()?.trim() ?: ""
            if (fotosTardanza.isEmpty() && nota.isBlank()) {
                Toast.makeText(requireContext(), "Agrega una foto o una nota de la tardanza", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            btnGuardarTardanza.isEnabled = false
            btnGuardarTardanza.text = "Guardando…"
            guardarTardanzaInmediata(pedido, nota)
        }

        btnZoomIn.setOnClickListener {
            val map = mapLibreMap ?: return@setOnClickListener
            val zoom = (map.cameraPosition.zoom + 1.0).coerceAtMost(20.0)
            map.animateCamera(CameraUpdateFactory.zoomTo(zoom)); tvZoomLevel.text = zoom.toInt().toString()
        }
        btnZoomOut.setOnClickListener {
            val map = mapLibreMap ?: return@setOnClickListener
            val zoom = (map.cameraPosition.zoom - 1.0).coerceAtLeast(3.0)
            map.animateCamera(CameraUpdateFactory.zoomTo(zoom)); tvZoomLevel.text = zoom.toInt().toString()
        }
        btnMiUbicacion.setOnClickListener {
            val map = mapLibreMap ?: return@setOnClickListener
            val zoom = if (gpsActivo) 13.0 else 12.0
            map.animateCamera(CameraUpdateFactory.newLatLngZoom(LatLng(lastDomiLat, lastDomiLng), zoom))
            tvZoomLevel.text = zoom.toInt().toString()
            if (!gpsActivo) Toast.makeText(requireContext(), "Mostrando posición base 🛵 (GPS no activo aún)", Toast.LENGTH_SHORT).show()
        }
    }

    private fun guardarFacturaInmediata(pedido: PedidoDomi, valor: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val fotosArr = JSONArray().apply { fotosFacturas.forEach { put(it) } }
                val body = JSONObject().apply {
                    put("pedidoId", pedido.idPedido)
                    put("tipo", "facturas")
                    put("fotos", fotosArr)
                    if (valor.isNotBlank()) {
                        val valorNum = valor.toDoubleOrNull()
                        if (valorNum != null) put("valorFactura", valorNum)
                    }
                }.toString()
                withContext(Dispatchers.IO) {
                    val conn = java.net.URL("https://domicilios-wil.vercel.app/api/foto?recurso=adjuntar-foto")
                        .openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "PATCH"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.outputStream.write(body.toByteArray())
                    Log.d(TAG, "guardarFacturaInmediata → HTTP ${conn.responseCode}")
                    conn.disconnect()
                }
                if (!vistaActiva) return@launch
                btnGuardarFactura.text = "✅ Factura guardada"
                btnGuardarFactura.setBackgroundColor(Color.parseColor("#14532D"))
                btnGuardarFactura.isEnabled = false
                Toast.makeText(activity, "✅ Factura guardada en la BD", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Log.w(TAG, "guardarFacturaInmediata: ${e.message}")
                if (vistaActiva) {
                    btnGuardarFactura.isEnabled = true
                    btnGuardarFactura.text = "💾 Guardar factura"
                    Toast.makeText(activity, "Error guardando factura — intenta de nuevo", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun guardarTardanzaInmediata(pedido: PedidoDomi, nota: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val fotosArr = JSONArray().apply { fotosTardanza.forEach { put(it) } }
                val body = JSONObject().apply {
                    put("pedidoId", pedido.idPedido)
                    put("tipo", "comprobantesTardanza")
                    put("fotos", fotosArr)
                    if (nota.isNotBlank()) put("nota", nota)
                }.toString()
                withContext(Dispatchers.IO) {
                    val conn = java.net.URL("https://domicilios-wil.vercel.app/api/foto?recurso=adjuntar-foto")
                        .openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "PATCH"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.outputStream.write(body.toByteArray())
                    Log.d(TAG, "guardarTardanzaInmediata → HTTP ${conn.responseCode}")
                    conn.disconnect()
                }
                if (!vistaActiva) return@launch
                btnGuardarTardanza.text = "✅ Tardanza guardada"
                btnGuardarTardanza.setBackgroundColor(Color.parseColor("#78350F"))
                btnGuardarTardanza.isEnabled = false
                Toast.makeText(activity, "✅ Comprobante de tardanza guardado", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Log.w(TAG, "guardarTardanzaInmediata: ${e.message}")
                if (vistaActiva) {
                    btnGuardarTardanza.isEnabled = true
                    btnGuardarTardanza.text = "💾 Guardar tardanza"
                    Toast.makeText(activity, "Error guardando tardanza — intenta de nuevo", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun guardarTiempoExtraInmediato(
        pedido:     PedidoDomi,
        segundos:   Long,
        costo:      Int,
        intervalos: Int,
        nota:       String
    ) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = JSONObject().apply {
                    put("pedidoId", pedido.idPedido)
                    put("tiempoExtra", JSONObject().apply {
                        put("segundos",   segundos)
                        put("costoExtra", costo)
                        put("intervalos", intervalos)
                        if (nota.isNotBlank()) put("nota", nota)
                    })
                }.toString()
                withContext(Dispatchers.IO) {
                    val conn = java.net.URL("https://domicilios-wil.vercel.app/api/foto?recurso=tiempo-extra")
                        .openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "PATCH"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.outputStream.write(body.toByteArray())
                    Log.d(TAG, "guardarTiempoExtraInmediato → HTTP ${conn.responseCode} | seg=$segundos costo=$costo intervalos=$intervalos")
                    conn.disconnect()
                }
            } catch (e: Exception) {
                Log.w(TAG, "guardarTiempoExtraInmediato: ${e.message}")
            }
        }
    }

    private fun abrirNavegacionMaps() {
        val destLat = mapaCoordsPendientes?.first; val destLng = mapaCoordsPendientes?.second
        if (destLat == null || destLng == null) {
            Toast.makeText(requireContext(), "Sin coordenadas de destino aún", Toast.LENGTH_SHORT).show(); return
        }
        val uri = Uri.parse("https://www.google.com/maps/dir/?api=1&origin=$lastDomiLat,$lastDomiLng&destination=$destLat,$destLng&travelmode=driving&dir_action=navigate")
        val intent = Intent(Intent.ACTION_VIEW, uri).apply { setPackage("com.google.android.apps.maps") }
        if (intent.resolveActivity(requireActivity().packageManager) != null) startActivity(intent)
        else startActivity(Intent(Intent.ACTION_VIEW, uri))
    }

    private fun colocarMarkerBase() {
        if (!vistaActiva || mapaDestruido || symbolManager == null) return
        symbolDomi?.let { symbolManager?.delete(it) }
        symbolDomi = symbolManager?.create(SymbolOptions().withLatLng(LatLng(lastDomiLat, lastDomiLng)).withIconImage(ICON_DOMI_BASE).withIconSize(1f))
        iniciarAnimacionRadar()
    }

    private fun iniciarAnimacionRadar() { handler.removeCallbacks(pulseRunnable); pulsePhase = 0; handler.postDelayed(pulseRunnable, PULSE_INTERVAL_MS) }
    private fun detenerAnimacionRadar() { handler.removeCallbacks(pulseRunnable) }

    private fun cargarPedidoActivo() {
        val act = activity as? PanelDomiActivity ?: return
        if (act.domiId.isBlank()) {
            progressBar.visibility = View.GONE; layoutVacio.visibility = View.VISIBLE; return
        }
        progressBar.visibility = View.VISIBLE; layoutContenido.visibility = View.GONE; layoutVacio.visibility = View.GONE

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val url = "https://domicilios-wil.vercel.app/api/foto?recurso=pedidos&estado=en ruta,en camino&domiId=${act.domiId}&limit=1"
                val response = withContext(Dispatchers.IO) {
                    val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 10_000; conn.readTimeout = 10_000
                    conn.inputStream.bufferedReader().readText().also { conn.disconnect() }
                }
                if (!vistaActiva) return@launch
                val data = JSONObject(response).optJSONArray("data") ?: JSONArray()
                progressBar.visibility = View.GONE
                if (data.length() == 0) { layoutVacio.visibility = View.VISIBLE; return@launch }

                val p = data.getJSONObject(0)
                if (p.optString("domiciliarioId") != act.domiId) { layoutVacio.visibility = View.VISIBLE; return@launch }

                act.tienePedidoEnRuta = true; act.actualizarBadge(1, 1)

                val itemsArr = p.optJSONArray("items")
                val productosTexto = buildString {
                    if (itemsArr != null) for (j in 0 until itemsArr.length()) {
                        val it = itemsArr.getJSONObject(j)
                        appendLine("• ${it.optString("producto")} x${it.optInt("cantidad")} — $ ${fmt.format(it.optDouble("subtotal", 0.0).toLong())}")
                    }
                }.trim()

                pedidoActivo = PedidoDomi(
                    idPedido   = p.optString("idPedido",   "–").trim().trimEnd(','),
                    estado     = p.optString("estado",     "en ruta"),
                    nombre     = p.optString("nombre",     "–"),
                    telefono   = p.optString("telefono",   ""),
                    direccion  = p.optString("direccion",  "–"),
                    comercio   = p.optString("comercio",   "–"),
                    hora       = p.optString("hora",       ""),
                    fecha      = p.optString("fecha",      ""),
                    total      = p.optDouble("total",      0.0),
                    domicilio  = p.optDouble("domicilio",  0.0),
                    metodoPago = p.optString("metodoPago", ""),
                    domiId     = p.optString("domiciliarioId",     ""),
                    domiNombre = p.optString("domiciliarioNombre", ""),
                    productos  = productosTexto,
                    horaToma   = p.optString("horaToma", "")
                )

                horaEnRuta   = pedidoActivo!!.horaToma
                horaEnCamino = p.optString("horaEnCamino", "")

                if (!vistaActiva) return@launch
                mostrarPedidoUI(pedidoActivo!!)
                layoutContenido.visibility = View.VISIBLE

                val coords  = p.optJSONObject("coords")
                val destLat = coords?.optDouble("lat")
                val destLng = coords?.optDouble("lng")

                val domiCoords = p.optJSONObject("domiCoords")
                val rawLat = if (domiCoords != null && domiCoords.has("lat") && !domiCoords.isNull("lat")) domiCoords.getDouble("lat") else null
                val rawLng = if (domiCoords != null && domiCoords.has("lng") && !domiCoords.isNull("lng")) domiCoords.getDouble("lng") else null

                if (rawLat != null && rawLng != null && rawLat != 0.0 && rawLng != 0.0 && !rawLat.isNaN() && !rawLng.isNaN()) {
                    lastDomiLat = rawLat; lastDomiLng = rawLng; gpsActivo = true
                }

                val origLat = lastDomiLat; val origLng = lastDomiLng
                val fotoDomi = p.optString("domiciliarioFoto", "")
                registrarIconoDomiFoto(mapLibreMap?.style, fotoDomi)

                val coordsValidas = destLat != null && destLng != null &&
                        !destLat.isNaN() && !destLng.isNaN() && destLat != 0.0 && destLng != 0.0

                if (coordsValidas) {
                    mapaCoordsPendientes = destLat!! to destLng!!
                    mapaOrigPendiente    = origLat to origLng
                    if (mapaListo) dibujarRutaCompleta(destLat, destLng, origLat, origLng, pedidoActivo!!.nombre)
                    iniciarTracking(act.domiId, pedidoActivo!!.idPedido, fotoDomi)
                } else {
                    val dir = pedidoActivo!!.direccion
                    if (dir.isNotBlank() && dir != "–") {
                        geocodificarYDibujar(dir, origLat, origLng, fotoDomi, act.domiId, pedidoActivo!!.idPedido)
                    } else {
                        mapaOrigPendiente = origLat to origLng
                        if (mapaListo) colocarMarkerBase()
                        iniciarTracking(act.domiId, pedidoActivo!!.idPedido, fotoDomi)
                    }
                }

            } catch (e: Exception) {
                Log.e(TAG, "❌ cargarPedidoActivo EXCEPTION: ${e.message}", e)
                if (vistaActiva) { progressBar.visibility = View.GONE; layoutVacio.visibility = View.VISIBLE }
            }
        }
    }

    private fun geocodificarYDibujar(direccion: String, origLat: Double, origLng: Double, fotoDomi: String, domiId: String, pedidoId: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val query = android.net.Uri.encode("$direccion, Antioquia, Colombia")
                val body  = withContext(Dispatchers.IO) {
                    val conn = java.net.URL("https://nominatim.openstreetmap.org/search?q=$query&format=json&limit=1").openConnection() as java.net.HttpURLConnection
                    conn.setRequestProperty("User-Agent", "DomiciliosWil/1.0"); conn.connectTimeout = 8_000; conn.readTimeout = 8_000
                    conn.inputStream.bufferedReader().readText().also { conn.disconnect() }
                }
                if (!vistaActiva) return@launch
                val arr = JSONArray(body)
                if (arr.length() == 0) {
                    if (vistaActiva && !mapaDestruido && mapaListo) colocarMarkerBase()
                    iniciarTracking(domiId, pedidoId, fotoDomi); return@launch
                }
                val resultado = arr.getJSONObject(0)
                val destLat   = resultado.optDouble("lat", 0.0)
                val destLng   = resultado.optDouble("lon", 0.0)
                if (destLat == 0.0 && destLng == 0.0) {
                    if (vistaActiva && !mapaDestruido && mapaListo) colocarMarkerBase()
                    iniciarTracking(domiId, pedidoId, fotoDomi); return@launch
                }
                mapaCoordsPendientes = destLat to destLng; mapaOrigPendiente = origLat to origLng
                if (mapaListo) dibujarRutaCompleta(destLat, destLng, origLat, origLng, pedidoActivo?.nombre ?: "")
                if (domiId.isNotBlank() && pedidoId.isNotBlank()) iniciarTracking(domiId, pedidoId, fotoDomi)
            } catch (e: Exception) {
                Log.e(TAG, "❌ geocodificarYDibujar: ${e.message}", e)
                if (vistaActiva && !mapaDestruido && mapaListo) colocarMarkerBase()
                iniciarTracking(domiId, pedidoId, fotoDomi)
            }
        }
    }

    private fun iniciarTracking(domiId: String, pedidoId: String, fotoDomi: String) {
        detenerTracking()
        ticksSinActualizarEta = 0
        trackingJob = viewLifecycleOwner.lifecycleScope.launch {
            while (isActive && vistaActiva) {
                delay(TRACKING_INTERVAL_MS)
                if (!vistaActiva || mapaDestruido) break
                try { actualizarPosicionDomi(domiId, pedidoId, fotoDomi) }
                catch (e: Exception) { Log.e(TAG, "Tracking loop: ${e.message}", e) }
            }
        }
    }

    private fun detenerTracking() { trackingJob?.cancel(); trackingJob = null }

    private suspend fun actualizarPosicionDomi(domiId: String, pedidoId: String, fotoDomi: String) {
        val pedidoIdLimpio = pedidoId.trim().trimEnd(',', ' ')
        val url = "https://domicilios-wil.vercel.app/api/foto?recurso=pedidos&estado=en ruta,en camino&domiId=$domiId&limit=1"

        val bodyStr = withContext(Dispatchers.IO) {
            val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 6_000; conn.readTimeout = 6_000
            val code = conn.responseCode
            if (code != 200) {
                val err = conn.errorStream?.bufferedReader()?.readText() ?: "HTTP $code"
                conn.disconnect(); throw Exception("HTTP $code → $err")
            }
            conn.inputStream.bufferedReader().readText().also { conn.disconnect() }
        }

        val data = JSONObject(bodyStr).optJSONArray("data") ?: JSONArray()
        if (data.length() == 0) return

        val p = data.getJSONObject(0)
        val pedidoIdApi = p.optString("idPedido", "").trim().trimEnd(',')
        if (pedidoIdApi.isNotBlank() && pedidoIdApi != pedidoIdLimpio) return

        val domiCoords = p.optJSONObject("domiCoords")
        val newLat = if (domiCoords != null && domiCoords.has("lat") && !domiCoords.isNull("lat")) domiCoords.getDouble("lat") else 0.0
        val newLng = if (domiCoords != null && domiCoords.has("lng") && !domiCoords.isNull("lng")) domiCoords.getDouble("lng") else 0.0

        val destino = mapaCoordsPendientes

        if (newLat == 0.0 && newLng == 0.0) {
            withContext(Dispatchers.Main) {
                if (!vistaActiva || mapaDestruido || !mapaListo) return@withContext
                if (destino != null && symbolDomi == null) dibujarRutaCompleta(destino.first, destino.second, lastDomiLat, lastDomiLng, pedidoActivo?.nombre ?: "")
                else if (symbolDomi == null) colocarMarkerBase()
                else iniciarAnimacionRadar()
            }
            return
        }

        val esPrimerGps = !gpsActivo
        val distancia   = distanciaMetros(lastDomiLat, lastDomiLng, newLat, newLng)
        val movido      = distancia > 10.0

        lastDomiLat = newLat; lastDomiLng = newLng
        ticksSinActualizarEta++

        if (esPrimerGps) {
            gpsActivo = true
            withContext(Dispatchers.Main) { detenerAnimacionRadar(); registrarIconoDomiFoto(mapLibreMap?.style, fotoDomi) }
        }

        val debeDibujar = esPrimerGps || movido || ticksSinActualizarEta >= FORZAR_ETA_CADA_N_TICKS

        if (destino != null && debeDibujar) {
            ticksSinActualizarEta = 0
            dibujarRutaConEta(newLat, newLng, destino.first, destino.second)
        } else if (destino == null) {
            withContext(Dispatchers.Main) {
                if (!vistaActiva || mapaDestruido || !mapaListo) return@withContext
                val posicion = LatLng(newLat, newLng)
                if (symbolDomi != null) {
                    symbolDomi!!.latLng = posicion
                    symbolDomi!!.iconImage = if (gpsActivo) ICON_DOMI_LIVE else ICON_DOMI_BASE
                    symbolManager?.update(symbolDomi)
                } else {
                    symbolDomi = symbolManager?.create(SymbolOptions().withLatLng(posicion).withIconImage(if (gpsActivo) ICON_DOMI_LIVE else ICON_DOMI_BASE).withIconSize(1f))
                }
            }
        }
    }

    private suspend fun osrmFetch(origLng: Double, origLat: Double, destLng: Double, destLat: Double): JSONObject {
        val servidores = listOf("https://router.project-osrm.org", "https://routing.openstreetmap.de")
        var lastException: Exception? = null
        for (base in servidores) {
            val url = "$base/route/v1/driving/$origLng,$origLat;$destLng,$destLat?overview=full&geometries=geojson"
            try {
                val body = withContext(Dispatchers.IO) {
                    val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 8_000; conn.readTimeout = 8_000
                    conn.setRequestProperty("User-Agent", "DomiciliosWil/1.0 Android")
                    conn.setRequestProperty("Accept", "application/json")
                    val code = conn.responseCode
                    if (code !in 200..299) {
                        val err = conn.errorStream?.bufferedReader()?.readText() ?: "HTTP $code"
                        conn.disconnect(); throw Exception("OSRM $base HTTP $code → $err")
                    }
                    conn.inputStream.bufferedReader().readText().also { conn.disconnect() }
                }
                return JSONObject(body)
            } catch (e: Exception) { lastException = e }
        }
        throw lastException ?: Exception("osrmFetch: todos los servidores fallaron")
    }

    private suspend fun dibujarRutaConEta(domiLat: Double, domiLng: Double, destLat: Double, destLng: Double) {
        try {
            val json     = osrmFetch(domiLng, domiLat, destLng, destLat)
            val routeObj = json.getJSONArray("routes").getJSONObject(0)
            val geo      = routeObj.getJSONObject("geometry").getJSONArray("coordinates")
            val durSeg   = routeObj.optDouble("duration", 0.0).toLong()
            val distM    = routeObj.optDouble("distance", 0.0)
            val puntos   = mutableListOf<LatLng>()
            for (i in 0 until geo.length()) {
                val pt = geo.getJSONArray(i); puntos.add(LatLng(pt.getDouble(1), pt.getDouble(0)))
            }
            ultimaDurSeg = durSeg; ultimaDistM = distM

            withContext(Dispatchers.Main) {
                if (!vistaActiva || mapaDestruido || !mapaListo) return@withContext
                val lm = lineManager   ?: return@withContext
                val sm = symbolManager ?: return@withContext
                lm.deleteAll()
                lm.create(LineOptions().withLatLngs(puntos).withLineColor("#2563EB").withLineWidth(4f).withLineOpacity(0.85f))
                val posicion  = LatLng(domiLat, domiLng)
                val iconoUsar = if (gpsActivo) ICON_DOMI_LIVE else ICON_DOMI_BASE
                if (symbolDomi != null) { symbolDomi!!.latLng = posicion; symbolDomi!!.iconImage = iconoUsar; sm.update(symbolDomi) }
                else symbolDomi = sm.create(SymbolOptions().withLatLng(posicion).withIconImage(iconoUsar).withIconSize(1f))
                if (symbolDest == null)
                    symbolDest = sm.create(SymbolOptions().withLatLng(LatLng(destLat, destLng)).withIconImage(ICON_DESTINO).withIconSize(1.2f))
                actualizarBarraProgreso(pedidoActivo?.estado ?: "en ruta", durSeg, distM)
            }
        } catch (e: Exception) { Log.e(TAG, "❌ dibujarRutaConEta: ${e.message}", e) }
    }

    private fun dibujarRutaCompleta(destLat: Double, destLng: Double, origLat: Double, origLng: Double, cliente: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val json     = osrmFetch(origLng, origLat, destLng, destLat)
                val routeObj = json.getJSONArray("routes").getJSONObject(0)
                val geo      = routeObj.getJSONObject("geometry").getJSONArray("coordinates")
                val durSeg   = routeObj.optDouble("duration", 0.0).toLong()
                val distM    = routeObj.optDouble("distance", 0.0)
                val puntos   = mutableListOf<LatLng>()
                for (i in 0 until geo.length()) {
                    val pt = geo.getJSONArray(i); puntos.add(LatLng(pt.getDouble(1), pt.getDouble(0)))
                }
                ultimaDurSeg = durSeg; ultimaDistM = distM
                val estado = pedidoActivo?.estado?.lowercase()?.trim() ?: "en ruta"
                if (estado == "en ruta"   && distInicialEnRuta   == 0.0) distInicialEnRuta   = distM
                if (estado == "en camino" && distInicialEnCamino == 0.0 && ultimaDistM > distM) distInicialEnCamino = ultimaDistM

                withContext(Dispatchers.Main) {
                    if (!vistaActiva || mapaDestruido || !mapaListo) return@withContext
                    val map = mapLibreMap   ?: return@withContext
                    val lm  = lineManager  ?: return@withContext
                    val sm  = symbolManager ?: return@withContext
                    lm.deleteAll(); sm.deleteAll(); symbolDomi = null; symbolDest = null
                    lm.create(LineOptions().withLatLngs(puntos).withLineColor("#2563EB").withLineWidth(4f).withLineOpacity(0.85f))
                    val iconoDomi = if (gpsActivo) ICON_DOMI_LIVE else ICON_DOMI_BASE
                    symbolDomi = sm.create(SymbolOptions().withLatLng(LatLng(origLat, origLng)).withIconImage(iconoDomi).withIconSize(1f))
                    symbolDest = sm.create(SymbolOptions().withLatLng(LatLng(destLat, destLng)).withIconImage(ICON_DESTINO).withIconSize(1.2f))
                    mapLibreMap?.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(origLat, origLng), 12.0))
                    actualizarBarraProgreso(estado, durSeg, distM)
                    if (!gpsActivo) iniciarAnimacionRadar()
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ dibujarRutaCompleta: ${e.message}", e)
                withContext(Dispatchers.Main) {
                    if (!vistaActiva || mapaDestruido || !mapaListo || symbolManager == null) return@withContext
                    symbolManager?.deleteAll(); lineManager?.deleteAll(); symbolDomi = null; symbolDest = null
                    val iconoDomi = if (gpsActivo) ICON_DOMI_LIVE else ICON_DOMI_BASE
                    symbolDomi = symbolManager?.create(SymbolOptions().withLatLng(LatLng(origLat, origLng)).withIconImage(iconoDomi).withIconSize(1f))
                    symbolDest = symbolManager?.create(SymbolOptions().withLatLng(LatLng(destLat, destLng)).withIconImage(ICON_DESTINO).withIconSize(1.2f))
                    if (!gpsActivo) iniciarAnimacionRadar()
                    actualizarBarraProgreso(pedidoActivo?.estado ?: "en ruta", -1L, 0.0)
                }
            }
        }
    }

    private fun actualizarBarraProgreso(
        estado: String,
        durSeg: Long   = ultimaDurSeg,
        distM:  Double = ultimaDistM
    ) {
        if (!vistaActiva) return
        val colorActivo     = Color.parseColor("#60A5FA")
        val colorCompletado = Color.parseColor("#4ADE80")
        val colorInactivo   = Color.parseColor("#475569")
        val bgActivo   = ContextCompat.getDrawable(requireContext(), R.drawable.bg_step_active)
        val bgDone     = ContextCompat.getDrawable(requireContext(), R.drawable.bg_step_done)
        val bgInactive = ContextCompat.getDrawable(requireContext(), R.drawable.bg_step_inactive)

        fun kmTexto() = "${"%.1f".format(distM / 1000)} km"
        fun minTexto(): String {
            if (durSeg < 0) return "–"
            val min = durSeg / 60
            return if (min < 1) "< 1 min" else "$min min"
        }
        fun etaTextoGrande(): String {
            if (durSeg < 0 || durSeg == 0L) return "Calculando…"
            val min = durSeg / 60
            val distTexto = if (distM >= 1000) "${"%.1f".format(distM / 1000)} km" else "${distM.toInt()} m"
            return if (min < 1) "< 1 min · $distTexto" else "$min min · $distTexto"
        }
        fun progreso01(): Int {
            if (distInicialEnRuta <= 0.0 || distM <= 0.0) return 5
            return ((1.0 - distM / distInicialEnRuta) * 100).toInt().coerceIn(5, 95)
        }
        fun progreso12(): Int {
            val distInicialValida = distInicialEnCamino > 0.0 && distM > 0.0 && distInicialEnCamino > distM * 1.1
            if (distInicialValida) return ((1.0 - distM / distInicialEnCamino) * 100).toInt().coerceIn(5, 95)
            return when {
                distM <= 0.0     -> 20
                distM <= 300.0   -> 93
                distM <= 500.0   -> 88
                distM <= 800.0   -> 78
                distM <= 1_200.0 -> 65
                distM <= 2_000.0 -> 50
                distM <= 3_500.0 -> 35
                else             -> 20
            }
        }
        when (estado.lowercase().trim()) {
            "en ruta" -> {
                btnStep0.background = bgActivo; btnStep0.isEnabled = true; btnStep0.alpha = 1f
                btnStep0.setImageResource(R.drawable.ic_directions_bike)
                btnStep0.imageTintList = android.content.res.ColorStateList.valueOf(colorActivo)
                iniciarRadarStep(radarRing0a, radarRing0b)
                tvStepEnRuta.setTextColor(colorActivo)
                tvHoraEnRuta.visibility = if (horaEnRuta.isNotBlank()) View.VISIBLE else View.GONE
                if (horaEnRuta.isNotBlank()) tvHoraEnRuta.text = horaEnRuta
                progressConector01.progress = progreso01()
                btnStep1.background = bgInactive; btnStep1.isEnabled = true; btnStep1.alpha = 0.5f
                btnStep1.setImageResource(R.drawable.ic_directions_bike)
                btnStep1.imageTintList = android.content.res.ColorStateList.valueOf(colorInactivo)
                detenerRadarStep(radarRing1a, radarRing1b)
                tvStepEnCamino.setTextColor(colorInactivo); tvHoraEnCamino.visibility = View.GONE
                progressConector12.progress = 0
                btnStep2.background = bgInactive; btnStep2.isEnabled = false; btnStep2.alpha = 0.35f
                btnStep2.setImageResource(R.drawable.ic_check)
                btnStep2.imageTintList = android.content.res.ColorStateList.valueOf(colorInactivo)
                detenerRadarStep(radarRing2a, radarRing2b)
                tvStepEntregado.setTextColor(colorInactivo); tvHoraEntregado.visibility = View.GONE
                progressEta.progress = progreso01()
                tvEta.visibility = View.VISIBLE
                if (durSeg < 0 || durSeg == 0L) {
                    tvEta.text = "Calculando ruta…"
                    tvEtaProgreso.text = "Recogiendo pedido en el comercio"
                } else {
                    tvEta.text = "🛵 Al comercio · ${etaTextoGrande()}"
                    tvEtaProgreso.text = "Distancia: ${kmTexto()}  ·  Tiempo estimado: ${minTexto()}"
                }
                btnAccionPrincipal.visibility = View.VISIBLE; btnAccionPrincipal.isEnabled = true; btnAccionPrincipal.alpha = 1f
                btnAccionPrincipal.text = "🛵 Ponerme en camino"
                btnAccionPrincipal.setBackgroundColor(Color.parseColor("#1E3A8A"))
                btnAccionPrincipal.setTextColor(Color.parseColor("#93C5FD"))
            }
            "en camino" -> {
                btnStep0.background = bgDone; btnStep0.isEnabled = false; btnStep0.alpha = 1f
                btnStep0.setImageResource(R.drawable.ic_check)
                btnStep0.imageTintList = android.content.res.ColorStateList.valueOf(colorCompletado)
                detenerRadarStep(radarRing0a, radarRing0b)
                tvStepEnRuta.setTextColor(colorCompletado)
                tvHoraEnRuta.visibility = if (horaEnRuta.isNotBlank()) View.VISIBLE else View.GONE
                if (horaEnRuta.isNotBlank()) tvHoraEnRuta.text = horaEnRuta
                progressConector01.progress = 100
                progressConector01.progressTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#22C55E"))
                btnStep1.background = bgActivo; btnStep1.isEnabled = true; btnStep1.alpha = 1f
                btnStep1.setImageResource(R.drawable.ic_directions_bike)
                btnStep1.imageTintList = android.content.res.ColorStateList.valueOf(colorActivo)
                iniciarRadarStep(radarRing1a, radarRing1b)
                tvStepEnCamino.setTextColor(colorActivo)
                tvHoraEnCamino.visibility = if (horaEnCamino.isNotBlank()) View.VISIBLE else View.GONE
                if (horaEnCamino.isNotBlank()) tvHoraEnCamino.text = horaEnCamino
                progressConector12.progress = progreso12()
                progressConector12.progressTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#3B82F6"))
                btnStep2.background = bgActivo; btnStep2.isEnabled = true; btnStep2.alpha = 1f
                btnStep2.setImageResource(R.drawable.ic_check)
                btnStep2.imageTintList = android.content.res.ColorStateList.valueOf(colorCompletado)
                iniciarRadarStep(radarRing2a, radarRing2b)
                tvStepEntregado.setTextColor(colorActivo); tvHoraEntregado.visibility = View.GONE
                progressEta.progress = progreso12()
                tvEta.visibility = View.VISIBLE
                if (durSeg < 0 || durSeg == 0L) {
                    tvEta.text = "En camino al cliente…"
                    tvEtaProgreso.text = "¡Llegando al destino!"
                } else {
                    tvEta.text = "📍 Al cliente · ${etaTextoGrande()}"
                    tvEtaProgreso.text = "Distancia: ${kmTexto()}  ·  Tiempo estimado: ${minTexto()}"
                }
                btnAccionPrincipal.visibility = View.VISIBLE; btnAccionPrincipal.isEnabled = true; btnAccionPrincipal.alpha = 1f
                btnAccionPrincipal.text = "✅ Confirmar entrega"
                btnAccionPrincipal.setBackgroundColor(Color.parseColor("#14532D"))
                btnAccionPrincipal.setTextColor(Color.parseColor("#86EFAC"))
            }
            "entregado" -> {
                listOf(btnStep0, btnStep1, btnStep2).forEach { btn ->
                    btn.background = bgDone; btn.isEnabled = false; btn.alpha = 1f
                    btn.setImageResource(R.drawable.ic_check)
                    btn.imageTintList = android.content.res.ColorStateList.valueOf(colorCompletado)
                }
                detenerRadarStep(radarRing0a, radarRing0b, radarRing1a, radarRing1b, radarRing2a, radarRing2b)
                tvStepEnRuta.setTextColor(colorCompletado); tvStepEnCamino.setTextColor(colorCompletado); tvStepEntregado.setTextColor(colorCompletado)
                tvHoraEnRuta.visibility   = if (horaEnRuta.isNotBlank())   View.VISIBLE else View.GONE
                tvHoraEnCamino.visibility = if (horaEnCamino.isNotBlank()) View.VISIBLE else View.GONE
                if (horaEnRuta.isNotBlank())   tvHoraEnRuta.text   = horaEnRuta
                if (horaEnCamino.isNotBlank()) tvHoraEnCamino.text = horaEnCamino
                progressConector01.progress = 100
                progressConector01.progressTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#22C55E"))
                progressConector12.progress = 100
                progressConector12.progressTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#22C55E"))
                progressEta.progress = 100
                tvEta.visibility = View.VISIBLE; tvEta.text = "✅ ¡Pedido entregado!"
                tvEtaProgreso.text = "¡Pedido entregado exitosamente! ✅"
                btnAccionPrincipal.visibility = View.GONE
            }
            else -> {
                btnStep0.background = bgActivo; btnStep0.alpha = 1f
                btnStep0.setImageResource(R.drawable.ic_directions_bike)
                btnStep0.imageTintList = android.content.res.ColorStateList.valueOf(colorActivo)
                iniciarRadarStep(radarRing0a, radarRing0b)
                tvStepEnRuta.setTextColor(colorActivo)
                btnStep1.background = bgInactive; btnStep1.isEnabled = true; btnStep1.alpha = 0.5f
                tvStepEnCamino.setTextColor(colorInactivo)
                btnStep2.background = bgInactive; btnStep2.isEnabled = false; btnStep2.alpha = 0.35f
                tvStepEntregado.setTextColor(colorInactivo)
                detenerRadarStep(radarRing1a, radarRing1b, radarRing2a, radarRing2b)
                progressConector01.progress = 5; progressConector12.progress = 0
                progressEta.progress = 5
                tvEta.visibility = View.VISIBLE; tvEta.text = "Calculando ruta…"
                tvEtaProgreso.text = "Calculando ruta…"
                tvHoraEnRuta.visibility = View.GONE; tvHoraEnCamino.visibility = View.GONE; tvHoraEntregado.visibility = View.GONE
                btnAccionPrincipal.visibility = View.VISIBLE; btnAccionPrincipal.isEnabled = true; btnAccionPrincipal.alpha = 1f
                btnAccionPrincipal.text = "🛵 Ponerme en camino"
                btnAccionPrincipal.setBackgroundColor(Color.parseColor("#1E3A8A"))
                btnAccionPrincipal.setTextColor(Color.parseColor("#93C5FD"))
            }
        }
    }

    private fun mostrarPedidoUI(p: PedidoDomi) {
        tvNombreCliente.text = p.nombre
        tvEstadoBadge.text   = p.estado
        if (horaEnRuta.isBlank() && p.horaToma.isNotBlank()) horaEnRuta = p.horaToma
        val (colorTxt, colorBg) = when (p.estado.lowercase()) {
            "en ruta"   -> "#2563EB" to "#DBEAFE"
            "en camino" -> "#0891B2" to "#CFFAFE"
            else        -> "#2563EB" to "#DBEAFE"
        }
        tvEstadoBadge.setTextColor(Color.parseColor(colorTxt))
        tvEstadoBadge.backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor(colorBg))
        tvEta.visibility = View.VISIBLE
        tvEta.text = "Calculando ruta…"
        actualizarBarraProgreso(p.estado, ultimaDurSeg, ultimaDistM)
    }

    private fun ponermeEnCamino(pedido: PedidoDomi) {
        if (pedido.estado.lowercase().trim() == "en camino") return
        val act = activity as? PanelDomiActivity ?: return
        btnAccionPrincipal.isEnabled = false; btnAccionPrincipal.text = "Actualizando…"
        btnStep1.isEnabled = false; btnStep1.alpha = 0.6f
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val horaActual = SimpleDateFormat("hh:mm a", Locale("es", "CO")).format(Date())
                val body = JSONObject().apply {
                    put("pedidoId", pedido.idPedido); put("estado", "en camino")
                    put("domiciliarioId", act.domiId); put("horaToma", pedido.horaToma.ifBlank { horaActual })
                    put("horaEnCamino", horaActual)
                }.toString()
                withContext(Dispatchers.IO) {
                    val conn = java.net.URL("https://domicilios-wil.vercel.app/api/foto?recurso=estado").openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "PATCH"; conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true; conn.outputStream.write(body.toByteArray()); conn.responseCode; conn.disconnect()
                }
                if (!vistaActiva) return@launch
                horaEnCamino = horaActual
                pedidoActivo = pedido.copy(estado = "en camino", horaToma = pedido.horaToma.ifBlank { horaActual })
                if (distInicialEnCamino == 0.0 && ultimaDistM > 0.0) distInicialEnCamino = ultimaDistM
                tvEstadoBadge.text = "en camino"
                tvEstadoBadge.setTextColor(Color.parseColor("#0891B2"))
                tvEstadoBadge.backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#CFFAFE"))
                actualizarBarraProgreso("en camino", ultimaDurSeg, ultimaDistM)
                Toast.makeText(act, "¡En camino! 🛵", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Log.e(TAG, "ponermeEnCamino error: ${e.message}", e)
                if (vistaActiva) {
                    btnAccionPrincipal.isEnabled = true; btnAccionPrincipal.text = "🛵 Ponerme en camino"
                    btnStep1.isEnabled = true; btnStep1.alpha = 0.5f
                    Toast.makeText(act, "Error al actualizar estado", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    // ── Cronómetro ──────────────────────────────────────────────────────
    private fun iniciarCronometro() {
        cronometroActivo = true
        actualizarBtnCronometro(activo = true)
        layoutCronometro.visibility = View.VISIBLE
        handler.post(cronometroRunnable)
    }

    private fun detenerCronometro() {
        cronometroActivo = false
        handler.removeCallbacks(cronometroRunnable)
        actualizarBtnCronometro(activo = false)
    }

    private fun actualizarBtnCronometro(activo: Boolean) {
        // btnCronometro ya es lateinit var, sin ambigüedad ni get() duplicado
        if (activo) {
            btnCronometro.text = "⏹ Detener cronómetro"
            btnCronometro.setBackgroundColor(Color.parseColor("#DC2626"))
        } else {
            btnCronometro.text = "⏱ Iniciar tardanza"
            btnCronometro.setBackgroundColor(Color.parseColor("#D97706"))
        }
    }

    private fun actualizarCronometroUI() {
        if (!vistaActiva) return
        val h = segundosTardanza / 3600; val m = (segundosTardanza % 3600) / 60; val s = segundosTardanza % 60
        tvCronometro.text = String.format("%02d:%02d:%02d", h, m, s)
        val intervalos = intervalosGuardados
        val costo      = intervalos * COSTO_POR_INTERVALO
        tvCostoExtra.text = if (costo > 0)
            "+$ ${fmt.format(costo)} por tardanza ($intervalos x 15 min)"
        else
            "Sin cobro extra aún — cada 15 min = $${fmt.format(COSTO_POR_INTERVALO)}"
    }

    private fun mostrarOpcionesFoto() {
        val ctx = context ?: return; val sheet = BottomSheetDialog(ctx)
        val v = LayoutInflater.from(ctx).inflate(R.layout.bottom_sheet_foto_opciones, null)
        v.findViewById<TextView>(R.id.tvTituloFoto).text = if (modoFotoActual == "factura") "Adjuntar factura" else "Adjuntar comprobante de tardanza"
        v.findViewById<com.google.android.material.button.MaterialButton>(R.id.btnTomarFoto).setOnClickListener { sheet.dismiss(); abrirCamara() }
        v.findViewById<com.google.android.material.button.MaterialButton>(R.id.btnGaleria).setOnClickListener { sheet.dismiss(); abrirGaleria() }
        sheet.setContentView(v); sheet.show()
    }
    private fun abrirCamara() {
        val ctx = context ?: return
        val archivo = File.createTempFile("foto_", ".jpg", ctx.cacheDir)
        uriCamaraTemp = FileProvider.getUriForFile(ctx, "${ctx.packageName}.provider", archivo)
        launcherCamara.launch(uriCamaraTemp!!)
    }
    private fun abrirGaleria() { launcherGaleria.launch(Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)) }
    private fun uriABase64(uri: Uri): String? {
        return try {
            val ctx = context ?: return null
            val bmp = BitmapFactory.decodeStream(ctx.contentResolver.openInputStream(uri))
            val escala = 800f / maxOf(bmp.width, bmp.height).toFloat()
            val bmpR = if (escala < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * escala).toInt(), (bmp.height * escala).toInt(), true) else bmp
            val baos = ByteArrayOutputStream(); bmpR.compress(Bitmap.CompressFormat.JPEG, 60, baos)
            Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) { Log.e(TAG, "uriABase64: ${e.message}"); null }
    }

    private fun agregarFotoB64(b64: String) {
        val lista     = if (modoFotoActual == "factura") fotosFacturas else fotosTardanza
        val chipGroup = if (modoFotoActual == "factura") chipGroupFacturas else chipGroupTardanza
        val idx = lista.size + 1; lista.add(b64)
        val chip = Chip(requireContext()).apply {
            text = if (modoFotoActual == "factura") "Factura $idx" else "Comprobante $idx"
            isCloseIconVisible = true
            setOnCloseIconClickListener { lista.remove(b64); chipGroup.removeView(this) }
            setOnClickListener { mostrarFotoPrevia(b64) }
        }
        chipGroup.addView(chip)
        if (modoFotoActual == "factura") {
            btnGuardarFactura.text = "💾 Guardar factura"
            btnGuardarFactura.setBackgroundColor(Color.parseColor("#1E3A8A"))
            btnGuardarFactura.isEnabled = true
        } else {
            btnGuardarTardanza.text = "💾 Guardar tardanza"
            btnGuardarTardanza.setBackgroundColor(Color.parseColor("#92400E"))
            btnGuardarTardanza.isEnabled = true
        }
    }

    private fun mostrarFotoPrevia(b64: String) {
        val ctx = context ?: return; val bytes = Base64.decode(b64, Base64.NO_WRAP)
        android.app.AlertDialog.Builder(ctx).setView(ImageView(ctx).apply {
            setImageBitmap(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)); adjustViewBounds = true; setPadding(16, 16, 16, 16)
        }).setPositiveButton("Cerrar", null).create().show()
    }

    private fun confirmarEntrega(pedido: PedidoDomi) {
        android.app.AlertDialog.Builder(requireContext())
            .setTitle("¿Confirmar entrega?")
            .setMessage("Pedido #${pedido.idPedido} para ${pedido.nombre}")
            .setPositiveButton("✅ Entregar") { _, _ -> ejecutarEntrega(pedido) }
            .setNegativeButton("Cancelar", null).show()
    }

    private fun ejecutarEntrega(pedido: PedidoDomi) {
        val act = activity as? PanelDomiActivity ?: return
        btnAccionPrincipal.isEnabled = false; btnAccionPrincipal.alpha = 0.5f

        if (cronometroActivo) detenerCronometro()

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val horaFinal = SimpleDateFormat("hh:mm a", Locale("es", "CO")).format(Date())
                val body = JSONObject().apply {
                    put("pedidoId", pedido.idPedido)
                    put("estado", Estados.ENTREGADO)
                }.toString()
                withContext(Dispatchers.IO) {
                    val conn = java.net.URL("https://domicilios-wil.vercel.app/api/foto?recurso=estado")
                        .openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "PATCH"; conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true; conn.outputStream.write(body.toByteArray()); conn.responseCode; conn.disconnect()
                }
                if (!vistaActiva) return@launch

                if (::tvHoraEntregado.isInitialized) { tvHoraEntregado.text = horaFinal; tvHoraEntregado.visibility = View.VISIBLE }
                actualizarBarraProgreso("entregado", ultimaDurSeg, ultimaDistM)
                detenerTracking(); detenerAnimacionRadar()
                act.detenerTracker(); act.tienePedidoEnRuta = false; act.actualizarBadge(1, 0)
                Toast.makeText(act, "✅ Pedido entregado", Toast.LENGTH_SHORT).show()
                handler.postDelayed({ if (vistaActiva) act.binding.bottomNav.selectedItemId = R.id.navHistorial }, 1200L)

            } catch (e: Exception) {
                Log.e(TAG, "ejecutarEntrega error: ${e.message}", e)
                if (vistaActiva) {
                    btnAccionPrincipal.isEnabled = true; btnAccionPrincipal.alpha = 1f
                    Toast.makeText(act, "Error al entregar", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun mostrarDetalleCompleto(p: PedidoDomi) {
        val ctx = context ?: return; val fmt = NumberFormat.getNumberInstance(Locale("es", "CO"))
        val sheet = BottomSheetDialog(ctx)
        val v = LayoutInflater.from(ctx).inflate(R.layout.bottom_sheet_detalle_pedido, null)
        v.findViewById<TextView>(R.id.bsIdPedido).text  = "#${p.idPedido}"
        v.findViewById<TextView>(R.id.bsEstado).text    = p.estado
        v.findViewById<TextView>(R.id.bsNombre).text    = p.nombre
        v.findViewById<TextView>(R.id.bsDireccion).text = p.direccion
        v.findViewById<View>(R.id.btnAbrirMaps).setOnClickListener {
            val destLat = mapaCoordsPendientes?.first; val destLng = mapaCoordsPendientes?.second
            val uri = if (destLat != null && destLng != null)
                android.net.Uri.parse("https://www.google.com/maps/dir/$lastDomiLat,$lastDomiLng/$destLat,$destLng")
            else android.net.Uri.parse("https://maps.google.com/?q=${android.net.Uri.encode(p.direccion)}")
            val intent = Intent(Intent.ACTION_VIEW, uri).apply { setPackage("com.google.android.apps.maps") }
            if (intent.resolveActivity(requireActivity().packageManager) != null) startActivity(intent)
            else startActivity(Intent(Intent.ACTION_VIEW, uri))
        }
        v.findViewById<TextView>(R.id.bsComercio).text   = p.comercio
        v.findViewById<TextView>(R.id.bsHora).text       = "${p.hora}  ${p.fecha}"
        v.findViewById<TextView>(R.id.bsTotal).text      = "$ ${fmt.format(p.total.toLong())}"
        v.findViewById<TextView>(R.id.bsDomicilio).text  = "$ ${fmt.format(p.domicilio.toLong())}"
        v.findViewById<TextView>(R.id.bsMetodoPago).text = p.metodoPago
        if (p.productos.isNotBlank()) {
            v.findViewById<TextView>(R.id.bsProductosLabel).visibility = View.VISIBLE
            v.findViewById<View>(R.id.bsTicketContainer).visibility    = View.VISIBLE
            val rows = v.findViewById<LinearLayout>(R.id.bsProductosRows); rows.removeAllViews()
            p.productos.lines().filter { it.isNotBlank() }.forEach { linea ->
                val fila = LinearLayout(requireContext()).apply {
                    orientation = LinearLayout.HORIZONTAL
                    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).also { it.bottomMargin = 4.dpToPx() }
                }
                fila.addView(TextView(requireContext()).apply {
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    textSize = 12f; typeface = Typeface.MONOSPACE; setTextColor(Color.parseColor("#3F4946"))
                    text = linea.removePrefix("• ").substringBefore(" —").trim()
                })
                fila.addView(TextView(requireContext()).apply {
                    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                    textSize = 12f; typeface = Typeface.MONOSPACE; setTextColor(Color.parseColor("#00897A"))
                    text = linea.substringAfter("— ", "").trim()
                })
                rows.addView(fila)
            }
        }
        val btnLlamar = v.findViewById<Button>(R.id.bsBtnLlamar)
        if (p.telefono.isNotBlank()) { btnLlamar.visibility = View.VISIBLE; btnLlamar.setOnClickListener { startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:${p.telefono}"))) } }
        v.findViewById<Button>(R.id.bsBtnCerrar).setOnClickListener { sheet.dismiss() }
        sheet.setContentView(v); sheet.show()
    }

    private fun distanciaMetros(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6_371_000.0; val phi1 = Math.toRadians(lat1); val phi2 = Math.toRadians(lat2)
        val dPhi = Math.toRadians(lat2 - lat1); val dLam = Math.toRadians(lng2 - lng1)
        val a = Math.sin(dPhi / 2).let { it * it } + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2).let { it * it }
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    }

    private fun Int.dpToPx(): Int = (this * resources.displayMetrics.density).toInt()
}

/* ══════════════════════════════════════════
   FRAGMENT HISTORIAL
══════════════════════════════════════════ */
class HistorialFragment : Fragment() {

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var calMostrado = Calendar.getInstance()
    private var fechaSeleccionada: String = ""
    private var pedidosPorFecha = mutableMapOf<String, List<PedidoDomi>>()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_historial, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val hoy = Calendar.getInstance()
        fechaSeleccionada = String.format("%04d-%02d-%02d", hoy.get(Calendar.YEAR), hoy.get(Calendar.MONTH) + 1, hoy.get(Calendar.DAY_OF_MONTH))
        view.findViewById<com.google.android.material.button.MaterialButton>(R.id.btnMesAnterior).setOnClickListener { calMostrado.add(Calendar.MONTH, -1); renderCalendario(view) }
        view.findViewById<com.google.android.material.button.MaterialButton>(R.id.btnMesSiguiente).setOnClickListener { calMostrado.add(Calendar.MONTH, 1); renderCalendario(view) }
        cargarHistorial(view)
    }

    override fun onDestroyView() { super.onDestroyView(); scope.cancel() }

    private fun cargarHistorial(view: View) {
        val act = activity as? PanelDomiActivity ?: return
        val progress    = view.findViewById<ProgressBar>(R.id.progressBarHistorial)
        val layoutVacio = view.findViewById<View>(R.id.layoutVacioHistorial)
        val layoutCal   = view.findViewById<View>(R.id.layoutCalendario)
        progress.visibility = View.VISIBLE; layoutVacio.visibility = View.GONE; layoutCal.visibility = View.GONE
        scope.launch {
            try {
                val response = withContext(Dispatchers.IO) {
                    val conn = java.net.URL("https://domicilios-wil.vercel.app/api/foto?recurso=pedidos&estado=entregado&domiId=${act.domiId}&limit=200").openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 10_000; conn.readTimeout = 10_000
                    conn.inputStream.bufferedReader().readText().also { conn.disconnect() }
                }
                val data = JSONObject(response).optJSONArray("data") ?: JSONArray()
                pedidosPorFecha.clear()
                for (i in 0 until data.length()) {
                    val p = data.getJSONObject(i)
                    val fechaNorm = normalizarFecha(p.optString("fecha", "").take(10))
                    val itemsArr = p.optJSONArray("items")
                    val productosTexto = buildString { if (itemsArr != null) for (j in 0 until itemsArr.length()) { val it = itemsArr.getJSONObject(j); appendLine("• ${it.optString("producto")} x${it.optInt("cantidad")} — $${it.optDouble("subtotal").toLong()}") } }.trim()
                    val pedido = PedidoDomi(idPedido = p.optString("idPedido","–"), estado = p.optString("estado","entregado"), nombre = p.optString("nombre","–"), telefono = p.optString("telefono",""), direccion = p.optString("direccion","–"), comercio = p.optString("comercio","–"), hora = p.optString("hora",""), fecha = p.optString("fecha",""), total = p.optDouble("total",0.0), domicilio = p.optDouble("domicilio",0.0), metodoPago = p.optString("metodoPago",""), domiId = p.optString("domiciliarioId",""), domiNombre = p.optString("domiciliarioNombre",""), productos = productosTexto, horaToma = p.optString("horaToma",""))
                    (pedidosPorFecha.getOrPut(fechaNorm) { mutableListOf() } as MutableList).add(pedido)
                }
                progress.visibility = View.GONE
                act.actualizarBadge(2, pedidosPorFecha.values.sumOf { it.size })
                if (pedidosPorFecha.isEmpty()) { layoutVacio.visibility = View.VISIBLE } else { layoutCal.visibility = View.VISIBLE; renderCalendario(view); mostrarPedidosDia(view, fechaSeleccionada) }
            } catch (_: Exception) { view.findViewById<ProgressBar>(R.id.progressBarHistorial).visibility = View.GONE; view.findViewById<View>(R.id.layoutVacioHistorial).visibility = View.VISIBLE }
        }
    }

    private fun renderCalendario(view: View) {
        val grid  = view.findViewById<android.widget.GridLayout>(R.id.gridCalendario)
        val tvMes = view.findViewById<TextView>(R.id.tvMesAno)
        val nombresMes = arrayOf("Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre")
        val mes  = calMostrado.get(Calendar.MONTH); val anio = calMostrado.get(Calendar.YEAR)
        tvMes.text = "${nombresMes[mes]} $anio"; grid.removeAllViews(); val ctx = requireContext()
        arrayOf("D","L","M","M","J","V","S").forEach { dia ->
            grid.addView(TextView(ctx).apply {
                text = dia; textSize = 11f; gravity = android.view.Gravity.CENTER; setTextColor(Color.parseColor("#64748B"))
                layoutParams = android.widget.GridLayout.LayoutParams().apply { width = 0; height = android.widget.GridLayout.LayoutParams.WRAP_CONTENT; columnSpec = android.widget.GridLayout.spec(android.widget.GridLayout.UNDEFINED, 1, android.widget.GridLayout.FILL, 1f); setMargins(2, 4, 2, 8) }
            })
        }
        val cal = calMostrado.clone() as Calendar; cal.set(Calendar.DAY_OF_MONTH, 1)
        val primerDia = cal.get(Calendar.DAY_OF_WEEK) - 1; val diasMes = cal.getActualMaximum(Calendar.DAY_OF_MONTH)
        repeat(primerDia) { grid.addView(TextView(ctx).apply { layoutParams = android.widget.GridLayout.LayoutParams().apply { width = 0; height = android.widget.GridLayout.LayoutParams.WRAP_CONTENT; columnSpec = android.widget.GridLayout.spec(android.widget.GridLayout.UNDEFINED, 1, android.widget.GridLayout.FILL, 1f) } }) }
        val hoy = Calendar.getInstance()
        for (d in 1..diasMes) {
            val fechaStr = String.format("%04d-%02d-%02d", anio, mes + 1, d)
            val tienePedidos   = pedidosPorFecha.containsKey(fechaStr)
            val esHoy          = anio == hoy.get(Calendar.YEAR) && mes == hoy.get(Calendar.MONTH) && d == hoy.get(Calendar.DAY_OF_MONTH)
            val esSeleccionado = fechaStr == fechaSeleccionada
            grid.addView(TextView(ctx).apply {
                text = d.toString(); textSize = 12f; gravity = android.view.Gravity.CENTER; setPadding(0, 10, 0, 10)
                when { esSeleccionado -> { setTextColor(Color.WHITE); background = crearCirculo("#007A76") }; tienePedidos -> { setTextColor(Color.parseColor("#38BDF8")); background = crearCirculo("#0F3460") }; esHoy -> { setTextColor(Color.parseColor("#E2E8F0")); background = crearCirculoBorde("#334155") }; else -> { setTextColor(Color.parseColor("#475569")); background = null } }
                layoutParams = android.widget.GridLayout.LayoutParams().apply { width = 0; height = android.widget.GridLayout.LayoutParams.WRAP_CONTENT; columnSpec = android.widget.GridLayout.spec(android.widget.GridLayout.UNDEFINED, 1, android.widget.GridLayout.FILL, 1f); setMargins(3, 3, 3, 3) }
                setOnClickListener { fechaSeleccionada = fechaStr; renderCalendario(view); mostrarPedidosDia(view, fechaStr) }
            })
        }
    }

    private fun mostrarPedidosDia(view: View, fecha: String) {
        val tvFecha         = view.findViewById<TextView>(R.id.tvFechaSeleccionada)
        val tvResumen       = view.findViewById<TextView>(R.id.tvResumenDia)
        val layoutContenido = view.findViewById<View>(R.id.layoutContenidoHistorial)
        val lista           = view.findViewById<LinearLayout>(R.id.listaPedidosHistorial)
        val pedidos = pedidosPorFecha[fecha] ?: emptyList()
        val fmt = NumberFormat.getNumberInstance(Locale("es", "CO"))
        val partes = fecha.split("-")
        val nombresMes = arrayOf("","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre")
        tvFecha.text = if (partes.size == 3) "${partes[2].toIntOrNull() ?: ""} de ${nombresMes.getOrNull(partes[1].toIntOrNull() ?: 0) ?: ""} ${partes[0]}" else fecha
        if (pedidos.isEmpty()) { tvResumen.text = "Sin pedidos este día"; layoutContenido.visibility = View.GONE; return }
        tvResumen.text = "${pedidos.size} pedido${if (pedidos.size != 1) "s" else ""} · Total: $${fmt.format(pedidos.sumOf { it.total }.toLong())} · Dom: $${fmt.format(pedidos.sumOf { it.domicilio }.toLong())}"
        layoutContenido.visibility = View.VISIBLE; lista.removeAllViews()
        pedidos.forEach { pedido ->
            val card = layoutInflater.inflate(R.layout.item_pedido_domi, lista, false)
            card.findViewById<TextView>(R.id.tvIdPedido).text  = "#${pedido.idPedido}"
            card.findViewById<TextView>(R.id.tvCliente).text   = pedido.nombre
            card.findViewById<TextView>(R.id.tvDireccion).text = pedido.direccion
            card.findViewById<TextView>(R.id.tvComercio).text  = pedido.comercio
            card.findViewById<TextView>(R.id.tvHora).text      = pedido.hora
            card.findViewById<TextView>(R.id.tvTotal).text     = "$ ${fmt.format(pedido.total.toLong())}"
            val tvEstado = card.findViewById<TextView>(R.id.tvEstado)
            tvEstado.text = pedido.estado; tvEstado.setTextColor(Color.parseColor("#16A34A"))
            tvEstado.backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#DCFCE7"))
            card.findViewById<Button>(R.id.btnTomarPedido).visibility = View.GONE
            card.findViewById<Button>(R.id.btnVerDetalle).setOnClickListener { mostrarDetalleHistorial(pedido) }
            lista.addView(card)
        }
    }

    private fun mostrarDetalleHistorial(pedido: PedidoDomi) {
        val ctx = context ?: return; val fmt = NumberFormat.getNumberInstance(Locale("es", "CO"))
        val sheet = BottomSheetDialog(ctx); val v = LayoutInflater.from(ctx).inflate(R.layout.bottom_sheet_detalle_pedido, null)
        v.findViewById<TextView>(R.id.bsIdPedido).text   = "#${pedido.idPedido}"
        v.findViewById<TextView>(R.id.bsNombre).text     = pedido.nombre
        v.findViewById<TextView>(R.id.bsDireccion).text  = pedido.direccion
        v.findViewById<TextView>(R.id.bsComercio).text   = pedido.comercio
        v.findViewById<TextView>(R.id.bsTotal).text      = "$ ${fmt.format(pedido.total.toLong())}"
        v.findViewById<TextView>(R.id.bsDomicilio).text  = "$ ${fmt.format(pedido.domicilio.toLong())}"
        v.findViewById<TextView>(R.id.bsMetodoPago).text = pedido.metodoPago
        v.findViewById<TextView>(R.id.bsHora).apply {
            val horaL = pedido.hora.replace("p. m.","PM").replace("a. m.","AM"); val horaT = pedido.horaToma.replace("p. m.","PM").replace("a. m.","AM")
            text = if (horaT.isNotBlank()) "${pedido.fecha}  $horaL\nTomado: $horaT" else "${pedido.fecha}  $horaL"
        }
        v.findViewById<TextView>(R.id.bsEstado).apply { text = pedido.estado; setTextColor(Color.parseColor("#16A34A")); backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#DCFCE7")) }
        v.findViewById<View>(R.id.btnAbrirMaps).setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://maps.google.com/?q=${android.net.Uri.encode(pedido.direccion)}"))) }
        if (pedido.productos.isNotBlank()) {
            v.findViewById<View>(R.id.bsProductosLabel).visibility = View.VISIBLE; v.findViewById<View>(R.id.bsTicketContainer).visibility = View.VISIBLE
            val rows = v.findViewById<LinearLayout>(R.id.bsProductosRows); rows.removeAllViews()
            pedido.productos.lines().filter { it.isNotBlank() }.forEach { linea ->
                val sepIdx = linea.indexOfFirst { it == '—' }.takeIf { it >= 0 } ?: -1
                val productoTexto = (if (sepIdx >= 0) linea.substring(0, sepIdx) else linea).removePrefix("• ").removePrefix("•").trim()
                val subtotalTexto = if (sepIdx >= 0) linea.substring(sepIdx + 1).trim().removePrefix("$").trim().let { if (it.isNotBlank()) "$ $it" else "" } else ""
                val fila = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 6 } }
                fila.addView(TextView(ctx).apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f); text = productoTexto; textSize = 12f; typeface = Typeface.MONOSPACE; setTextColor(Color.parseColor("#1E293B")); setPadding(0,2,8,2) })
                if (subtotalTexto.isNotBlank()) fila.addView(TextView(ctx).apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); text = subtotalTexto; textSize = 12f; typeface = Typeface.MONOSPACE; textAlignment = View.TEXT_ALIGNMENT_TEXT_END; setTextColor(Color.parseColor("#007A76")); setPadding(0,2,0,2) })
                rows.addView(fila)
            }
        }
        v.findViewById<Button>(R.id.bsBtnLlamar).visibility = View.GONE
        v.findViewById<Button>(R.id.bsBtnCerrar).apply { text = "Cerrar"; setOnClickListener { sheet.dismiss() } }
        sheet.setContentView(v); sheet.show()
    }

    private fun crearCirculo(colorHex: String): android.graphics.drawable.Drawable =
        android.graphics.drawable.ShapeDrawable(android.graphics.drawable.shapes.OvalShape()).apply { paint.color = Color.parseColor(colorHex) }

    private fun crearCirculoBorde(colorHex: String): android.graphics.drawable.Drawable =
        android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setStroke(2, Color.parseColor(colorHex)); setColor(Color.TRANSPARENT) }

    private fun normalizarFecha(fecha: String): String = try {
        when { fecha.contains("T") -> fecha.take(10); fecha.contains("/") -> { val p = fecha.split("/"); "${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}" }; else -> fecha.take(10) }
    } catch (_: Exception) { fecha }
}