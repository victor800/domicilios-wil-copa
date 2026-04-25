/* ═══════════════════════════════════════════════════════════
   sw.js — WIL Domicilios — Service Worker v5.0
   
   LÓGICA PRINCIPAL:
   - Pendientes sin asignar: notifica SOLO cuando el número SUBE
     (tenías 3, llegó uno nuevo → ahora hay 4 → notifica)
   - Asignados a mí: notifica UNA sola vez por ID de pedido
   - Guarda estado en IndexedDB para persistir entre reinicios
   ═══════════════════════════════════════════════════════════ */

const SW_VER   = 'wil-sw-v5.0';
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
    const r = db.transaction(DB_STORE,'readonly').objectStore(DB_STORE).get(key);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror   = rej;
  });
}
async function dbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE,'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = res;
    tx.onerror    = rej;
  });
}

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim().then(() => agendarPoll()));
});

self.addEventListener('message', e => {
  const msg = e.data || {};
  if (msg.type === 'GUARDAR_DOMI') {
    dbSet('domi', msg.domi).catch(() => {});
  }
  if (msg.type === 'POLL_AHORA') {
    pollPedidosBackground().catch(() => {});
  }
  if (msg.type === 'LIMPIAR_SESION') {
    dbSet('domi', null).catch(() => {});
    dbSet('asignados_ids', []).catch(() => {});
    dbSet('ultimo_conteo_pendientes', 0).catch(() => {});
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(cs => {
      for (const c of cs) {
        if (c.url && (c.url.includes('domi-panel') || c.url.includes('index'))) {
          c.postMessage({ type: 'OPEN_PEDIDOS' });
          return c.focus();
        }
      }
      return clients.openWindow('/domi-panel.html');
    })
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || '🛵 Domicilios WIL', {
      body:    data.body || 'Tienes un pedido pendiente',
      tag:     data.tag  || 'wil-push',
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      vibrate: [300,100,300,100,500],
      requireInteraction: true,
      data
    })
  );
});

/* ════════════════════════════════════════════
   POLL PRINCIPAL
   ════════════════════════════════════════════ */
async function pollPedidosBackground() {
  const domi = await dbGet('domi');
  if (!domi || !domi.id) return;

  const asignadosIds  = new Set((await dbGet('asignados_ids')) || []);
  const ultimoConteo  = (await dbGet('ultimo_conteo_pendientes')) || 0;

  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`
              + `/gviz/tq?tqx=out:csv&sheet=Pedidos&cachebust=${Date.now()}`;
    const r   = await fetch(url, { cache:'no-store', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const text = await r.text();
    if (!text || text.length < 10) return;

    const filas      = _csvRows(text);
    const nombreBase = _norm(domi.nombre || '').split(' ')[0];
    const idDomi     = (domi.id || '').toUpperCase();

    let pendientesSinAsignar = 0;
    const asignadosNuevos   = [];
    const vistos             = {};

    filas.forEach(cols => {
      const id     = (cols[0]  || '').trim();
      const estado = _normEst(cols[4] || '');
      const asign  = (cols[15] || '').trim();

      if (!id || !/^\d{2,5}$/.test(id) || vistos[id]) return;
      vistos[id] = true;
      if (estado !== 'pendiente') return;

      const asignNorm  = _norm(asign);
      const asignUpper = asign.toUpperCase();
      const esMio = asign && (
        asignNorm.includes(nombreBase) ||
        asignUpper.includes(idDomi)
      );
      const sinAsignar = !asign || asign.trim() === '';

      if (sinAsignar) pendientesSinAsignar++;

      if (esMio && !asignadosIds.has(id)) {
        asignadosNuevos.push({
          id,
          cliente: (cols[1]  || '').trim(),
          dir:     (cols[11] || '').trim(),
          total:   (cols[14] || '').trim(),
          pago:    (cols[3]  || '').trim()
        });
      }
    });

    /* 1. Asignados nuevos → notificar siempre */
    for (const p of asignadosNuevos) {
      await _notifAsignado(p);
      asignadosIds.add(p.id);
    }
    if (asignadosNuevos.length) {
      await dbSet('asignados_ids', [...asignadosIds].slice(-300));
    }

    /* 2. Pendientes → notificar SOLO si el número SUBIÓ */
    if (pendientesSinAsignar > ultimoConteo) {
      const appAbierta = await _appEnForeground();
      if (!appAbierta) {
        await _notifPendientes(pendientesSinAsignar, ultimoConteo);
      }
    }

    /* Guardar conteo actual para próxima comparación */
    await dbSet('ultimo_conteo_pendientes', pendientesSinAsignar);

    await _broadcast({
      type:           'BG_POLL_RESULT',
      pendientes:     pendientesSinAsignar,
      asignadosCount: asignadosNuevos.length
    });

  } catch (e) {
    console.error('[SW poll]', e);
  }
}

async function _notifAsignado(p) {
  const dir = (p.dir || '')
    .replace(/\s*\(Ref:[^)]+\)/g, '').replace(/\s*\[.+?\]/g, '')
    .trim().substring(0, 70);
  const esTrans = (p.pago || '').toLowerCase().includes('transfer');
  const prev = await self.registration.getNotifications({ tag: 'wil-asignado-' + p.id });
  prev.forEach(n => n.close());
  return self.registration.showNotification('🎯 ¡Pedido asignado a ti!', {
    body:    `${p.cliente || 'Cliente'} · ${dir}\n${p.total || ''} · ${esTrans ? 'Transferencia' : 'Efectivo'}`,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/badge-72.png',
    tag:     'wil-asignado-' + p.id,
    requireInteraction: true,
    vibrate: [400,100,400,100,600,200,400,100,400],
    silent:  false,
    data:    { tipo: 'asignado', pedidoId: p.id }
  });
}

async function _notifPendientes(actual, anterior) {
  const nuevos = actual - anterior;
  const prev = await self.registration.getNotifications({ tag: 'wil-pendientes' });
  prev.forEach(n => n.close());
  const titulo = nuevos === 1
    ? '🛵 ¡Nuevo pedido disponible!'
    : `🛵 +${nuevos} pedidos nuevos`;
  const cuerpo = actual === 1
    ? 'Hay 1 pedido pendiente sin tomar'
    : `Hay ${actual} pedidos pendientes sin tomar`;
  return self.registration.showNotification(titulo, {
    body:    cuerpo,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/badge-72.png',
    tag:     'wil-pendientes',
    requireInteraction: false,
    vibrate: [200,80,200,80,200],
    silent:  false,
    data:    { tipo: 'pendientes', cantidad: actual }
  });
}

async function _appEnForeground() {
  const cs = await clients.matchAll({ type:'window', includeUncontrolled:false });
  return cs.some(c => c.visibilityState === 'visible');
}

async function _broadcast(msg) {
  const cs = await clients.matchAll({ type:'window', includeUncontrolled:true });
  cs.forEach(c => c.postMessage(msg));
}

function _norm(s) {
  return (s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,' ').trim();
}

function _normEst(s) {
  const v = (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (v.includes('entregad'))                      return 'entregado';
  if (v.includes('cancelad'))                      return 'cancelado';
  if (v.includes('camino'))                        return 'camino';
  if (v.includes('proceso') || v.includes('ruta')) return 'proceso';
  return 'pendiente';
}

function _csvRows(text) {
  return text.trim().split('\n').filter(Boolean).slice(1).map(line => {
    const cols = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { cols.push(cur.replace(/^"|"$/g,'').trim()); cur = ''; }
      else cur += ch;
    }
    cols.push(cur.replace(/^"|"$/g,'').trim());
    return cols;
  });
}

let _pollTimeout = null;
function agendarPoll() {
  if (_pollTimeout) clearTimeout(_pollTimeout);
  _pollTimeout = setTimeout(async () => {
    await pollPedidosBackground().catch(() => {});
    agendarPoll();
  }, 5 * 60 * 1000);
}

self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => new Response('offline')));
});