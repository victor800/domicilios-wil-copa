/* ═══════════════════════════════════════════════════════════
   domi-notif.js — WIL Domicilios — Módulo de Notificaciones v3.0
   
   INCLUIR justo antes del </body> en el panel del domiciliario:
   <script src="domi-notif.js"></script>
   
   Requiere que sw.js esté en la raíz del sitio.
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Config ── */
  var POLL_BG_MS  = 5 * 60 * 1000;   /* 5 minutos */
  var RADAR_TONES = [440, 660, 880];  /* Frecuencias del sonido radar */
  var SHEET_ID    = '1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU';

  /* ── Estado interno ── */
  var _swReg        = null;
  var _pollTimer    = null;
  var _audioCtx     = null;
  var _notifIds     = _loadNotifIds();
  var _firstPoll    = true;

  /* ══════════════════════════════════════════════════════
     PUNTO DE ENTRADA — llamar desde la app tras login
     WIL_NOTIF.init(domi) donde domi = { id, nombre, ... }
  ══════════════════════════════════════════════════════ */
  window.WIL_NOTIF = {
    init:        init,
    destroy:     destroy,
    testSonido:  testSonido,
    pedirPermiso: pedirPermiso
  };

  /* ══════════════ INIT ══════════════ */
  async function init(domi) {
    if (!domi || !domi.id) return;

    /* 1. Pedir permiso de notificación (si no lo tiene) */
    var permiso = await pedirPermiso();
    if (permiso !== 'granted') {
      console.warn('[WIL-NOTIF] Sin permiso de notificación');
    }

    /* 2. Registrar Service Worker */
    if ('serviceWorker' in navigator) {
      try {
        _swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;

        /* Enviar datos del domi al SW para polling en background */
        _enviarAlSW({ type: 'GUARDAR_DOMI', domi: domi, notifIds: [..._notifIds] });

        /* Escuchar mensajes del SW */
        navigator.serviceWorker.addEventListener('message', _onSwMessage);

        /* Registrar Periodic Background Sync (Chrome 80+) */
        await _registrarPeriodicSync(_swReg);

      } catch (e) {
        console.warn('[WIL-NOTIF] SW error:', e);
      }
    }

    /* 3. Polling activo mientras la app está abierta (cada 5 min) */
    _iniciarPollingActivo(domi);

    /* 4. Poll inmediato al abrir/reabrir la app */
    setTimeout(function () { _pollYNotificar(domi, true); }, 2000);
  }

  /* ══════════════ DESTROY (al cerrar sesión) ══════════════ */
  function destroy() {
    clearInterval(_pollTimer);
    _enviarAlSW({ type: 'LIMPIAR_SESION' });
  }

  /* ══════════════ PEDIR PERMISO ══════════════ */
  async function pedirPermiso() {
    if (!('Notification' in window)) return 'denied';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied')  return 'denied';
    try {
      return await Notification.requestPermission();
    } catch (e) {
      return 'denied';
    }
  }

  /* ══════════════ POLLING ACTIVO (app en foreground) ══════════════ */
  function _iniciarPollingActivo(domi) {
    clearInterval(_pollTimer);
    _pollTimer = setInterval(function () {
      _pollYNotificar(domi, false);
    }, POLL_BG_MS);
  }

  /* ══════════════ POLL + NOTIFICAR ══════════════ */
  async function _pollYNotificar(domi, esInicio) {
    try {
      var url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
                '/gviz/tq?tqx=out:csv&sheet=Pedidos&cachebust=' + Date.now();
      var r   = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!r.ok) return;
      var text = await r.text();
      if (!text || text.length < 10) return;

      var filas        = _parsearCSV(text);
      var nombreBase   = (domi.nombre || '').toLowerCase().split(' ')[0];
      var idDomi       = (domi.id     || '').toUpperCase();
      var pendientes   = 0;
      var asignados    = [];
      var vistos       = {};

      filas.forEach(function (cols) {
        var id      = (cols[0]  || '').trim();
        var estado  = _normEst(cols[4]  || '');
        var asign   = (cols[15] || '').toLowerCase().trim();
        var cliente = (cols[1]  || '').trim();
        var dir     = (cols[11] || '').trim();
        var total   = (cols[14] || '').trim();
        var pago    = (cols[3]  || '').trim();

        if (!id || vistos[id]) return;
        vistos[id] = true;

        var esMio = asign && (
          asign.includes(nombreBase) ||
          asign.toUpperCase().includes(idDomi)
        );

        if (estado === 'pendiente') {
          if (esMio && !_notifIds.has(id)) {
            asignados.push({ id: id, cliente: cliente, dir: dir, total: total, pago: pago });
          } else if (!asign) {
            pendientes++;
          }
        }
      });

      /* ── Notificar asignados nuevos ── */
      asignados.forEach(function (p) {
        _notificarAsignado(p);
        _notifIds.add(p.id);
        /* Informar a la lógica de la app */
        if (window._idsAsignadosNotificados) {
          window._idsAsignadosNotificados.add(p.id);
        }
      });

      /* ── Actualizar SW con nuevos IDs ── */
      if (asignados.length) {
        _enviarAlSW({
          type: 'GUARDAR_DOMI',
          domi: domi,
          notifIds: [..._notifIds]
        });
        _saveNotifIds();
      }

      /* ── Notificación de recordatorio: pedidos pendientes ── */
      if (pendientes > 0 && !esInicio) {
        _notificarPendientes(pendientes, domi);
      }

      /* ── Actualizar badge del icono (si el navegador lo soporta) ── */
      _actualizarBadge(pendientes + asignados.length);

      /* ── Flash interno si la app está en foreground ── */
      if (pendientes > 0 || asignados.length > 0) {
        _flashContadorNav(pendientes + asignados.length);
      }

    } catch (e) {
      /* Silenciar errores de red */
    }
  }

  /* ══════════════ NOTIFICACIÓN: PEDIDO ASIGNADO ══════════════ */
  function _notificarAsignado(p) {
    var dirLimpia = (p.dir || '')
      .replace(/\s*\(Ref:[^)]+\)/g, '')
      .replace(/\s*\[.+?\]/g, '')
      .trim()
      .substring(0, 70);
    var esTrans = (p.pago || '').toLowerCase().includes('transfer');

    /* Banner interno */
    if (window._notifAsignado) {
      window._notifAsignado(p);
    }

    /* Sonido RADAR */
    _sonidoRadar();

    /* Vibrar */
    if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 500]);

    /* Notificación del sistema */
    if (Notification.permission !== 'granted') return;

    var opts = {
      body:   (p.cliente || 'Cliente') + ' · ' + dirLimpia +
              '\n' + (p.total || '') + ' · ' + (esTrans ? 'Transferencia' : 'Efectivo'),
      icon:   '/icons/icon-192.png',
      badge:  '/icons/badge-72.png',
      tag:    'wil-asignado-' + p.id,
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 500],
      silent:  false
    };

    if (_swReg && _swReg.showNotification) {
      _swReg.showNotification('🎯 ¡Pedido asignado a ti!', opts);
    } else {
      new Notification('🎯 ¡Pedido asignado a ti!', opts);
    }
  }

  /* ══════════════ NOTIFICACIÓN: PEDIDOS PENDIENTES ══════════════ */
  function _notificarPendientes(n, domi) {
    /* Sonido suave tipo ping */
    _sonidoPing();

    if (Notification.permission !== 'granted') return;

    var opts = {
      body:    'Hay ' + n + ' pedido' + (n > 1 ? 's' : '') +
               ' esperando en Domicilios WIL',
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     'wil-pendientes',
      requireInteraction: false,
      vibrate: [150, 75, 150],
      silent:  false
    };

    if (_swReg && _swReg.showNotification) {
      _swReg.showNotification('🛵 ' + n + ' pedido' + (n > 1 ? 's' : '') + ' esperando', opts);
    } else {
      new Notification('🛵 ' + n + ' pedido' + (n > 1 ? 's' : '') + ' esperando', opts);
    }
  }

  /* ══════════════ BADGE DE ICONO (como WhatsApp) ══════════════ */
  function _actualizarBadge(n) {
    if (!('setAppBadge' in navigator)) return;
    if (n > 0) {
      navigator.setAppBadge(n).catch(function () {});
    } else {
      navigator.clearAppBadge().catch(function () {});
    }
  }

  /* ══════════════ FLASH CONTADOR EN NAV ══════════════ */
  function _flashContadorNav(n) {
    var el = document.getElementById('navBadge');
    if (!el) return;
    el.style.animation = 'none';
    el.offsetHeight;  /* Reflow */
    el.style.animation = 'wil-flash 0.5s ease 3';
  }

  /* ══════════════ REGISTRO PERIODIC BACKGROUND SYNC ══════════════ */
  async function _registrarPeriodicSync(swReg) {
    if (!swReg || !('periodicSync' in swReg)) return;
    try {
      var perms = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (perms.state === 'granted') {
        await swReg.periodicSync.register('wil-poll-pedidos', {
          minInterval: POLL_BG_MS
        });
      }
    } catch (e) {
      /* Navegadores que no soportan periodicSync */
    }
  }

  /* ══════════════ MENSAJE DESDE SW ══════════════ */
  function _onSwMessage(e) {
    var msg = e.data || {};
    if (msg.type === 'OPEN_PEDIDOS') {
      if (window.switchTab) window.switchTab('pedidos');
    }
    if (msg.type === 'BG_POLL_RESULT' && msg.asignadosCount > 0) {
      /* SW encontró pedidos asignados → recargar la lista */
      if (window.fetchPedidos) window.fetchPedidos();
    }
  }

  /* ══════════════ ENVIAR MENSAJE AL SW ══════════════ */
  function _enviarAlSW(msg) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage(msg);
  }

  /* ══════════════ SONIDO RADAR (3 pitidos ascendentes) ══════════════ */
  function _sonidoRadar() {
    try {
      var ctx = _getAudioCtx();
      if (!ctx) return;
      RADAR_TONES.forEach(function (freq, i) {
        var osc  = ctx.createOscillator();
        var gain = ctx.createGain();
        var t    = ctx.currentTime + i * 0.28;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.4,  t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        osc.start(t);
        osc.stop(t + 0.26);
      });
    } catch (e) {}
  }

  /* ══════════════ SONIDO PING SUAVE ══════════════ */
  function _sonidoPing() {
    try {
      var ctx = _getAudioCtx();
      if (!ctx) return;
      var osc  = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 523; /* Do5 */
      osc.type = 'sine';
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.52);
    } catch (e) {}
  }

  function testSonido() { _sonidoRadar(); }

  function _getAudioCtx() {
    try {
      if (!_audioCtx || _audioCtx.state === 'closed') {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (_audioCtx.state === 'suspended') {
        _audioCtx.resume();
      }
      return _audioCtx;
    } catch (e) { return null; }
  }

  /* ══════════════ PERSISTENCIA IDs notificados ══════════════ */
  function _loadNotifIds() {
    try {
      var arr = JSON.parse(localStorage.getItem('wil_notif_ids') || '[]');
      return new Set(arr);
    } catch (e) { return new Set(); }
  }

  function _saveNotifIds() {
    try {
      localStorage.setItem('wil_notif_ids', JSON.stringify([..._notifIds].slice(-200)));
    } catch (e) {}
  }

  /* ══════════════ HELPERS ══════════════ */
  function _parsearCSV(text) {
    return text.trim().split('\n').filter(Boolean).slice(1).map(function (line) {
      var cols = [], cur = '', inQ = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) { cols.push(cur.replace(/^"|"$/g, '').trim()); cur = ''; }
        else cur += ch;
      }
      cols.push(cur.replace(/^"|"$/g, '').trim());
      return cols;
    });
  }

  function _normEst(s) {
    var v = (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (v.includes('entregad'))                   return 'entregado';
    if (v.includes('camino'))                     return 'camino';
    if (v.includes('proceso') || v.includes('ruta')) return 'proceso';
    return 'pendiente';
  }

  /* ══════════════ CSS: animación flash para badge ══════════════ */
  var _style = document.createElement('style');
  _style.textContent = [
    '@keyframes wil-flash {',
    '  0%,100%{ transform: scale(1); }',
    '  50%    { transform: scale(1.35); background: #f97316; }',
    '}'
  ].join('');
  document.head.appendChild(_style);

})();