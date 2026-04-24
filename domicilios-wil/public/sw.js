/* ═══════════════════════════════════════════════════════════
   sw.js — WIL Domicilios — Service Worker v5.0
   ✅ FETCH HANDLER REAL → Chrome emite beforeinstallprompt
   - Cache-first para assets estáticos (shell de la app)
   - Network-first para peticiones dinámicas / Google Sheets
   - Pendientes: notifican SIEMPRE cada 5 min
   - Asignados: se guardan para no repetirse
   ═══════════════════════════════════════════════════════════ */

const SW_VER       = 'wil-sw-v5.0';
const CACHE_NAME   = 'wil-shell-v5';
const SHEET_ID     = '1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU';

/* Assets que se cachean al instalar el SW (app shell) */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/install.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

/* ── IndexedDB helpers ── */
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

/* ══════════════════════════════════════════════════════════
   INSTALL — precachear el shell de la app
══════════════════════════════════════════════════════════ */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      /* addAll falla si algún asset da 404 → usar add individual */
      return Promise.allSettled(
        SHELL_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    }).then(() => self.skipWaiting())
  );
});

/* ══════════════════════════════════════════════════════════
   ACTIVATE — limpiar caches viejas
══════════════════════════════════════════════════════════ */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => clients.claim())
     .then(() => scheduleNextPoll())
  );
});

/* ══════════════════════════════════════════════════════════
   FETCH — ¡OBLIGATORIO para que Chrome emita beforeinstallprompt!
   Estrategia:
   - Google Sheets / APIs externas → Network only (no cachear)
   - Assets del shell (.html, .js, .css, íconos) → Cache first, fallback network
   - Todo lo demás → Network first, fallback cache
══════════════════════════════════════════════════════════ */
self.addEventListener('fetch', e => {
  const url = e.request.url;

  /* Ignorar peticiones no-GET */
  if (e.request.method !== 'GET') return;

  /* Google Sheets / APIs externas → solo red, sin cachear */
  if (url.includes('docs.google.com') || url.includes('googleapis.com')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  /* Fuentes de Google → cache first */
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          return response;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  /* Shell de la app → cache first, actualizar en background */
  if (url.startsWith(self.location.origin)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const networkFetch = fetch(e.request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return response;
        }).catch(() => null);

        /* Si hay cache, devolver inmediato y actualizar en background */
        if (cached) {
          networkFetch.catch(() => {}); /* actualización silenciosa */
          return cached;
        }
        /* Sin cache → esperar la red */
        return networkFetch.then(r => r || caches.match('/index.html'))
                           .catch(() => caches.match('/index.html'));
      })
    );
    return;
  }

  /* Default → intentar red */
  e.respondWith(
    fetch(e.request).catch(() => new Response('', { status: 503 }))
  );
});

/* ══════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS
══════════════════════════════════════════════════════════ */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || '🛵 Domicilios WIL', {
      body:    data.body  || 'Tienes un pedido pendiente',
      tag:     data.tag   || 'wil-push',
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      vibrate: [300, 100, 300, 100, 500, 100, 500],
      requireInteraction: true,
      data
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
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

/* ══════════════════════════════════════════════════════════
   BACKGROUND SYNC / PERIODIC SYNC
══════════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════════
   POLLING DE PEDIDOS (background)
══════════════════════════════════════════════════════════ */
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
            cliente: (cols[1]  || '').trim(),
            dir:     (cols[11] || '').trim(),
            total:   (cols[14] || '').trim(),
            pago:    (cols[3]  || '').trim()
          });
        } else if (!asign) {
          pendientes++;
        }
      }
    });

    for (const p of asignados) {
      await mostrarNotifAsignado(p);
      asignadosIds.add(p.id);
    }
    if (asignados.length) {
      await dbSet('asignados_ids', [...asignadosIds].slice(-200));
    }

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

  const prev = await self.registration.getNotifications({ tag: 'wil-asignado-' + p.id });
  prev.forEach(n => n.close());

  return self.registration.showNotification('🎯 ¡Pedido asignado a ti!', {
    body: `${p.cliente || 'Cliente'} · ${dir}\n${p.total || ''} · ${
      (p.pago || '').toLowerCase().includes('transfer') ? 'Transferencia' : 'Efectivo'
    }`,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/badge-72.png',
    tag:     'wil-asignado-' + p.id,
    requireInteraction: true,
    vibrate: [400, 100, 400, 100, 600, 200, 400, 100, 400],
    silent:  false,
    data: { tipo: 'asignado', pedidoId: p.id }
  });
}

async function mostrarNotifPendientes(n) {
  const prev = await self.registration.getNotifications({ tag: 'wil-pendientes' });
  prev.forEach(notif => notif.close());

  return self.registration.showNotification(
    `🛵 ${n} pedido${n > 1 ? 's' : ''} esperando`,
    {
      body:    `Hay ${n} pedido${n > 1 ? 's' : ''} pendiente${n > 1 ? 's' : ''} sin tomar en Domicilios WIL`,
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     'wil-pendientes',
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
  }, 5 * 60 * 1000);
}