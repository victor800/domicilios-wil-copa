/* ═══════════════════════════════════════════════════════════
   WIL DOMICILIOS — Service Worker con Background Polling
   Versión: 2.0  |  Polling cada 30s en background
   ═══════════════════════════════════════════════════════════ */

var SW_VERSION   = 'wil-sw-v2.0';
var POLL_MS_BG   = 30 * 1000;   // 30 seg en background
var POLL_MS_FG   = 0;            // En foreground lo maneja la página
var SHEET_ID     = '1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU';
var TZ           = 'America/Bogota';

/* ── Estado interno del SW ── */
var _domi          = null;   // { id, nombre, tel }
var _idsNotifEnv   = new Set();  // IDs ya notificados (no repetir)
var _idsPendPrev   = new Set();  // IDs pendientes del poll anterior
var _idsAsigPrev   = new Set();  // IDs asignados del poll anterior
var _pollTimer     = null;
var _appEnForeground = false;    // El cliente nos avisa

/* ════════════════════════════════════════════
   INSTALL / ACTIVATE
════════════════════════════════════════════ */
self.addEventListener('install', function(e) {
  console.log('[SW] Instalando', SW_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  console.log('[SW] Activado', SW_VERSION);
  e.waitUntil(self.clients.claim());
});

/* ════════════════════════════════════════════
   MENSAJES DESDE LA APP
════════════════════════════════════════════ */
self.addEventListener('message', function(e) {
  var msg = e.data || {};

  /* La app nos pasa los datos del domi al iniciar sesión */
  if (msg.type === 'GUARDAR_DOMI') {
    _domi = msg.domi || null;
    /* Si nos pasan IDs ya notificados, no volver a avisarlos */
    if (Array.isArray(msg.notifIds)) {
      msg.notifIds.forEach(function(id) { _idsNotifEnv.add(id); });
    }
    console.log('[SW] Domi registrado:', _domi ? _domi.nombre : 'null');
    /* Arrancar polling si aún no está corriendo */
    _arrancarPolling();
  }

  /* La app nos dice si está en primer plano */
  if (msg.type === 'APP_VISIBLE') {
    _appEnForeground = !!msg.visible;
    if (_appEnForeground) {
      /* La app está al frente → el poll del SW puede ir más lento */
      _detenerPolling();
    } else {
      /* La app fue al background → activar poll agresivo */
      _arrancarPolling();
    }
  }

  /* Limpiar al cerrar sesión */
  if (msg.type === 'LOGOUT') {
    _domi = null;
    _detenerPolling();
    _idsNotifEnv.clear();
    _idsPendPrev.clear();
    _idsAsigPrev.clear();
  }
});

/* ════════════════════════════════════════════
   POLLING EN BACKGROUND
════════════════════════════════════════════ */
function _arrancarPolling() {
  if (_pollTimer) return;          // ya corriendo
  if (!_domi) return;              // sin sesión
  console.log('[SW] Arrancando polling BG cada', POLL_MS_BG / 1000, 's');
  _pollTimer = setInterval(_pollSheet, POLL_MS_BG);
  /* Primera vez inmediata */
  _pollSheet();
}

function _detenerPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

/* ─── Fetch CSV de Pedidos y evaluar ─── */
async function _pollSheet() {
  if (!_domi) return;

  try {
    var url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID
            + '/gviz/tq?tqx=out:csv&sheet=Pedidos&cachebust=' + Date.now();

    var r = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(14000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var text = await r.text();
    if (!text || text.length < 30) throw new Error('vacío');

    var pedidos = _parsearCSV(text);
    _evaluarPedidos(pedidos);

  } catch(e) {
    console.warn('[SW Poll]', e.message);
  }
}

/* ─── Evaluar qué notificar ─── */
function _evaluarPedidos(filas) {
  var nombreBase = _norm(_domi.nombre || '').split(' ')[0];
  var idDomi     = (_domi.id || '').toUpperCase();

  var pedMap = {};
  var lastId = null;

  filas.forEach(function(cols) {
    var id = (cols[0] || '').trim();
    if (id && !/^\d{2,5}$/.test(id)) return;
    if (id) {
      if (!pedMap[id]) {
        pedMap[id] = {
          id,
          cliente:    (cols[1]  || '').trim(),
          estadoRaw:  (cols[4]  || '').trim(),
          direccion:  (cols[11] || '').trim(),
          hora:       (cols[12] || '').trim(),
          total:      (cols[14] || '').trim(),
          domiAsign:  (cols[15] || '').trim(),
          metodoPago: (cols[3]  || '').trim(),
        };
      }
      lastId = id;
    }
  });

  /* ── 1. PEDIDOS PENDIENTES SIN ASIGNAR ── */
  var nuevoPendiente = false;
  var pendientes = [];
  Object.values(pedMap).forEach(function(p) {
    var est = _normEst(p.estadoRaw);
    if (est !== 'pendiente') return;
    if (p.domiAsign && p.domiAsign.trim()) return; // ya tiene domi
    pendientes.push(p);
  });

  /* Solo notificar si hay IDs nuevos que no vimos antes */
  var idsPendActuales = new Set(pendientes.map(function(p) { return p.id; }));
  var idsPendNuevos   = [];
  idsPendActuales.forEach(function(id) {
    if (!_idsPendPrev.has(id) && !_idsNotifEnv.has(id)) {
      idsPendNuevos.push(id);
    }
  });
  _idsPendPrev = idsPendActuales;

  if (idsPendNuevos.length > 0) {
    nuevoPendiente = true;
    var n = pendientes.length;
    idsPendNuevos.forEach(function(id) { _idsNotifEnv.add(id); });

    _mostrarNotif(
      '🛵 ' + n + ' pedido' + (n > 1 ? 's' : '') + ' esperando',
      'Toca para ver ' + (n > 1 ? 'los pedidos' : 'el pedido') + ' en WIL Domicilios',
      { tag: 'wil-pendientes', requireInteraction: false, tipo: 'pendiente' }
    );

    /* Avisar a la página si está en memoria */
    _notificarClientes({ type: 'BG_POLL_RESULT', pendientesCount: n, nuevos: idsPendNuevos });
  }

  /* ── 2. PEDIDO ASIGNADO A ESTE DOMI ── */
  Object.values(pedMap).forEach(function(p) {
    var est = _normEst(p.estadoRaw);
    if (est !== 'asignado' && est !== 'proceso') return;

    var asgNorm  = _norm(p.domiAsign);
    var asgUpper = (p.domiAsign || '').toUpperCase();
    var esMio    = p.domiAsign && (
      asgNorm.includes(nombreBase) || asgUpper.includes(idDomi)
    );
    if (!esMio) return;
    if (_idsAsigPrev.has(p.id)) return;
    if (_idsNotifEnv.has('asig_' + p.id)) return;

    _idsAsigPrev.add(p.id);
    _idsNotifEnv.add('asig_' + p.id);

    var dir = (p.direccion || '')
      .replace(/\s*\(Ref:[^)]+\)/g, '')
      .replace(/\s*\[.+?\]/g, '')
      .trim().substring(0, 60);

    _mostrarNotif(
      '🎯 ¡Te asignaron un pedido!',
      (p.cliente || 'Cliente') + ' · ' + dir + '\n'
      + (p.total || '') + ' · '
      + ((p.metodoPago || '').toLowerCase().includes('transfer') ? 'Transferencia' : 'Efectivo'),
      {
        tag: 'wil-asignado-' + p.id,
        requireInteraction: true,
        tipo: 'asignado',
        pedidoId: p.id,
        vibrate: [500,150,500,150,500,300,300,100,300,100,300]
      }
    );

    _notificarClientes({ type: 'BG_POLL_RESULT', asignadosCount: 1, pedidoId: p.id });
  });
}

/* ─── Mostrar notificación ─── */
async function _mostrarNotif(titulo, cuerpo, opts) {
  /* Si la app está en foreground, no molestar con notif del sistema */
  if (_appEnForeground) return;

  var opciones = {
    body:    cuerpo,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/badge-72.png',
    tag:     opts.tag || 'wil-general',
    vibrate: opts.vibrate || [200, 80, 200],
    silent:  false,
    requireInteraction: opts.requireInteraction || false,
    data: {
      tipo:     opts.tipo || 'general',
      pedidoId: opts.pedidoId || null,
      url:      '/'
    }
  };

  try {
    await self.registration.showNotification(titulo, opciones);
    console.log('[SW Notif]', titulo);
  } catch(e) {
    console.warn('[SW Notif Error]', e.message);
  }
}

/* ─── Avisar a todos los clientes abiertos ─── */
async function _notificarClientes(msg) {
  var clientes = await self.clients.matchAll({ type: 'window' });
  clientes.forEach(function(c) { c.postMessage(msg); });
}

/* ════════════════════════════════════════════
   CLIC EN NOTIFICACIÓN
════════════════════════════════════════════ */
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var data    = e.notification.data || {};
  var tipo    = data.tipo || 'general';
  var tabUrl  = self.location.origin + '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientes) {
        /* Buscar una ventana ya abierta */
        var found = null;
        clientes.forEach(function(c) {
          if (c.url.includes(self.location.origin)) found = c;
        });

        if (found) {
          found.focus();
          /* Decirle a la página qué tab abrir */
          found.postMessage({
            type:     tipo === 'asignado' ? 'OPEN_RUTA' : 'OPEN_PEDIDOS',
            pedidoId: data.pedidoId || null
          });
        } else {
          /* Abrir nueva ventana */
          return self.clients.openWindow(tabUrl);
        }
      })
  );
});

/* ════════════════════════════════════════════
   FETCH (pass-through — no cachear nada del sheet)
════════════════════════════════════════════ */
self.addEventListener('fetch', function(e) {
  /* Solo interceptar recursos del propio origen (assets) */
  if (e.request.url.includes('googleapis.com') ||
      e.request.url.includes('google.com') ||
      e.request.url.includes('openstreetmap') ||
      e.request.url.includes('osrm')) {
    return; /* dejar pasar sin cache */
  }
  /* Para el resto, red directa */
});

/* ════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════ */
function _norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ').trim();
}

function _normEst(s) {
  var v = _norm(s);
  if (v.includes('entregad'))                      return 'entregado';
  if (v.includes('camino'))                        return 'camino';
  if (v.includes('asignad'))                       return 'asignado';
  if (v.includes('proceso') || v.includes('ruta')) return 'proceso';
  if (v.includes('cancelad'))                      return 'cancelado';
  return 'pendiente';
}

function _parsearCSV(text) {
  return text.trim().split('\n')
    .filter(Boolean).slice(1)
    .map(function(line) {
      var cols = [], cur = '', inQ = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur.replace(/^"|"$/g,'').trim()); cur = ''; }
        else { cur += ch; }
      }
      cols.push(cur.replace(/^"|"$/g,'').trim());
      return cols;
    })
    .filter(function(c) { return c[0] || c[6]; });
}