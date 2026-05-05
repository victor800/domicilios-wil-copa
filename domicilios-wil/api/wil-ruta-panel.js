/* ═══ WIL — PANEL RUTA PREVIA A WAZE ═══ */
(function() {

  /* ── CSS ── */
  var st = document.createElement('style');
  st.textContent =
    '#wilRutaPanel{position:fixed;inset:0;z-index:9600;background:rgba(0,0,0,.55);'
    + 'backdrop-filter:blur(6px);display:none;align-items:flex-end;justify-content:center}'
    + '#wilRutaPanel.open{display:flex}'
    + '#wilRutaBox{width:100%;max-width:520px;background:#f8f9fa;border-radius:28px 28px 0 0;'
    + 'padding:16px 16px calc(24px + env(safe-area-inset-bottom));'
    + 'box-shadow:0 -8px 48px rgba(0,0,0,.35);'
    + 'animation:slideUp .35s cubic-bezier(.22,1,.36,1);max-height:92dvh;overflow-y:auto}'
    + '.wrl-input{width:100%;border:1.5px solid rgba(0,105,112,.25);border-radius:12px;'
    + "padding:10px 12px 10px 36px;font-family:'Plus Jakarta Sans',sans-serif;"
    + 'font-weight:700;font-size:13px;color:#191c1d;outline:none;box-sizing:border-box;'
    + 'background:#fff;transition:border-color .18s}'
    + '.wrl-input:focus{border-color:#006970}'
    + '#wilRutaMapWrap{height:200px;border-radius:16px;overflow:hidden;'
    + 'background:#1a2a2a;margin:12px 0;position:relative}'
    + '#wilRutaMiniMap{width:100%;height:100%;position:absolute;inset:0}';
  document.head.appendChild(st);

  /* ── HTML ── */
  var ov = document.createElement('div');
  ov.id = 'wilRutaPanel';
  ov.innerHTML =
    '<div id="wilRutaBox">'
    + '<div style="width:40px;height:4px;background:#dde2e4;border-radius:4px;margin:0 auto 14px"></div>'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">'
    +   '<div style="width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#006970,#00bcc9);display:flex;align-items:center;justify-content:center;flex-shrink:0">'
    +     '<span class="material-symbols-outlined" style="font-size:18px;color:#fff;font-variation-settings:\'FILL\' 1">alt_route</span>'
    +   '</div>'
    +   '<div><p style="font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:900;font-size:15px;color:#191c1d;margin:0">Ruta del domicilio</p>'
    +   '<p style="font-size:11px;color:#6c7a7b;margin:1px 0 0">Confirma los puntos antes de abrir Waze</p></div>'
    +   '<button onclick="wilCerrarRutaPanel()" style="width:32px;height:32px;border-radius:50%;background:#f3f4f5;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;margin-left:auto;flex-shrink:0;font-size:16px;color:#6c7a7b">✕</button>'
    + '</div>'

    /* Origen */
    + '<div style="position:relative;margin-bottom:8px">'
    +   '<span class="material-symbols-outlined" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:16px;color:#006970;font-variation-settings:\'FILL\' 1;pointer-events:none">storefront</span>'
    +   '<input id="wrl-origen" class="wrl-input" placeholder="📍 Dirección de recogida..." />'
    + '</div>'
    /* Línea conectora */
    + '<div style="display:flex;align-items:center;gap:8px;padding:0 14px;margin-bottom:8px">'
    +   '<div style="width:2px;height:20px;background:repeating-linear-gradient(to bottom,#c5d8ff 0,#c5d8ff 4px,transparent 4px,transparent 8px);margin-left:7px"></div>'
    + '</div>'
    /* Destino */
    + '<div style="position:relative;margin-bottom:4px">'
    +   '<span class="material-symbols-outlined" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:16px;color:#4c56af;font-variation-settings:\'FILL\' 1;pointer-events:none">location_on</span>'
    +   '<input id="wrl-destino" class="wrl-input" placeholder="🏠 Dirección de entrega..." />'
    + '</div>'

    /* Mini mapa */
    + '<div id="wilRutaMapWrap">'
    +   '<div id="wilRutaMiniMap"></div>'
    +   '<div id="wilRutaMapLoader" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#1a2a2a;z-index:5">'
    +     '<div style="width:28px;height:28px;border:3px solid rgba(0,188,200,.3);border-top-color:#00bcc9;border-radius:50%;animation:rot .7s linear infinite"></div>'
    +     '<p style="font-size:11px;color:rgba(255,255,255,.6);font-weight:700;margin:0">Calculando ruta...</p>'
    +   '</div>'
    +   '<div id="wilRutaEta" style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,.72);backdrop-filter:blur(8px);color:#fff;border-radius:10px;padding:5px 10px;display:none;flex-direction:column;gap:1px">'
    +     '<span style="font-size:8px;font-weight:800;color:rgba(255,255,255,.55);text-transform:uppercase">ETA</span>'
    +     '<span id="wilRutaEtaVal" style="font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:900;font-size:13px">—</span>'
    +   '</div>'
    + '</div>'

    /* Botones */
    + '<div style="display:flex;gap:8px;margin-top:4px">'
    +   '<button onclick="wilRutaRecalcular()" style="flex:1;padding:11px;background:#f3f4f5;border:1.5px solid #e7e8e9;border-radius:13px;font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:800;font-size:11px;color:#6c7a7b;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px">'
    +     '<span class="material-symbols-outlined" style="font-size:14px">refresh</span>Recalcular'
    +   '</button>'
    +   '<button onclick="wilAbrirWazeDesdePanel()" id="wilWazePanelBtn" style="flex:3;padding:11px;background:linear-gradient(135deg,#00aaff,#006fff);border:none;border-radius:13px;font-family:\'Plus Jakarta Sans\',sans-serif;font-weight:800;font-size:13px;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 3px 14px rgba(0,110,255,.35)">'
    +     '<svg width="20" height="20" viewBox="0 0 64 64" fill="white"><path d="M32 4C17.6 4 6 15.6 6 30c0 8.4 3.9 15.9 10 20.7V58l8-6.4c2.6.6 5.2.9 8 .9 14.4 0 26-11.6 26-26S46.4 4 32 4z"/><circle cx="24" cy="30" r="3" fill="#00aaff"/><circle cx="40" cy="30" r="3" fill="#00aaff"/><path d="M22 38s4 6 10 6 10-6 10-6" stroke="#00aaff" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>'
    +     'Abrir en Waze'
    +   '</button>'
    + '</div>'
    + '</div>';

  ov.addEventListener('click', function(e){ if(e.target===ov) wilCerrarRutaPanel(); });
  document.body.appendChild(ov);

  /* ── MAPA MINI ── */
  var _miniMap = null, _miniRoute = null, _miniGlow = null;
  var _oriLatP = null, _oriLngP = null;
  var _dstLatP = null, _dstLngP = null;

  function _initMiniMap() {
    if (_miniMap) { _miniMap.invalidateSize({animate:false}); return; }
    _miniMap = L.map('wilRutaMiniMap', {
      zoomControl: false, attributionControl: false,
      maxZoom: 18, minZoom: 10
    }).setView([ANCLA_LAT, ANCLA_LNG], 14);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(_miniMap);
  }

  async function _dibujarRutaMini(oLat, oLng, dLat, dLng) {
    if (!_miniMap) _initMiniMap();

    /* Limpiar capas anteriores */
    if (_miniRoute) { _miniMap.removeLayer(_miniRoute); _miniRoute = null; }
    if (_miniGlow)  { _miniMap.removeLayer(_miniGlow);  _miniGlow  = null; }

    try {
      var url = 'https://router.project-osrm.org/route/v1/driving/'
        + oLng+','+oLat+';'+dLng+','+dLat+'?overview=full&geometries=geojson';
      var r    = await fetch(url, {signal: AbortSignal.timeout(10000)});
      var data = await r.json();
      if (!data.routes || !data.routes[0]) throw new Error('sin ruta');

      var coords = data.routes[0].geometry.coordinates.map(function(c){ return [c[1],c[0]]; });
      var etaMin = Math.max(1, Math.round(data.routes[0].duration / 60));
      var distKm = (data.routes[0].distance / 1000).toFixed(1);

      _miniGlow = L.polyline(coords, {color:'#00bcc9', weight:9, opacity:.2,
        lineJoin:'round', lineCap:'round'}).addTo(_miniMap);
      _miniRoute = L.polyline(coords, {color:'#006970', weight:4, opacity:.9,
        lineJoin:'round', lineCap:'round'}).addTo(_miniMap);

      /* Marcadores */
      var iconO = L.divIcon({className:'',html:'<div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#006970,#00bcc9);border:3px solid #fff;box-shadow:0 3px 10px rgba(0,105,112,.5);display:flex;align-items:center;justify-content:center;font-size:14px">🏪</div>',iconSize:[30,30],iconAnchor:[15,15]});
      var iconD = L.divIcon({className:'',html:'<div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#4c56af,#7c83d6);border:3px solid #fff;box-shadow:0 3px 10px rgba(76,86,175,.5);display:flex;align-items:center;justify-content:center;font-size:14px">🏠</div>',iconSize:[30,30],iconAnchor:[15,15]});
      L.marker([oLat,oLng],{icon:iconO}).addTo(_miniMap);
      L.marker([dLat,dLng],{icon:iconD}).addTo(_miniMap);

      _miniMap.fitBounds(_miniRoute.getBounds(), {padding:[32,32]});

      /* ETA badge */
      var etaEl  = document.getElementById('wilRutaEta');
      var etaVal = document.getElementById('wilRutaEtaVal');
      if (etaEl && etaVal) {
        etaVal.textContent = '~' + etaMin + ' min · ' + distKm + ' km';
        etaEl.style.display = 'flex';
      }

    } catch(e) {
      /* Fallback línea recta */
      _miniRoute = L.polyline([[oLat,oLng],[dLat,dLng]],
        {color:'#6c7a7b', weight:3, dashArray:'8 8'}).addTo(_miniMap);
      _miniMap.fitBounds([[oLat,oLng],[dLat,dLng]], {padding:[32,32]});
    }

    /* Ocultar loader */
    var loader = document.getElementById('wilRutaMapLoader');
    if (loader) loader.style.display = 'none';
  }

  async function _geocodificarSiNecesario(texto, latHint, lngHint, cb) {
    /* Si ya tenemos coords válidas para este texto, usarlas */
    if (latHint && lngHint) { cb(latHint, lngHint); return; }
    var q = encodeURIComponent((texto||'') + ' Copacabana Antioquia Colombia');
    try {
      var r = await fetch('https://nominatim.openstreetmap.org/search?q='+q+'&format=json&limit=1',
        {headers:{'User-Agent':'DomiciliosWIL/1.0'}});
      var d = await r.json();
      if (d && d[0]) cb(parseFloat(d[0].lat), parseFloat(d[0].lon));
      else cb(null, null);
    } catch(e) { cb(null, null); }
  }

  /* ── ABRIR PANEL ── */
  window.wilAbrirRutaPanel = function() {
    /* Leer textos actuales */
    var oriTxt = (document.getElementById('tabOrigen')   && document.getElementById('tabOrigen').textContent)   || '';
    var dstTxt = (document.getElementById('tabDestino')  && document.getElementById('tabDestino').textContent)  || '';

    /* Pre-llenar inputs */
    var inpOri = document.getElementById('wrl-origen');
    var inpDst = document.getElementById('wrl-destino');
    if (inpOri) inpOri.value = oriTxt !== '—' ? oriTxt : '';
    if (inpDst) inpDst.value = dstTxt !== '—' ? dstTxt : '';

    /* Abrir panel */
    ov.classList.add('open');
    document.body.style.overflow = 'hidden';

    /* Reset loader */
    var loader = document.getElementById('wilRutaMapLoader');
    if (loader) loader.style.display = 'flex';
    var etaEl = document.getElementById('wilRutaEta');
    if (etaEl) etaEl.style.display = 'none';

    /* Inicializar mapa y trazar ruta */
    setTimeout(function() {
      _initMiniMap();
      _miniMap.invalidateSize({animate:false});

      /* Coordenadas del domi (origen real) */
      _oriLatP = TRK.lat || ANCLA_LAT;
      _oriLngP = TRK.lng || ANCLA_LNG;

      /* Destino: usar coords ya resueltas si existen */
      _dstLatP = destLatGlobal;
      _dstLngP = destLngGlobal;

      if (_dstLatP) {
        _dibujarRutaMini(_oriLatP, _oriLngP, _dstLatP, _dstLngP);
      } else {
        /* Geocodificar destino desde el texto */
        _geocodificarSiNecesario(inpDst ? inpDst.value : dstTxt, null, null, function(la, lo) {
          if (la && lo) {
            _dstLatP = la; _dstLngP = lo;
            destLatGlobal = la; destLngGlobal = lo;
            _dibujarRutaMini(_oriLatP, _oriLngP, la, lo);
          } else {
            var loader2 = document.getElementById('wilRutaMapLoader');
            if (loader2) loader2.innerHTML =
              '<p style="font-size:11px;color:rgba(255,255,255,.5);font-weight:700;text-align:center;padding:0 20px">⚠️ No se pudo calcular la ruta.<br>Ajusta la dirección y toca Recalcular.</p>';
          }
        });
      }
    }, 150);
  };

  /* ── RECALCULAR (con texto editado) ── */
  window.wilRutaRecalcular = function() {
    var oriTxt = (document.getElementById('wrl-origen') || {}).value || '';
    var dstTxt = (document.getElementById('wrl-destino') || {}).value || '';
    var loader = document.getElementById('wilRutaMapLoader');
    if (loader) { loader.style.display = 'flex'; loader.innerHTML =
      '<div style="width:28px;height:28px;border:3px solid rgba(0,188,200,.3);border-top-color:#00bcc9;border-radius:50%;animation:rot .7s linear infinite"></div>'
      + '<p style="font-size:11px;color:rgba(255,255,255,.6);font-weight:700;margin:0">Recalculando...</p>'; }
    var etaEl = document.getElementById('wilRutaEta');
    if (etaEl) etaEl.style.display = 'none';

    _oriLatP = TRK.lat || ANCLA_LAT;
    _oriLngP = TRK.lng || ANCLA_LNG;

    /* Geocodificar ambos si se editaron */
    _geocodificarSiNecesario(oriTxt, null, null, function(oLa, oLo) {
      if (oLa) { _oriLatP = oLa; _oriLngP = oLo; }
      _geocodificarSiNecesario(dstTxt, null, null, function(dLa, dLo) {
        if (dLa) { _dstLatP = dLa; _dstLngP = dLo; destLatGlobal = dLa; destLngGlobal = dLo; }
        if (_oriLatP && _dstLatP) {
          _dibujarRutaMini(_oriLatP, _oriLngP, _dstLatP, _dstLngP);
        }
      });
    });
  };

  /* ── ABRIR WAZE DESDE PANEL ── */
  window.wilAbrirWazeDesdePanel = function() {
    wilCerrarRutaPanel();
    /* Usar las coords resueltas */
    if (_dstLatP && _dstLngP) {
      destLatGlobal = _dstLatP;
      destLngGlobal = _dstLngP;
    }
    /* Llamar la función original de Waze */
    setTimeout(function() { abrirNavegacion(); }, 200);
  };

  window.wilCerrarRutaPanel = function() {
    ov.classList.remove('open');
    document.body.style.overflow = '';
  };

  /* ── INTERCEPTAR BOTÓN WAZE ── */
  setTimeout(function() {
    var wazeBtn = document.getElementById('wazeFloatBtn');
    if (wazeBtn) {
      var _origClick = wazeBtn.onclick;
      wazeBtn.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        wilAbrirRutaPanel();
      };
    }
  }, 1500);

  console.log('[WIL Ruta Panel v1.0] ✅ Panel intermedio Waze activo');
})();