/* ═══════════════════════════════════════════════════════════════
   DOMICILIOS WIL — PARCHE v2.1
   Aplica este <script> AL FINAL de domi-panel.html, justo antes de </body>
   Corrige 4 bugs:
     1. aceptarPedido → llama al Apps Script correcto y asigna estado
     2. marcarEncamino / marcarEntregado → actualizan el sheet real
     3. GPS se activa automáticamente al arrancar (si el permiso ya está dado)
     4. Waze abre directo con coords del cliente, sin pantalla de bienvenida
═══════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────
   CONSTANTES (ya están en tu HTML, pero las redeclaramos
   de forma segura por si el parche se carga antes)
───────────────────────────────────────────────────────────── */
var _SCRIPT_URL = typeof SCRIPT_URL_DOMI !== 'undefined'
  ? SCRIPT_URL_DOMI
  : 'https://script.google.com/macros/s/AKfycbzPriKpQz0jI9AaYtylsDR_b5oRwMym0rM-dwQKAnjeqhEyxg4HhQ6MBGN_95U4PYJ6tA/exec';

/* ─────────────────────────────────────────────────────────────
   BUG 1 + 2 — Función central para cambiar estado en el sheet
   Reemplaza `cambiarEstadoPedido` del código original.
   Siempre usa accion:'asignar-domi' que el Apps Script conoce.
───────────────────────────────────────────────────────────── */
async function cambiarEstadoPedido(nuevoEstado) {
  if (!state.pedidoActivo) return false;
  var horaActual = new Date().toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota'
  });
  var payload = {
    accion:    'asignar-domi',
    pedidoId:  String(state.pedidoActivo.id).trim(),
    domi:      domi.nombre,
    estado:    nuevoEstado,
    horaAsign: horaActual
  };
  if (nuevoEstado === 'En camino')  payload.horaCamino  = horaActual;
  if (nuevoEstado === 'Entregado')  payload.horaEntrega = horaActual;
  if (nuevoEstado === 'Cancelado')  payload.horaEntrega = horaActual;

  try {
    var r = await fetch(_SCRIPT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(18000)
    });
    var d = await r.json();
    console.log('[estado]', nuevoEstado, '→', d);
    return d.ok !== false;
  } catch (e) {
    console.warn('[cambiarEstadoPedido]', e.message);
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────
   BUG 1 — aceptarPedido: envía al sheet con estado 'En proceso'
   y maneja la respuesta correctamente.
───────────────────────────────────────────────────────────── */
async function aceptarPedido(id) {
  if (state.pedidoActivo) { mostrarPopupPedidoActivo(); return; }
  if (idsProcesados.has(id)) return;

  var btn = document.getElementById('btn-' + id);
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Tomando pedido…';

  var horaAsign = new Date().toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota'
  });

  try {
    var r = await fetch(_SCRIPT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        accion:    'asignar-domi',
        pedidoId:  String(id).trim(),
        domi:      domi.nombre,
        estado:    'En proceso',
        horaAsign: horaAsign
      }),
      signal: AbortSignal.timeout(18000)
    });
    var d = await r.json();

    /* filasActualizadas === 0 → pedido ya fue tomado por otro */
    if (d.ok === false || d.filasActualizadas === 0) {
      btn.innerHTML = '⚠️ Ya fue tomado';
      btn.style.background = '#f59e0b';
      idsProcesados.add(id);
      setTimeout(function () {
        state.pedidos = state.pedidos.filter(function (p) { return p.id !== id; });
        renderPedidos();
      }, 2200);
      return;
    }

    idsProcesados.add(id);
    btn.innerHTML = '<span class="material-symbols-outlined text-white" style="font-size:15px;font-variation-settings:\'FILL\' 1">check_circle</span> ¡Tomado!';
    btn.style.background = '#2a9d5c';

    var pedido = state.pedidos.find(function (p) { return p.id === id; });
    if (pedido) {
      pedido.domiAsign = domi.nombre;
      pedido.estadoRaw = 'En proceso';
      pedido.estado    = 'proceso';
      pedido.horaAceptado = horaAsign;
    }

    state.pedidos      = state.pedidos.filter(function (p) { return p.id !== id; });
    state.pedidoActivo = pedido;
    state.estadoPedido = 'proceso';

    actualizarBadgesNav();
    activarPedidoEnRuta(pedido);
    setTimeout(function () { switchTab('ruta'); }, 600);

  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined text-white" style="font-size:15px">check_circle</span> Aceptar pedido';
    btn.style.background = '';
    alert('Error de red: ' + e.message);
  }
}

/* ─────────────────────────────────────────────────────────────
   BUG 1 (variante asignado) — mismo fix, pero marca 'En proceso'
   cuando el domi acepta un pedido que ya le asignaron.
───────────────────────────────────────────────────────────── */
async function aceptarPedidoAsignado(id) {
  if (idsProcesados.has(id)) return;
  var btn = document.getElementById('btn-' + id);
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Confirmando…';

  var horaAsign = new Date().toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota'
  });

  try {
    var r = await fetch(_SCRIPT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        accion:    'asignar-domi',
        pedidoId:  String(id).trim(),
        domi:      domi.nombre,
        estado:    'En proceso',
        horaAsign: horaAsign
      }),
      signal: AbortSignal.timeout(18000)
    });
    var d = await r.json();

    if (d.ok === false || d.filasActualizadas === 0) {
      btn.disabled = false;
      btn.innerHTML = '⚠️ Error — reintentar';
      btn.style.background = '#f59e0b';
      return;
    }

    idsProcesados.add(id);
    _idsAsignadosNotificados.add(id);
    btn.innerHTML = '<span style="font-size:16px">✅</span> ¡Listo!';
    btn.style.background = '#2a9d5c';

    var pedido = state.pedidos.find(function (p) { return p.id === id; });
    if (pedido) {
      pedido.domiAsign = domi.nombre;
      pedido.estadoRaw = 'En proceso';
      pedido.estado    = 'proceso';
      pedido.horaAceptado = horaAsign;
    }

    state.pedidos      = state.pedidos.filter(function (p) { return p.id !== id; });
    state.pedidoActivo = pedido;
    state.estadoPedido = 'proceso';

    actualizarBadgesNav();
    if (pedido) activarPedidoEnRuta(pedido);
    setTimeout(function () { switchTab('ruta'); }, 700);

  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '⚠️ Sin conexión';
    alert('Error: ' + e.message);
  }
}

/* ─────────────────────────────────────────────────────────────
   BUG 2 — marcarEncamino: llama al sheet real y actualiza UI
───────────────────────────────────────────────────────────── */
function marcarEncamino() {
  setStepLoading(true, 'Guardando…');
  cambiarEstadoPedido('En camino').then(function (ok) {
    if (!ok) {
      setStepLoading(false, 'Ponerte en camino');
      alert('No se pudo cambiar el estado. Verifica tu conexión.');
      return;
    }
    state.estadoPedido = 'En camino';
    var s2 = document.getElementById('tab_step2Time');
    if (s2) s2.textContent = new Date().toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota'
    });
    renderStepper(1);
    /* Redibujar ruta si ya hay GPS y destino */
    if (typeof TRK !== 'undefined' && TRK.lat && destLatGlobal) {
      dibujarRutaOSRM(TRK.lat, TRK.lng, destLatGlobal, destLngGlobal);
    }
  }).catch(function (e) {
    setStepLoading(false, 'Ponerte en camino');
    alert('Error de red: ' + e.message);
  });
}

/* ─────────────────────────────────────────────────────────────
   BUG 2 — marcarEntregado: registra hora real y limpia estado
───────────────────────────────────────────────────────────── */
function marcarEntregado() {
  var horaReal = new Date().toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota'
  });
  setStepLoading(true, 'Confirmando…');
  cambiarEstadoPedido('Entregado').then(function (ok) {
    if (!ok) {
      setStepLoading(false, 'Confirmar entrega');
      alert('No se pudo confirmar la entrega. Intenta de nuevo.');
      return;
    }
    state.estadoPedido = 'Entregado';
    var s3 = document.getElementById('tab_step3Time');
    if (s3) s3.textContent = horaReal;
    renderStepper(2);

    /* Agregar al historial local */
    if (state.pedidoActivo) {
      state.historial.unshift({
        id:         state.pedidoActivo.id,
        cliente:    state.pedidoActivo.cliente,
        direccion:  state.pedidoActivo.direccion,
        total:      state.pedidoActivo.total,
        metodoPago: state.pedidoActivo.metodoPago,
        domicilio:  state.pedidoActivo.domicilio || '',
        hora:       horaReal,
        fecha:      new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }),
        estado:     'Entregado',
        periodo:    'hoy'
      });
    }
    actualizarBadgesNav();

    setTimeout(function () {
      /* Limpiar capas del mapa */
      if (typeof _tabRouteLayer !== 'undefined' && _tabRouteLayer && _tabMap) {
        _tabMap.removeLayer(_tabRouteLayer); _tabRouteLayer = null;
      }
      if (typeof _tabRouteGlow !== 'undefined' && _tabRouteGlow && _tabMap) {
        _tabMap.removeLayer(_tabRouteGlow); _tabRouteGlow = null;
      }
      if (typeof _tabDestMarker !== 'undefined' && _tabDestMarker && _tabMap) {
        _tabMap.removeLayer(_tabDestMarker); _tabDestMarker = null;
      }
      if (typeof _tabDomiMarker !== 'undefined' && _tabDomiMarker && _tabMap) {
        var lat = (typeof TRK !== 'undefined' && TRK.lat) ? TRK.lat : ANCLA_LAT;
        var lng = (typeof TRK !== 'undefined' && TRK.lng) ? TRK.lng : ANCLA_LNG;
        _tabDomiMarker.setLatLng([lat, lng]);
        _tabDomiMarker.setIcon(iconDomi(domi ? domi.nombre : 'WIL', typeof TRK !== 'undefined' && TRK.activo));
      }
      clearInterval(_tabMapInterval);
      if (typeof detenerNavegacion === 'function') detenerNavegacion();
      if (typeof detenerChatPoll  === 'function') detenerChatPoll();

      var etaBadge = document.getElementById('mapEtaBadgeTab');
      if (etaBadge) etaBadge.style.display = 'none';
      var waze = document.getElementById('wazeFloatBtn');
      if (waze) waze.style.display = 'none';

      state.pedidoActivo = null;
      state.estadoPedido = null;
      destLatGlobal = null;
      destLngGlobal = null;
      actualizarBadgesNav();

      document.getElementById('pedidoActivoPanel').style.display = 'none';
      document.getElementById('sinPedidoEnRuta').style.display   = 'flex';

      setTimeout(function () { switchTab('historial'); renderHistorial(); }, 600);
    }, 2500);

  }).catch(function (e) {
    setStepLoading(false, 'Confirmar entrega');
    alert('Error: ' + e.message);
  });
}

/* ─────────────────────────────────────────────────────────────
   BUG 3 — GPS auto-activación
   Si el permiso ya estaba concedido, arranca el tracker
   sin mostrar el popup de bienvenida de nuevo.
───────────────────────────────────────────────────────────── */
(function autoActivarGPS() {
  if (!navigator.permissions) return;
  navigator.permissions.query({ name: 'geolocation' }).then(function (result) {
    if (result.state === 'granted' && typeof TRK !== 'undefined' && !TRK.activo) {
      console.log('[GPS] Permiso ya concedido → activando tracker automáticamente');
      trkActivar();
    }
    /* Si el usuario revoca el permiso mientras la app está abierta */
    result.onchange = function () {
      if (result.state === 'denied' && typeof TRK !== 'undefined' && TRK.activo) {
        trkDesactivar();
      }
    };
  }).catch(function () {});
})();

/* ─────────────────────────────────────────────────────────────
   BUG 4 — Waze directo: abre con coords del cliente precargadas
   sin pasar por la pantalla de inicio/splash de Waze.
   Estrategia: intent:// en Android, waze:// en iOS, web fallback.
   Se espera que destLatGlobal/destLngGlobal ya estén resueltos
   cuando el domiciliario pulsa el botón.
───────────────────────────────────────────────────────────── */
function abrirNavegacion() {
  if (!state.pedidoActivo) { alert('Sin pedido activo.'); return; }

  /* Guardar sesión antes de salir a otra app */
  try { localStorage.setItem('wil_domi', JSON.stringify(domi)); } catch (e) {}

  var lat = destLatGlobal;
  var lng = destLngGlobal;

  if (lat && lng) {
    _abrirWazeCoordenadas(lat, lng);
  } else {
    /* Intentar extraer coords del pedido activo */
    var coords = extraerCoordenadasPedido(state.pedidoActivo);
    if (coords) {
      destLatGlobal = coords.lat;
      destLngGlobal = coords.lng;
      _abrirWazeCoordenadas(coords.lat, coords.lng);
      return;
    }
    /* Fallback: geocodificar la dirección */
    var dir = (state.pedidoActivo.direccion || '')
      .replace(/\s*\(Ref:[^)]+\)/g, '')
      .replace(/\s*\[.+?\]/g, '')
      .trim();
    if (!dir) { alert('No hay dirección de entrega.'); return; }

    geocodificarDireccion(dir + ' Copacabana Antioquia Colombia', function (la, lo) {
      if (la && lo) {
        destLatGlobal = la; destLngGlobal = lo;
        _abrirWazeCoordenadas(la, lo);
      } else {
        /* Último recurso: texto plano */
        _abrirWazeTexto(dir + ' Copacabana Antioquia Colombia');
      }
    });
  }
}

function _abrirWazeCoordenadas(lat, lng) {
  /* navigate=yes salta la splash de Waze y carga la ruta directamente */
  var params = 'll=' + lat.toFixed(6) + ',' + lng.toFixed(6) + '&navigate=yes&zoom=17';
  _lanzarWaze(params);
}

function _abrirWazeTexto(query) {
  var params = 'q=' + encodeURIComponent(query) + '&navigate=yes';
  _lanzarWaze(params);
}

function _lanzarWaze(params) {
  var isAndroid = /Android/i.test(navigator.userAgent);
  var isIOS     = /iPad|iPhone|iPod/i.test(navigator.userAgent) && !window.MSStream;

  if (isAndroid) {
    /*
      intent:// es el método más confiable en Android:
      – Si Waze está instalado, lo abre directamente en la pantalla de ruta.
      – Si no está, abre la Play Store.
      El atributo S.browser_fallback_url abre Waze Web como respaldo.
    */
    var fallback = encodeURIComponent('https://waze.com/ul?' + params);
    window.location.href = 'intent://?' + params
      + '#Intent;scheme=waze;package=com.waze;'
      + 'S.browser_fallback_url=' + fallback + ';end';
  } else if (isIOS) {
    /* waze:// en iOS abre directo si está instalado */
    window.location.href = 'waze://?' + params;
    /* Fallback web si no está instalado (se abre 1.5 s después) */
    setTimeout(function () {
      window.open('https://waze.com/ul?' + params, '_blank');
    }, 1500);
  } else {
    /* Desktop / PWA web */
    window.open('https://waze.com/ul?' + params, '_blank');
  }
}

/* ─────────────────────────────────────────────────────────────
   HELPER — cancelarPedidoActivo: también actualiza el sheet
───────────────────────────────────────────────────────────── */
async function cancelarPedidoActivo() {
  if (!state.pedidoActivo) return;
  if (!confirm('¿Cancelar este pedido?')) return;
  var btn = document.getElementById('btnCancelarPed');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelando…'; }

  var ok = await cambiarEstadoPedido('Cancelado');

  if (ok) {
    var horaCancel = new Date().toLocaleTimeString('es-CO', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota'
    });
    state.historial.unshift({
      id:         state.pedidoActivo.id,
      cliente:    state.pedidoActivo.cliente,
      telefono:   state.pedidoActivo.telefono,
      direccion:  state.pedidoActivo.direccion,
      total:      state.pedidoActivo.total,
      metodoPago: state.pedidoActivo.metodoPago,
      hora:       horaCancel,
      fecha:      new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }),
      estado:     'Cancelado',
      periodo:    'hoy'
    });

    if (typeof _tabRouteLayer !== 'undefined' && _tabRouteLayer && _tabMap) {
      _tabMap.removeLayer(_tabRouteLayer); _tabRouteLayer = null;
    }
    if (typeof _tabRouteGlow !== 'undefined' && _tabRouteGlow && _tabMap) {
      _tabMap.removeLayer(_tabRouteGlow); _tabRouteGlow = null;
    }
    clearInterval(_tabMapInterval);
    if (typeof detenerNavegacion === 'function') detenerNavegacion();
    if (typeof detenerChatPoll   === 'function') detenerChatPoll();

    document.getElementById('wazeFloatBtn').style.display = 'none';
    state.pedidoActivo = null;
    state.estadoPedido = null;
    destLatGlobal = null;
    destLngGlobal = null;

    document.getElementById('pedidoActivoPanel').style.display = 'none';
    document.getElementById('sinPedidoEnRuta').style.display   = 'flex';
    actualizarBadgesNav();
    setTimeout(function () { switchTab('historial'); renderHistorial(); }, 500);
  } else {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px;font-variation-settings:\'FILL\' 1">cancel</span> Cancelar pedido';
    }
    alert('No se pudo cancelar. Intenta de nuevo.');
  }
}

console.log('[WIL Patch v2.1] ✅ Cargado — bugs 1-4 corregidos');