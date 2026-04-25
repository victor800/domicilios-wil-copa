/* ═══════════════════════════════════════════════════════════
   sw.js — WIL Domicilios — Service Worker v4.0
   - Pendientes: notifican SIEMPRE cada 5 min (no se guardan)
   - Asignados: se guardan para no repetirse
   - Sonido + vibración fuerte en notif asignados
   ═══════════════════════════════════════════════════════════ */

const SW_VER = 'wil-sw-v4.1';
const SHEET_ID = '1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU';

const DB_NAME  = 'wil_sw_db';
const DB_STORE = 'kv';
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = rej;
  });
}
async function dbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const r  = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = rej;
  });
}
async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = res;
    tx.onerror    = rej;
  });
}

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim().then(() => scheduleNextPoll()));
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || '🛵 Domicilios WIL', {
      body: data.body || 'Tienes un pedido pendiente',
      tag:  data.tag  || 'wil-push',
      icon:  '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      vibrate: [300, 100, 300, 100, 500, 100, 500],
      requireInteraction: true,
      data
    })
  );
});

async function swPollSheet() {
  if (!_swDomi) return;
  try {
    var url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID_DOMI_SW
            + '/gviz/tq?tqx=out:csv&sheet=Pedidos&cachebust=' + Date.now();
    var r    = await fetch(url, { cache: 'no-store' });
    var text = await r.text();
    if (!text || text.length < 20) return;
 
    var filas = swParsearCSV(text);
    var nombre  = (_swDomi.nombre || '').toLowerCase().normalize('NFD')
                    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim()
                    .split(' ')[0];
    var idDomiU = (_swDomi.id || '').toUpperCase().trim();
 
    var nuevoPendiente = null;
    var asignado       = null;
 
    filas.forEach(function(cols) {
      var id   = (cols[0]||'').trim();
      if (!id || !/^\d{2,5}$/.test(id)) return;
      var est  = (cols[4]||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      var asig = (cols[15]||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
      var asigU= (cols[15]||'').toUpperCase();
 
      if (est.includes('entregad') || est.includes('cancelad')) return;
      if (_swNotifIds.has(id)) return;
 
      var esMio = asig.includes(nombre) || asigU.includes(idDomiU);
 
      if (esMio && (est.includes('proceso') || est.includes('asignad') || est.includes('camino'))) {
        _swNotifIds.add(id);
        asignado = { id, cliente: (cols[1]||'').trim(), total: (cols[14]||'').trim(), dir: (cols[11]||'').trim() };
        return;
      }
 
      if (est.includes('pendiente') && (!cols[15] || !cols[15].trim())) {
        _swNotifIds.add(id);
        nuevoPendiente = { id, cliente: (cols[1]||'').trim(), total: (cols[14]||'').trim(), dir: (cols[11]||'').trim() };
      }
    });
 
    if (asignado) {
      await self.registration.showNotification('🎯 ¡Te asignaron un pedido!', {
        body:  asignado.cliente + ' · ' + asignado.total,
        icon:  '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag:   'wil-asig-' + asignado.id,
        requireInteraction: true,
        vibrate: [500,150,500,150,500],
        data: { tipo: 'asignado', pedidoId: asignado.id }
      });
    }
 
    if (nuevoPendiente && !asignado) {
      await self.registration.showNotification('📦 Pedido nuevo disponible', {
        body:  nuevoPendiente.cliente + ' · ' + nuevoPendiente.total,
        icon:  '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag:   'wil-nuevo-' + nuevoPendiente.id,
        requireInteraction: false,
        vibrate: [200,80,200],
        data: { tipo: 'nuevo', pedidoId: nuevoPendiente.id }
      });
    }
 
    var clients = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    if (clients.length > 0) {
      clients[0].postMessage({ type: 'BG_POLL_RESULT', asignadosCount: asignado ? 1 : 0 });
    }
 
  } catch(e) {}
}
 
function swParsearCSV(text) {
  return text.trim().split('\n').filter(Boolean).slice(1).map(function(line) {
    var cols = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.replace(/^"|"$/g,'').trim()); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur.replace(/^"|"$/g,'').trim());
    return cols;
  }).filter(function(c) { return c[0] || c[6]; });
}
 
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var data = e.notification.data || {};
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(cls) {
      if (cls.length > 0) {
        cls[0].focus();
        cls[0].postMessage({ type: data.tipo === 'asignado' ? 'OPEN_RUTA' : 'OPEN_PEDIDOS' });
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      /* Buscar pestaña de la PWA ya abierta */
      for (const c of cs) {
        if (c.url && (c.url.includes('domi-panel') || c.url.includes('index'))) {
          c.postMessage({ type: data.tipo === 'asignado' ? 'OPEN_PEDIDOS' : 'OPEN_PEDIDOS' });
          return c.focus();
        }
      }
      /* Si no hay pestaña abierta, abrir la app */
      return clients.openWindow('/domi-panel.html');
    })
  );
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'wil-poll-pedidos') e.waitUntil(pollPedidosBackground());
});

self.addEventListener('sync', e => {
  if (e.tag === 'wil-poll-now') e.waitUntil(pollPedidosBackground());
});

self.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'GUARDAR_DOMI') {
    dbSet('domi', msg.domi).catch(() => {});
    dbSet('asignados_ids', msg.notifIds || []).catch(() => {});
  }
  if (msg.type === 'POLL_AHORA')     pollPedidosBackground().catch(() => {});
  if (msg.type === 'LIMPIAR_SESION') {
    dbSet('domi', null).catch(() => {});
    dbSet('asignados_ids', []).catch(() => {});
  }
});

async function pollPedidosBackground() {
  const domi = await dbGet('domi');
  if (!domi || !domi.id) return;

  const asignadosIds = new Set((await dbGet('asignados_ids')) || []);

  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Pedidos&cachebust=${Date.now()}`;
    const r   = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const text = await r.text();
    if (!text || text.length < 10) return;

    const filas      = _csvRows(text);
    const nombreBase = (domi.nombre || '').toLowerCase().split(' ')[0];
    const idDomi     = (domi.id     || '').toUpperCase();

    let pendientes = 0;
    let asignados  = [];
    const vistos   = {};

    filas.forEach(cols => {
      const id     = (cols[0]  || '').trim();
      const estado = _normEst(cols[4] || '');
      const asign  = (cols[15] || '').toLowerCase().trim();
      if (!id || vistos[id]) return;
      vistos[id] = true;

      const esMio = asign && (
        asign.includes(nombreBase) ||
        asign.toUpperCase().includes(idDomi)
      );

      if (estado === 'pendiente') {
        if (esMio && !asignadosIds.has(id)) {
          asignados.push({
            id,
            cliente: (cols[1] || '').trim(),
            dir:     (cols[11]|| '').trim(),
            total:   (cols[14]|| '').trim(),
            pago:    (cols[3] || '').trim()
          });
        } else if (!asign) {
          pendientes++;
        }
      }
    });

    /* ASIGNADOS → notificar y guardar para no repetir */
    for (const p of asignados) {
      await mostrarNotifAsignado(p);
      asignadosIds.add(p.id);
    }
    if (asignados.length) {
      await dbSet('asignados_ids', [...asignadosIds].slice(-200));
    }

    /* PENDIENTES → NO guardar → repite cada 5 min */
    if (pendientes > 0) {
      const appAbierta = await _appEnForeground();
      if (!appAbierta) await mostrarNotifPendientes(pendientes);
    }

    await _broadcastToApp({
      type: 'BG_POLL_RESULT',
      pendientes,
      asignadosCount: asignados.length
    });

  } catch (e) {}
}

async function mostrarNotifAsignado(p) {
  const dir = (p.dir || '')
    .replace(/\s*\(Ref:[^)]+\)/g, '')
    .replace(/\s*\[.+?\]/g, '')
    .trim()
    .substring(0, 70);

  /* Cerrar notif anterior del mismo pedido si existe */
  const prev = await self.registration.getNotifications({ tag: 'wil-asignado-' + p.id });
  prev.forEach(n => n.close());

  return self.registration.showNotification('🎯 ¡Pedido asignado a ti!', {
    body: `${p.cliente || 'Cliente'} · ${dir}\n${p.total || ''} · ${
      (p.pago || '').toLowerCase().includes('transfer') ? 'Transferencia' : 'Efectivo'
    }`,
    icon:  '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag:   'wil-asignado-' + p.id,
    requireInteraction: true,
    /* Vibración intensa tipo radar: 3 pulsos fuertes */
    vibrate: [400, 100, 400, 100, 600, 200, 400, 100, 400],
    silent:  false,
    data: { tipo: 'asignado', pedidoId: p.id }
  });
}

async function mostrarNotifPendientes(n) {
  /* Cerrar notif anterior de pendientes */
  const prev = await self.registration.getNotifications({ tag: 'wil-pendientes' });
  prev.forEach(notif => notif.close());

  return self.registration.showNotification(
    `🛵 ${n} pedido${n > 1 ? 's' : ''} esperando`,
    {
      body: `Hay ${n} pedido${n > 1 ? 's' : ''} pendiente${n > 1 ? 's' : ''} sin tomar en Domicilios WIL`,
      icon:  '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag:   'wil-pendientes',
      requireInteraction: false,
      vibrate: [200, 80, 200, 80, 200],
      silent:  false,
      data: { tipo: 'pendientes', cantidad: n }
    }
  );
}

async function _appEnForeground() {
  const cs = await clients.matchAll({ type: 'window', includeUncontrolled: false });
  return cs.some(c => c.visibilityState === 'visible');
}

async function _broadcastToApp(msg) {
  const cs = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  cs.forEach(c => c.postMessage(msg));
}

function _csvRows(text) {
  return text.trim().split('\n').filter(Boolean).slice(1).map(line => {
    const cols = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cols.push(cur.replace(/^"|"$/g, '').trim()); cur = ''; }
      else cur += ch;
    }
    cols.push(cur.replace(/^"|"$/g, '').trim());
    return cols;
  });
}

function _normEst(s) {
  const v = (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (v.includes('entregad'))                       return 'entregado';
  if (v.includes('camino'))                         return 'camino';
  if (v.includes('proceso') || v.includes('ruta'))  return 'proceso';
  return 'pendiente';
}

let _pollTimeout = null;
function scheduleNextPoll() {
  if (_pollTimeout) clearTimeout(_pollTimeout);
  _pollTimeout = setTimeout(async () => {
    await pollPedidosBackground().catch(() => {});
    scheduleNextPoll();
  }, 5 * 60 * 1000); /* cada 5 minutos */
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isNav = e.request.mode === 'navigate';
  const isInstallPage = url.pathname === '/install.html'
    || url.pathname === '/';

  if (isNav && isInstallPage) {
    e.respondWith(Response.redirect('/splash.html', 302));
    return;
  }
  e.respondWith(fetch(e.request));
});