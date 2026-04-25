/* ═══════════════════════════════════════════════════════════════
   DOMICILIOS WIL — PARCHE v3.0
   Pegar justo antes de </body> en domi-panel.html
   Reemplaza el parche v2.1 si lo tenías.

   Corrige 4 bugs:
   A) Pedido fantasma  — reaparece en ruta después de entregar/cancelar
   B) Estados no suben — "En camino" / "Entregado" no llegan al sheet
   C) GPS bloqueado    — no activa aunque el permiso ya estaba dado
   D) Waze sin coordenadas — abre splash en vez de la ruta directo
═══════════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────────────────────────
   A + B ▸ cambiarEstadoPedido
   — usa SCRIPT_URL_DOMI (no la variable privada _SCRIPT_URL)
   — reintenta 1 vez con 2.5 s de espera
   — filasActualizadas=0 solo falla si ok===false
──────────────────────────────────────────────────────────── */
async function cambiarEstadoPedido(nuevoEstado) {
  if (!state.pedidoActivo) return false;

  var hora = new Date().toLocaleTimeString('es-CO',
    { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });

  var payload = {
    accion:    'asignar-domi',
    pedidoId:  String(state.pedidoActivo.id).trim(),
    domi:      domi.nombre,
    estado:    nuevoEstado,
    horaAsign: hora
  };
  if (nuevoEstado === 'En camino')  payload.horaCamino  = hora;
  if (nuevoEstado === 'Entregado')  payload.horaEntrega = hora;
  if (nuevoEstado === 'Cancelado')  payload.horaEntrega = hora;

  for (var intento = 0; intento < 2; intento++) {
    try {
      var r = await fetch(SCRIPT_URL_DOMI, {
        method:  'POST',
        headers: { 'Content-Type': 'text/plain' },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(22000)
      });
      var d = await r.json();
      console.log('[WIL v3 estado]', nuevoEstado, '→', d);
      /* ok:true = éxito aunque filasActualizadas sea 0 (fila ya en ese estado) */
      if (d.ok !== false) return true;
    } catch (e) {
      console.warn('[WIL v3 cambiarEstado] intento', intento + 1, e.message);
      if (intento === 0) await new Promise(function(res){ setTimeout(res, 2500); });
    }
  }
  return false;
}

/* ────────────────────────────────────────────────────────────
   A ▸ marcarEncamino
──────────────────────────────────────────────────────────── */
function marcarEncamino() {
  setStepLoading(true, 'Guardando…');
  cambiarEstadoPedido('En camino').then(function(ok) {
    if (!ok) {
      setStepLoading(false, 'Ponerte en camino');
      alert('No se pudo actualizar. Revisa tu conexión e intenta de nuevo.');
      return;
    }
    state.estadoPedido = 'En camino';
    var s2 = document.getElementById('tab_step2Time');
    if (s2) s2.textContent = new Date().toLocaleTimeString('es-CO',
      { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
    renderStepper(1);
    if (TRK.lat && destLatGlobal)
      dibujarRutaOSRM(TRK.lat, TRK.lng, destLatGlobal, destLngGlobal);
  }).catch(function(e) {
    setStepLoading(false, 'Ponerte en camino');
    alert('Error de red: ' + e.message);
  });
}

/* ────────────────────────────────────────────────────────────
   A + B ▸ marcarEntregado
   FIX CLAVE: idsProcesados.add ANTES del fetch para que el
   polling de 10 s no resucite el pedido mientras el sheet
   tarda en actualizarse. Si el fetch falla → se revierte.
──────────────────────────────────────────────────────────── */
function marcarEntregado() {
  if (!state.pedidoActivo) return;

  var horaReal  = new Date().toLocaleTimeString('es-CO',
    { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
  var pedidoId  = state.pedidoActivo.id;

  /* ► Bloquear YA → el siguiente poll lo ignorará */
  idsProcesados.add(pedidoId);
  setStepLoading(true, 'Confirmando…');

  cambiarEstadoPedido('Entregado').then(function(ok) {
    if (!ok) {
      idsProcesados.delete(pedidoId); /* revertir bloqueo si falló */
      setStepLoading(false, 'Confirmar entrega');
      alert('No se pudo confirmar la entrega. Intenta de nuevo.');
      return;
    }

    state.estadoPedido = 'Entregado';
    var s3 = document.getElementById('tab_step3Time');
    if (s3) s3.textContent = horaReal;
    renderStepper(2);

    if (state.pedidoActivo) {
      state.historial.unshift({
        id:         pedidoId,
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

    setTimeout(function() {
      /* Limpiar mapa */
      if (_tabRouteLayer && _tabMap) { _tabMap.removeLayer(_tabRouteLayer); _tabRouteLayer = null; }
      if (_tabRouteGlow  && _tabMap) { _tabMap.removeLayer(_tabRouteGlow);  _tabRouteGlow  = null; }
      if (_tabDestMarker && _tabMap) { _tabMap.removeLayer(_tabDestMarker); _tabDestMarker = null; }
      if (_tabDomiMarker && _tabMap) {
        _tabDomiMarker.setLatLng([TRK.lat || ANCLA_LAT, TRK.lng || ANCLA_LNG]);
        _tabDomiMarker.setIcon(iconDomi(domi ? domi.nombre : 'WIL', TRK.activo));
      }
      clearInterval(_tabMapInterval);
      detenerNavegacion();
      detenerChatPoll();

      var etaBadge = document.getElementById('mapEtaBadgeTab');
      if (etaBadge) etaBadge.style.display = 'none';
      document.getElementById('wazeFloatBtn').style.display = 'none';

      state.pedidoActivo = null;
      state.estadoPedido = null;
      destLatGlobal      = null;
      destLngGlobal      = null;
      actualizarBadgesNav();

      document.getElementById('pedidoActivoPanel').style.display = 'none';
      document.getElementById('sinPedidoEnRuta').style.display   = 'flex';
      setTimeout(function() { switchTab('historial'); renderHistorial(); }, 500);
    }, 2000);

  }).catch(function(e) {
    idsProcesados.delete(pedidoId);
    setStepLoading(false, 'Confirmar entrega');
    alert('Error: ' + e.message);
  });
}

/* ────────────────────────────────────────────────────────────
   A + B ▸ cancelarPedidoActivo — mismo patrón anti-fantasma
──────────────────────────────────────────────────────────── */
async function cancelarPedidoActivo() {
  if (!state.pedidoActivo) return;
  if (!confirm('¿Cancelar este pedido?')) return;

  var pedidoId = state.pedidoActivo.id;
  var btn = document.getElementById('btnCancelarPed');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelando…'; }

  /* ► Bloquear YA */
  idsProcesados.add(pedidoId);

  var ok = await cambiarEstadoPedido('Cancelado');

  if (ok) {
    var horaCancel = new Date().toLocaleTimeString('es-CO',
      { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
    state.historial.unshift({
      id:         pedidoId,
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

    if (_tabRouteLayer && _tabMap) { _tabMap.removeLayer(_tabRouteLayer); _tabRouteLayer = null; }
    if (_tabRouteGlow  && _tabMap) { _tabMap.removeLayer(_tabRouteGlow);  _tabRouteGlow  = null; }
    clearInterval(_tabMapInterval);
    detenerNavegacion();
    detenerChatPoll();

    document.getElementById('wazeFloatBtn').style.display = 'none';
    state.pedidoActivo = null;
    state.estadoPedido = null;
    destLatGlobal      = null;
    destLngGlobal      = null;

    document.getElementById('pedidoActivoPanel').style.display = 'none';
    document.getElementById('sinPedidoEnRuta').style.display   = 'flex';
    actualizarBadgesNav();
    setTimeout(function() { switchTab('historial'); renderHistorial(); }, 500);

  } else {
    idsProcesados.delete(pedidoId); /* revertir si falló */
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined" '
        + 'style="font-size:15px;font-variation-settings:\'FILL\' 1">cancel</span> Cancelar pedido';
    }
    alert('No se pudo cancelar. Intenta de nuevo.');
  }
}

/* ────────────────────────────────────────────────────────────
   A ▸ aceptarPedido — también necesita el mismo SCRIPT_URL_DOMI
──────────────────────────────────────────────────────────── */
async function aceptarPedido(id) {
  if (state.pedidoActivo) { mostrarPopupPedidoActivo(); return; }
  if (idsProcesados.has(id)) return;

  var btn = document.getElementById('btn-' + id);
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Tomando pedido…';

  var hora = new Date().toLocaleTimeString('es-CO',
    { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });

  try {
    var r = await fetch(SCRIPT_URL_DOMI, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        accion:    'asignar-domi',
        pedidoId:  String(id).trim(),
        domi:      domi.nombre,
        estado:    'En proceso',
        horaAsign: hora
      }),
      signal: AbortSignal.timeout(22000)
    });
    var d = await r.json();

    if (d.ok === false || d.filasActualizadas === 0) {
      btn.innerHTML = '⚠️ Ya fue tomado por otro domi';
      btn.style.background = '#f59e0b';
      idsProcesados.add(id);
      setTimeout(function() {
        state.pedidos = state.pedidos.filter(function(p) { return p.id !== id; });
        renderPedidos();
      }, 2200);
      return;
    }

    idsProcesados.add(id);
    btn.innerHTML = '✅ ¡Pedido tomado!';
    btn.style.background = '#2a9d5c';

    var pedido = state.pedidos.find(function(p) { return p.id === id; });
    if (pedido) {
      pedido.domiAsign    = domi.nombre;
      pedido.estadoRaw    = 'En proceso';
      pedido.estado       = 'proceso';
      pedido.horaAceptado = hora;
    }

    state.pedidos      = state.pedidos.filter(function(p) { return p.id !== id; });
    state.pedidoActivo = pedido;
    state.estadoPedido = 'proceso';

    actualizarBadgesNav();
    activarPedidoEnRuta(pedido);
    setTimeout(function() { switchTab('ruta'); }, 600);

  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined text-white" style="font-size:15px">check_circle</span> Aceptar pedido';
    btn.style.background = '';
    alert('Error de red: ' + e.message);
  }
}

async function aceptarPedidoAsignado(id) {
  if (idsProcesados.has(id)) return;
  var btn = document.getElementById('btn-' + id);
  if (!btn) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Confirmando…';

  var hora = new Date().toLocaleTimeString('es-CO',
    { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });

  try {
    var r = await fetch(SCRIPT_URL_DOMI, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        accion:    'asignar-domi',
        pedidoId:  String(id).trim(),
        domi:      domi.nombre,
        estado:    'En proceso',
        horaAsign: hora
      }),
      signal: AbortSignal.timeout(22000)
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
    btn.innerHTML = '✅ ¡Listo, en ruta!';
    btn.style.background = '#2a9d5c';

    var pedido = state.pedidos.find(function(p) { return p.id === id; });
    if (pedido) {
      pedido.domiAsign    = domi.nombre;
      pedido.estadoRaw    = 'En proceso';
      pedido.estado       = 'proceso';
      pedido.horaAceptado = hora;
    }

    state.pedidos      = state.pedidos.filter(function(p) { return p.id !== id; });
    state.pedidoActivo = pedido;
    state.estadoPedido = 'proceso';

    actualizarBadgesNav();
    if (pedido) activarPedidoEnRuta(pedido);
    setTimeout(function() { switchTab('ruta'); }, 700);

  } catch(e) {
    btn.disabled = false;
    btn.innerHTML = '⚠️ Sin conexión';
    alert('Error: ' + e.message);
  }
}

/* ────────────────────────────────────────────────────────────
   C ▸ trkActivar — GPS robusto
   — detecta PERMISSION_DENIED y muestra instrucciones
   — no crea watchers duplicados
   — tolerancia al timeout (código 3) con timeout extendido
──────────────────────────────────────────────────────────── */
function trkActivar() {
  if (!navigator.geolocation) { trkLog('err', 'GPS no soportado por este dispositivo'); return; }

  /* Evitar watcher duplicado */
  if (TRK.watchId !== null) navigator.geolocation.clearWatch(TRK.watchId);
  if (TRK.envTimer)         { clearInterval(TRK.envTimer); TRK.envTimer = null; }

  TRK.activo = true;
  localStorage.setItem(TRK_KEY, JSON.stringify({ domiId: domi.id, nombre: domi.nombre }));
  trkLog('info', 'Buscando señal GPS…');

  /* Sincronizar UI antes de tener posición */
  trkSyncUI(true);
  if (currentTab === 'ruta') document.getElementById('trkFloatBtn').style.display = 'flex';

  TRK.watchId = navigator.geolocation.watchPosition(
    /* ── Éxito ── */
    function(pos) {
      TRK.lat = pos.coords.latitude;
      TRK.lng = pos.coords.longitude;
      TRK.acc = Math.round(pos.coords.accuracy);
      var coord = TRK.lat.toFixed(5) + ', ' + TRK.lng.toFixed(5);

      var el2 = document.getElementById('trkGpsTxt2'); if (el2) el2.textContent = coord;
      var t2  = document.getElementById('trkAccTag2');
      if (t2) { t2.textContent = '±' + TRK.acc + 'm'; t2.classList.remove('hidden'); }
      var sgt = document.getElementById('shareGpsTxt'); if (sgt) sgt.textContent = coord + ' ±' + TRK.acc + 'm';
      var tus = document.getElementById('trkUltSync2'); if (tus) tus.textContent = horaAhora();

      /* Actualizar marcador en mapa de pestaña */
      if (_tabDomiMarker && _tabMap) {
        _tabDomiMarker.setLatLng([TRK.lat, TRK.lng]);
        _tabDomiMarker.setIcon(iconDomi(domi ? domi.nombre : 'WIL', true));
        if (!state.pedidoActivo && currentTab === 'ruta')
          _tabMap.setView([TRK.lat, TRK.lng], 16, { animate: true });
      }

      /* GPS strip en la tab */
      var glTab  = document.getElementById('gpsLabelTab');  if (glTab)  glTab.textContent = '· GPS activo';
      var dotTab = document.getElementById('gpsDotTab');
      if (dotTab) { dotTab.style.background = '#2a9d5c'; dotTab.classList.add('trk-gps-live'); }

      trkLog('ok', 'GPS ·' + coord + ' ±' + TRK.acc + 'm');
    },
    /* ── Error ── */
    function(err) {
      if (err.code === 1) {
        /* PERMISSION_DENIED */
        TRK.activo = false;
        trkSyncUI(false);
        trkLog('err', '🔒 Ubicación bloqueada por el sistema');
        _mostrarAyudaGPS();
      } else if (err.code === 2) {
        /* POSITION_UNAVAILABLE */
        trkLog('err', 'Sin señal GPS. Sal a un espacio abierto.');
      } else {
        /* TIMEOUT — no apagar el watcher, sigue intentando */
        trkLog('err', 'GPS tardando… sigue buscando señal');
      }
    },
    { enableHighAccuracy: true, maximumAge: 8000, timeout: 30000 }
  );

  trkEnviarUbicacion();
  TRK.envTimer = setInterval(trkEnviarUbicacion, TRK_INTERVAL_MS);
}

/* Instrucciones cuando GPS está bloqueado */
function _mostrarAyudaGPS() {
  var isAndroid = /Android/i.test(navigator.userAgent);
  var isChrome  = /Chrome/i.test(navigator.userAgent) && !/Edge|OPR/i.test(navigator.userAgent);
  var isIOS     = /iPad|iPhone|iPod/i.test(navigator.userAgent) && !window.MSStream;

  /* Banner suave en lugar de un alert */
  var bid = '_gps_help_banner';
  if (document.getElementById(bid)) return;

  var instrucciones = isAndroid && isChrome
    ? 'Toca el ícono 🔒 junto a la URL → "Permisos del sitio" → Ubicación → Permitir'
    : isIOS
    ? 'Ajustes → Privacidad → Servicios de ubicación → Safari/Chrome → "Al usar la app"'
    : 'Habilita la ubicación en los ajustes del navegador → Privacidad → Ubicación';

  var div = document.createElement('div');
  div.id = bid;
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;'
    + 'background:linear-gradient(135deg,#ba1a1a,#e53935);color:#fff;'
    + 'padding:14px 16px;padding-top:calc(14px + env(safe-area-inset-top));'
    + "font-family:'Plus Jakarta Sans',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);";
  div.innerHTML = '<div style="display:flex;align-items:flex-start;gap:10px">'
    + '<span style="font-size:22px;flex-shrink:0;line-height:1.2">📍</span>'
    + '<div style="flex:1"><b style="font-size:13px;font-weight:900">GPS bloqueado</b>'
    + '<p style="font-size:11px;margin:4px 0 0;opacity:.9;line-height:1.5">' + instrucciones + '</p></div>'
    + '<button onclick="this.parentElement.parentElement.remove()" '
    + 'style="background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:50%;'
    + 'width:28px;height:28px;cursor:pointer;flex-shrink:0;font-size:16px">✕</button></div>';
  document.body.appendChild(div);
  setTimeout(function() { var b = document.getElementById(bid); if (b) b.remove(); }, 18000);
}

/* ── Auto-activar GPS si el permiso ya estaba concedido ── */
(function _autoGPS() {
  if (!navigator.permissions) return;
  navigator.permissions.query({ name: 'geolocation' }).then(function(result) {
    if (result.state === 'granted' && !TRK.activo) {
      console.log('[WIL v3] GPS ya autorizado → activando tracker automáticamente');
      trkActivar();
    }
    result.onchange = function() {
      if (result.state === 'denied'  &&  TRK.activo) trkDesactivar();
      if (result.state === 'granted' && !TRK.activo) trkActivar();
    };
  }).catch(function() {});
})();

/* ────────────────────────────────────────────────────────────
   D ▸ Waze — coordenadas precargadas, abre la ruta directo
   — si destLatGlobal ya existe → Waze abre la ruta de inmediato
   — si no → geocodifica primero (con spinner en el botón)
   — Android: intent con fallback URL correcto
   — iOS: esquema waze:// con fallback web
──────────────────────────────────────────────────────────── */
function abrirNavegacion() {
  if (!state.pedidoActivo) { alert('Sin pedido activo.'); return; }

  /* Preservar sesión antes de salir a Waze */
  try { localStorage.setItem('wil_domi', JSON.stringify(domi)); } catch(e) {}

  var lat = destLatGlobal, lng = destLngGlobal;

  if (lat && lng) {
    _lanzarWaze(lat, lng, null);
    return;
  }

  /* Intentar extraer coords embebidas del pedido */
  var coords = extraerCoordenadasPedido(state.pedidoActivo);
  if (coords) {
    destLatGlobal = coords.lat; destLngGlobal = coords.lng;
    _lanzarWaze(coords.lat, coords.lng, null);
    return;
  }

  /* Geocodificar la dirección (mostrar spinner en el botón) */
  var wBtn = document.getElementById('wazeFloatBtn');
  if (wBtn) { wBtn.style.opacity = '0.5'; wBtn.style.pointerEvents = 'none'; }

  var dir = (state.pedidoActivo.direccion || '')
    .replace(/\s*\(Ref:[^)]+\)/g, '').replace(/\s*\[.+?\]/g, '').trim();
  if (!dir) { alert('Sin dirección de entrega.'); return; }

  geocodificarDireccion(dir + ' Copacabana Antioquia Colombia', function(la, lo) {
    if (wBtn) { wBtn.style.opacity = ''; wBtn.style.pointerEvents = ''; }
    if (la && lo) {
      destLatGlobal = la; destLngGlobal = lo;
      _lanzarWaze(la, lo, null);
    } else {
      /* Fallback: abrir Waze con texto de búsqueda */
      _lanzarWaze(null, null, dir + ' Copacabana Antioquia Colombia');
    }
  });
}

function _lanzarWaze(lat, lng, query) {
  var isAndroid = /Android/i.test(navigator.userAgent);
  var isIOS     = /iPad|iPhone|iPod/i.test(navigator.userAgent) && !window.MSStream;

  /* navigate=yes salta la pantalla de bienvenida / vista previa en Waze */
  var params = (lat && lng)
    ? 'll=' + lat.toFixed(6) + ',' + lng.toFixed(6) + '&navigate=yes&zoom=17'
    : 'q='  + encodeURIComponent(query || '') + '&navigate=yes';

  var wazeWeb = 'https://waze.com/ul?' + params;

  if (isAndroid) {
    /*
      intent:// es el método más confiable en Android:
      - Abre Waze directamente en la pantalla de ruta
      - S.browser_fallback_url abre waze.com si la app no está instalada
    */
    var fallback = encodeURIComponent(wazeWeb);
    window.location.href = 'intent://?' + params
      + '#Intent;scheme=waze;package=com.waze;'
      + 'S.browser_fallback_url=' + fallback + ';end';
    /* Si no redirigió en 2.5 s → abrir web como respaldo adicional */
    setTimeout(function() {
      if (!document.hidden) window.open(wazeWeb, '_blank');
    }, 2500);
  } else if (isIOS) {
    window.location.href = 'waze://?' + params;
    setTimeout(function() { window.open(wazeWeb, '_blank'); }, 1800);
  } else {
    window.open(wazeWeb, '_blank');
  }
}

console.log('[WIL Parche v3.0] ✅ Anti-fantasma · Camino/Entregado · GPS · Waze');