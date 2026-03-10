// ══════════════════════════════════════════════════════════════════════════════
// wilBot.js  — Domicilios WIL  (versión mejorada — card domiciliarios)
// ══════════════════════════════════════════════════════════════════════════════
const { Telegraf, Markup } = require('telegraf');
const moment = require('moment-timezone');
const cron = require('node-cron');

const { extraerProductosIA, detectarIntencion, interpretarDireccion } = require('../services/groq');
const { leerTotalFactura } = require('../services/leerFactura');
const {
  inicializar, fmt, pn,
  getCategorias, getProductosPorCategoria,
  buscarProductos,
  registrarPedido, getPedidos, contarPedidosPorEstado, pendientesSinAtender,
  asignarDomiciliario, marcarEntregado, actualizarTotalPedido, cancelarPedido, actualizarUbicacionPedido,
  verificarClave, guardarTelegramDriver, resumenDia,
  buscarBarrioEnSheet, guardarBarrioEnSheet, getTodosBarriosSheet,
  registrarPostulante, guardarCalificacion
} = require('../services/sheets');
const { tarifasTexto } = require('../data/tarifas');
const {
  calcularDistancia, calcularPreciosPaquete,
  zonaLegible, detectarMunicipioEnTexto, detectarZonaFija,
  esZonaCopacabana, calcularPrecioPorKm, SEDE_LAT, SEDE_LNG
} = require('../services/distancia');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ══════════════════════════════════════════════════════════════════════════════
// ESTADO EN MEMORIA
// ══════════════════════════════════════════════════════════════════════════════
const S = {};   // Sesiones clientes
const drivers = {};   // { telegramId: { nombre, telefono, pedidoActual, loginTs } }
const pool = {};   // Pedidos en memoria
const espClave = {};
const espClaveAdmin = {};
const espMsg = {};
const espFacturaDrv = {};
const espConfirmar = {};
const espTotalManual = {};
const espPostulante = {};
const driversLastSeen = {}; // { telegramId: { nombre, ts } } — última vez en línea

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const esAdmin = id => ADMIN_IDS.length === 0 || ADMIN_IDS.includes(id.toString());
const esDriver = id => !!drivers[id];

// ══════════════════════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════════════════════
const COP = n => {
  if (!n && n !== 0) return '$0';
  const abs = Math.abs(Math.round(n));
  const f = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '-$' : '$') + f;
};

// ── PARCHE 3: Link de Google Maps con la dirección cruda del cliente ──────────
function gmapsLinkDir(direccionCliente) {
  const q = encodeURIComponent((direccionCliente || '') + ', Antioquia, Colombia');
  return `https://maps.google.com/?q=${q}`;
}

function tipoBadge(p) {
  if (!p) return '';
  if (p.tipo === 'paqueteria') return '📦 Paquetería';
  if (p.tienda === 'EXPERTOS') return '💊 FarmaExpertos Copacabana';
  if (p.tienda === 'CENTRAL') return '🏥  Farmacia Central Copacabana';
  return '🏪 WIL';
}

async function getContadores() {
  try {
    const s = await contarPedidosPorEstado();
    return {
      pend: Math.max(s.pendientes, Object.values(pool).filter(p => p.estado === 'PENDIENTE').length),
      proc: Math.max(s.enProceso, Object.values(pool).filter(p => p.estado === 'EN_PROCESO').length),
      fin: s.finalizados
    };
  } catch {
    return {
      pend: Object.values(pool).filter(p => p.estado === 'PENDIENTE').length,
      proc: Object.values(pool).filter(p => p.estado === 'EN_PROCESO').length,
      fin: Object.values(pool).filter(p => p.estado === 'FINALIZADO').length
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// RECARGOS INTERNOS (ocultos al cliente)
// PARCHE 8: Pocos = 1-5 productos (+$1.000), Muchos = 6+ (+$2.000)
// ══════════════════════════════════════════════════════════════════════════════
function calcularRecargos(horaRegistro, cantidadItems, esCopacabana) {
  if (!esCopacabana) return 0;
  let recargo = 0;
  if (horaRegistro) {
    const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
    const t = moment.tz(`${hoy} ${horaRegistro}`, 'DD/MM/YYYY hh:mm A', 'America/Bogota');
    const mins = moment().tz('America/Bogota').diff(t, 'minutes');
    if (mins >= 15) recargo += 1000;
  }
  const items = cantidadItems || 0;
  if (items >= 1 && items <= 5) recargo += 1000;   // pocos productos +$1.000
  if (items > 5) recargo += 2000;                   // muchos productos +$2.000
  return recargo;
}

// ══════════════════════════════════════════════════════════════════════════════
// TRACKER VISUAL — estado del pedido para el cliente
// ══════════════════════════════════════════════════════════════════════════════
function trackerCliente(estado, domiciliario, horaEstimada) {
  const pasos = [
    { key: 'PENDIENTE', label: 'Pedido confirmado' },
    { key: 'EN_PROCESO', label: 'Domiciliario asignado' },
    { key: 'EN_CAMINO', label: 'En camino' },
    { key: 'ENTREGADO', label: 'Entregado' },
  ];
  const orden = ['PENDIENTE', 'EN_PROCESO', 'EN_CAMINO', 'ENTREGADO'];
  const idx = orden.indexOf(estado);

  let msg = `🛵 <b>Domicilios WIL</b>\n<b>━━━━━━━━━━━━━━━━━━━━━</b>\n\n`;

  pasos.forEach((p, i) => {
    const completo = i < idx;
    const activo = i === idx;
    const icono = completo ? '✅' : activo ? '🔘' : '⚪';
    const texto = completo ? `<b>${p.label}</b>` : activo ? `<b>${p.label}</b>` : `<i>${p.label}</i>`;
    msg += `${icono}  ${texto}\n`;
    if (i < pasos.length - 1) {
      msg += (completo ? `<code>│</code>` : `<code>┆</code>`) + `\n`;
    }
  });

  msg += `\n<b>━━━━━━━━━━━━━━━━━━━━━</b>`;
  if (domiciliario) msg += `\n👤  Domiciliario: <b>${domiciliario}</b>`;
  if (horaEstimada) msg += `\n🕐  Entrega estimada: <b>${horaEstimada}</b>`;
  return msg;
}

function calcularHoraEstimada(distKm) {
  const mins = Math.round((distKm || 5) / 30 * 60) + 10;
  const desde = moment().tz('America/Bogota');
  const hasta = moment(desde).add(mins + 10, 'minutes');
  return `${desde.add(mins - 10, 'minutes').format('hh:mm a')} – ${hasta.format('hh:mm a')}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// MENÚS
// ══════════════════════════════════════════════════════════════════════════════
async function menuDriver(uid) {
  const { pend, proc, fin } = await getContadores();
  const d = drivers[uid];
  const hasLoc = d?.lat && d?.latTs && (Date.now() - d.latTs < 3600000);
  const locBtn = hasLoc ? '📍 Ubicación activa ✅' : '📍 Compartir Ubicación';
  return Markup.keyboard([
    [`📋 Pendientes (${pend})`, `🚚 En Proceso (${proc})`],
    [`✅ Finalizados (${fin})`, locBtn],
    [`🚪 Cerrar Sesión`]
  ]).resize();
}

async function menuAdmin() {
  const { pend, proc, fin } = await getContadores().catch(() => ({ pend: 0, proc: 0, fin: 0 }));
  const driversOnline = Object.keys(drivers).length;
  return Markup.keyboard([
    [`📊 Resumen`, `📋 Pendientes${pend > 0 ? ` (${pend})` : ''}`],
    [`🚚 En Proceso${proc > 0 ? ` (${proc})` : ''}`, `✅ Finalizados${fin > 0 ? ` (${fin})` : ''}`],
    [`🛵 Domiciliarios${driversOnline > 0 ? ` (${driversOnline})` : ''}`, `📣 Mensaje Masivo`],
    [`⏰ Recordatorio`, `🔙 Salir Admin`]
  ]).resize();
}

function menuPublico() {
  return Markup.keyboard([
    ['🛵 Hacer Pedido', '📦 Paquetería'],
    ['💲 Ver Tarifas', '🔐 Ingresar como Domiciliario'],
    ['🤝 Trabaja con Nosotros', '👑 Admin']
  ]).resize();
}

// ══════════════════════════════════════════════════════════════════════════════
// CARDS PEDIDO
// PARCHE 5: cardPedidoDriver agrega link Maps con dirección real del cliente
// ══════════════════════════════════════════════════════════════════════════════
function cardPedidoDriver(p, estado) {
  const ico = estado === 'PENDIENTE' ? '🟡' : estado === 'EN_PROCESO' ? '🔵' : '🟢';

  const totalNum = p.total ? Number(p.total) : 0;
  const totalStr = totalNum > 0 ? COP(totalNum) : (p.tienda ? 'Por confirmar' : 'Al facturar');
  const dom = (p.precioDomicilio && Number(p.precioDomicilio) > 0) ? COP(Number(p.precioDomicilio)) : null;

  let productosLista = p.productos || '—';
  if (p.carrito && p.carrito.length > 0) {
    productosLista = p.carrito.map(item =>
      `  · ${item.cantidad}× ${item.descripcion}${item.precioUnitario ? ` ${COP(item.precioUnitario)}` : ''}`
    ).join('\n');
  }

  const card =
    `<code>┌─────────────────────────┐\n` +
    `│ ${ico} ${p.id.padEnd(22)} │\n` +
    `│ ${tipoBadge(p).padEnd(23)} │\n` +
    `├─────────────────────────┤\n` +
    `│ 👤 ${(p.cliente || '?').substring(0, 21).padEnd(21)} │\n` +
    `│ 📱 ${(p.telefono || '?').substring(0, 21).padEnd(21)} │\n` +
    `│ 📍 ${(p.barrio || p.direccion || '?').substring(0, 21).padEnd(21)} │\n` +
    (p.origen ? `│ 🔄 ${p.origen.substring(0, 21).padEnd(21)} │\n` : '') +
    `├─────────────────────────┤\n` +
    `│ 📦 PRODUCTOS            │\n` +
    `${productosLista.split('\n').map(l => `│ ${l.substring(0, 25).padEnd(25)}│`).join('\n')}\n` +
    `├─────────────────────────┤\n` +
    (p.presupuesto ? `│ 💰 ${('Ppto: ' + p.presupuesto).substring(0, 21).padEnd(21)} │\n` : '') +
    (dom ? `│ 🛵 ${'Dom: ' + dom}${' '.repeat(Math.max(0, 21 - ('Dom: ' + dom).length))} │\n` : '') +
    `│ 💵 ${'Total: ' + totalStr}${' '.repeat(Math.max(0, 21 - ('Total: ' + totalStr).length))} │\n` +
    `└─────────────────────────┘</code>`;

  // PARCHE 5: Línea clickeable con la dirección original del cliente
  const dirCliente = p.direccionCliente || p.direccion || '';
  const linkMaps = dirCliente
    ? `\n📍 <a href="${gmapsLinkDir(dirCliente)}">${dirCliente}</a>`
    : '';

  return card + linkMaps;
}

function cardPedidoCliente(s) {
  const sub = (s.carrito || []).reduce((a, i) => a + (i.subtotal || 0), 0);
  const dom = s.precioDomicilio || 0;
  const tot = sub + dom;
  const esWIL = !s.tienda;
  let prods = '';
  if (s.carrito?.length) {
    prods = `\n<b>📦 Productos:</b>\n`;
    s.carrito.forEach((item, i) => {
      if (!esWIL && item.precioUnitario > 0) {
        prods += `  ${i + 1}. ${item.descripcion}\n      ${item.cantidad} × ${COP(item.precioUnitario)} = <b>${COP(item.subtotal)}</b>\n`;
      } else {
        prods += `  ${i + 1}. ${item.descripcion} × ${item.cantidad}\n`;
      }
    });
  }
  return (
    `🛵 <b>PEDIDO WIL</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏪 ${s.negocioNombre || '—'}\n` +
    `👤 ${s.nombre || '—'}   📱 ${s.telefono || '—'}\n` +
    `📍 ${s.direccion || '—'}\n` + prods +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    (esWIL
      ? `🧾 Productos:  <b>Por confirmar</b>\n🛵 Domicilio:  <b>${dom ? COP(dom) : 'Por confirmar'}</b>\n💵 <b>TOTAL: Por confirmar</b>\n`
      : `${sub > 0 ? `🧾 Subtotal:   <b>${COP(sub)}</b>\n` : ''}` +
      `🛵 Domicilio:  <b>${dom ? COP(dom) : 'Por confirmar'}</b>\n` +
      `${tot > 0 ? `💵 <b>TOTAL: ${COP(tot)}</b>\n` : ''}`
    ) +
    `━━━━━━━━━━━━━━━━━━━━━━`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// GEOCODIFICACIÓN Y TARIFAS
// ══════════════════════════════════════════════════════════════════════════════
let _cacheTodosBarrios = null;
let _cacheTodosTs = 0;

async function getTodosBarrios() {
  const ahora = Date.now();
  if (_cacheTodosBarrios && (ahora - _cacheTodosTs) < 10 * 60 * 1000) return _cacheTodosBarrios;
  try {
    const lista = await getTodosBarriosSheet();
    _cacheTodosBarrios = lista || [];
    _cacheTodosTs = ahora;
    return _cacheTodosBarrios;
  } catch { return _cacheTodosBarrios || []; }
}

function _mensajeUbicacion(barrio, zona, municipio, iconConf, validTag) {
  const z = (zona || '').toLowerCase();
  const m = (municipio || '').toLowerCase();

  let zonaDisplay;
  if (z.includes('copacabana') || z.includes('local')) {
    zonaDisplay = 'Copacabana, Antioquia';
  } else if (z.includes('oriente') || m.includes('rionegro') || m.includes('guarne') ||
    m.includes('marinilla') || m.includes('carmen') || m.includes('la ceja')) {
    zonaDisplay = 'Oriente Antioqueño';
  } else if (z.includes('norte') || m.includes('girardota') || m.includes('barbosa')) {
    zonaDisplay = 'Norte de Antioquia';
  } else if (m.includes('bello')) {
    zonaDisplay = 'Bello — Área Metropolitana';
  } else if (m.includes('envigado')) {
    zonaDisplay = 'Envigado — Área Metropolitana';
  } else if (m.includes('itagüí') || m.includes('itagui')) {
    zonaDisplay = 'Itagüí — Área Metropolitana';
  } else if (m.includes('sabaneta')) {
    zonaDisplay = 'Sabaneta — Área Metropolitana';
  } else if (m.includes('la estrella')) {
    zonaDisplay = 'La Estrella — Área Metropolitana';
  } else if (m.includes('caldas')) {
    zonaDisplay = 'Caldas — Área Metropolitana';
  } else if (m.includes('medellín') || m.includes('medellin')) {
    zonaDisplay = 'Medellín';
  } else if (municipio && municipio.length < 50) {
    zonaDisplay = municipio;
  } else if (zona && zona.length < 60) {
    zonaDisplay = zona;
  } else {
    zonaDisplay = 'Área Metropolitana de Medellín';
  }

  return `${iconConf} <b>${barrio}</b>\n📌 ${zonaDisplay}${validTag}`;
}

async function obtenerTarifaRapida(texto, dirRefSheet) {
  console.log(`\n💲 obtenerTarifaRapida: "${texto}" | ancla="${dirRefSheet || 'ninguna'}"`);

  try {
    const r = await buscarBarrioEnSheet(texto);
    if (r) {
      const barrio = r.barrio || texto;
      const zona = r.zona || '';
      const dirF = r.direccion || r.nota || '';

      const { detectarMunicipioEnTexto, calcularTarifaKm } = require('../services/distancia');
      const municipioDirF = detectarMunicipioEnTexto(dirF);
      const municipioZona = zona.toLowerCase().includes('copacabana') ? 'Copacabana' : detectarMunicipioEnTexto(zona);
      const municipio = municipioDirF || municipioZona || null;
      const esCopa = esZonaCopacabana(municipio || 'Copacabana', barrio);

      if (esCopa && r.tarifa !== null) {
        const msg = _mensajeUbicacion(barrio, zona, 'Copacabana', '✅', '');
        return {
          lat: r.lat || null, lng: r.lng || null,
          barrio, tarifa: r.tarifa,
          paqPeq: r.paqPeq || r.tarifa, paqMed: r.paqMed || r.tarifa, paqGran: r.paqGran || r.tarifa,
          nota: dirF, zona, municipio: 'Copacabana',
          mensaje: msg, encontrado: true, esLocal: true
        };
      }

      const coordsAncla = (r.lat && r.lng) ? { lat: r.lat, lng: r.lng } : null;
      if (coordsAncla) console.log(`💾 Cache hit col H/I: "${barrio}" → ${r.lat}, ${r.lng}`);

      let geo = null;
      try {
        geo = await calcularDistancia(texto, dirF || null, coordsAncla);
      } catch (_) { }

      let lat = geo?.lat || r.lat || null;
      let lng = geo?.lng || r.lng || null;
      let tarifaFinal = r.tarifa;

      if (lat && lng) {
        const calc = await calcularTarifaKm(lat, lng);
        tarifaFinal = calc.precio;
        if (!coordsAncla) {
          guardarBarrioEnSheet({
            barrio, lat, lng, tarifa: tarifaFinal,
            direccion: dirF, zona
          }).catch(() => { });
        }
      }

      const iconConf = geo?.confianzaGeo === 'alta' ? '✅' : '⚠️';
      const validTag = (!lat || !lng) ? '\n<i>⚠️ Dirección aproximada — confirmar con el cliente</i>' : '';
      const msg = _mensajeUbicacion(barrio, zona, municipio || '', iconConf, validTag);
      return {
        lat, lng,
        barrio, tarifa: tarifaFinal,
        paqPeq: tarifaFinal, paqMed: tarifaFinal, paqGran: tarifaFinal,
        nota: dirF, zona, municipio: municipio || '',
        mensaje: msg, encontrado: true, esLocal: esCopa
      };
    }
  } catch (e) { console.error('buscarBarrioEnSheet:', e.message); }

  try {
    const todosBarrios = await getTodosBarrios();
    let direccionRef = dirRefSheet || null;
    if (!direccionRef) {
      try {
        const matchSheet = await buscarBarrioEnSheet(texto);
        direccionRef = matchSheet?.direccion || matchSheet?.nota || null;
        if (direccionRef) console.log(`🗺️  Col F recuperada en paso2: "${direccionRef}"`);
      } catch (_) { }
    }
    const refFinal = direccionRef;
    const geo = await calcularDistancia(texto, refFinal, null);

    if (geo && geo.esCobertura) {
      const esCopa = esZonaCopacabana(geo.municipio || '', geo.barrio || '');
      const validTag = geo.observaciones?.includes('⚠️')
        ? `\n<i>⚠️ Dirección aproximada — confirmar con el cliente</i>` : '';
      const iconConf = geo.observaciones?.includes('✅') ? '✅' : '⚠️';
      const msg = _mensajeUbicacion(geo.barrio, geo.zona, geo.municipio, iconConf, validTag);

      let tarifaDom, tarifaPaq;
      if (esCopa) {
        tarifaDom = geo.tarifa || 0;
        tarifaPaq = geo.tarifa || 0;
      } else {
        tarifaDom = geo.tarifa || 0;
        tarifaPaq = geo.tarifa || 0;
      }

      const precios = calcularPreciosPaquete(tarifaPaq);

      guardarBarrioEnSheet({
        barrio: geo.barrio || texto,
        tarifa: tarifaDom || 0,
        paqPeq: precios.paqPeq || 0,
        paqMed: precios.paqMed || 0,
        paqGran: precios.paqGran || 0,
        direccion: direccionRef || geo.direccionFormateada || '',
        zona: geo.zona || '',
        lat: geo.lat || null,
        lng: geo.lng || null
      }).catch(() => { });

      return {
        lat: geo.lat || null,
        lng: geo.lng || null,
        barrio: geo.barrio || texto,
        tarifa: tarifaDom,
        paqPeq: precios.paqPeq,
        paqMed: precios.paqMed,
        paqGran: precios.paqGran,
        nota: direccionRef || '',
        zona: geo.zona,
        municipio: geo.municipio,
        mensaje: msg,
        encontrado: false,
        esLocal: esCopa
      };
    }
  } catch (e) { console.error('calcularDistancia:', e.message); }

  try {
    const todos = await getTodosBarrios();
    const interp = await interpretarDireccion(texto, todos, dirRefSheet);
    if (interp && interp.barrio) {
      const confianza = interp.confianza || 'media';
      const iconConf = confianza === 'alta' ? '⚠️' : '⚠️';
      const validTag = `\n<i>⚠️ Coordenadas aproximadas — confirmar con el cliente</i>`;
      const esCopa = interp.esCopacabana || esZonaCopacabana(interp.municipio || '', interp.barrio);
      const msg = _mensajeUbicacion(interp.barrio, interp.zona, interp.municipio, iconConf, validTag);
      const tarifaBase = interp.tarifa || 0;
      const precios = calcularPreciosPaquete(tarifaBase);

      guardarBarrioEnSheet({
        barrio: texto,
        tarifa: tarifaBase,
        paqPeq: precios.paqPeq || 0,
        paqMed: precios.paqMed || 0,
        paqGran: precios.paqGran || 0,
        direccion: interp.nota || '',
        zona: interp.zona || ''
      }).catch(() => { });

      return {
        lat: interp.lat || null,
        lng: interp.lng || null,
        barrio: interp.barrio,
        tarifa: tarifaBase,
        paqPeq: precios.paqPeq,
        paqMed: precios.paqMed,
        paqGran: precios.paqGran,
        nota: interp.nota || '',
        zona: interp.zona,
        municipio: interp.municipio,
        mensaje: msg,
        encontrado: false,
        esLocal: esCopa
      };
    }
  } catch (e) { console.error('interpretarDireccion:', e.message); }

  guardarBarrioEnSheet({
    barrio: texto, tarifa: null, paqPeq: null, paqMed: null, paqGran: null,
    direccion: '', zona: 'Sin detectar — revisar manualmente'
  }).catch(() => { });

  return {
    barrio: texto, tarifa: null, paqPeq: null, paqMed: null, paqGran: null,
    nota: '', zona: null, municipio: null, esLocal: false,
    mensaje: `⚠️ <b>${texto}</b>\n<i>Dirección no reconocida — el domiciliario confirmará</i>`,
    encontrado: false
  };
}

function buildGmapsUrl(lugar, pedido, driverLat, driverLng) {
  let destino = null;
  if (pedido?.latCliente && pedido?.lngCliente) {
    destino = `${pedido.latCliente},${pedido.lngCliente}`;
  } else if (pedido?.lat && pedido?.lng) {
    destino = `${pedido.lat},${pedido.lng}`;
  } else {
    // PARCHE: usar direccionCliente (la que ingresó el cliente) si existe
    const dir = pedido?.direccionCliente || pedido?.direccion || lugar || '';
    destino = encodeURIComponent(dir + ', Antioquia, Colombia');
  }

  let origen;
  if (driverLat && driverLng) {
    origen = `${driverLat},${driverLng}`;
  } else if (pedido?.tipo === 'paqueteria' && pedido?.origenLat && pedido?.origenLng) {
    origen = `${pedido.origenLat},${pedido.origenLng}`;
  } else {
    origen = `${SEDE_LAT},${SEDE_LNG}`;
  }

  return `https://www.google.com/maps/dir/${origen}/${destino}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// CALIFICACIÓN
// ══════════════════════════════════════════════════════════════════════════════
async function enviarMensajeCalificacion(clienteId, pedidoId) {
  try {
    await bot.telegram.sendMessage(clienteId,
      `🛵 <b>¡Tu pedido fue entregado!</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `<i>Gracias por confiar en Domicilios WIL ❤️</i>\n\n` +
      `¿Deseas calificar nuestro servicio?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('⭐', `cal_${pedidoId}_1`),
          Markup.button.callback('⭐⭐', `cal_${pedidoId}_2`),
          Markup.button.callback('⭐⭐⭐', `cal_${pedidoId}_3`),
          Markup.button.callback('⭐⭐⭐⭐', `cal_${pedidoId}_4`),
          Markup.button.callback('⭐⭐⭐⭐⭐', `cal_${pedidoId}_5`),
        ]])
      }
    );
  } catch (e) { console.error('enviarMensajeCalificacion:', e.message); }
}

bot.action(/^cal_(.+)_(\d)$/, async ctx => {
  const pedidoId = ctx.match[1];
  const estrellas = parseInt(ctx.match[2]);
  await ctx.answerCbQuery('¡Gracias por calificar! ⭐');
  try {
    await ctx.editMessageText(
      `${'⭐'.repeat(estrellas)} <b>¡Gracias por tu calificación!</b>\n\nTu opinión nos ayuda a mejorar. 🛵`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
  } catch (_) { }
  await guardarCalificacion(pedidoId, estrellas);
  if (process.env.CANAL_PEDIDOS_ID) {
    bot.telegram.sendMessage(process.env.CANAL_PEDIDOS_ID,
      `⭐ Calificación recibida — Pedido <b>${pedidoId}</b>: ${'⭐'.repeat(estrellas)} (${estrellas}/5)`,
      { parse_mode: 'HTML' }
    ).catch(() => { });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// HANDLERS PRINCIPALES
// ══════════════════════════════════════════════════════════════════════════════
bot.start(async ctx => {
  const uid = ctx.from.id;
  delete S[uid]; delete drivers[uid];
  delete espClave[uid]; delete espClaveAdmin[uid]; delete espPostulante[uid];
  return ctx.reply(
    `🛵 <b>¡Bienvenido a Domicilios WIL!</b>\n📍 Copacabana, Antioquia 🇨🇴\n\n¿Qué deseas hacer?`,
    { parse_mode: 'HTML', ...menuPublico() }
  );
});

bot.command('cancelar', ctx => {
  const uid = ctx.from.id;
  delete S[uid]; delete espPostulante[uid]; delete espClaveAdmin[uid]; delete espClave[uid];
  return ctx.reply('❌ Cancelado. Escribe /start para comenzar.');
});

// ══════════════════════════════════════════════════════════════════════════════
// HANDLER UBICACIÓN
// ══════════════════════════════════════════════════════════════════════════════
bot.on('location', async ctx => {
  const uid = ctx.from.id;
  const loc = ctx.message.location;
  if (!loc) return;

  const lat = loc.latitude;
  const lng = loc.longitude;
  const esEnVivo = !!(loc.live_period || loc.heading !== undefined);

  const sCliente = S[uid];
  if (sCliente?.tipo === 'pedido' && sCliente?.paso === 'esperando_ubi_cliente') {
    sCliente.latCliente = lat;
    sCliente.lngCliente = lng;
    sCliente.paso = 'referencia';
    const cuBarrio = clienteUbicacion[uid]?.barrio || sCliente.direccion || '';
    if (cuBarrio) {
      guardarBarrioEnSheet({ barrio: cuBarrio, lat, lng }).catch(() => { });
    }
    delete clienteUbicacion[uid];
    console.log(`📍 GPS cliente uid=${uid} barrio="${cuBarrio}": ${lat}, ${lng}`);
    return ctx.reply(
      `✅ <b>¡Ubicación capturada!</b> El domiciliario irá directo a ti.\n\n` +
      `📌 <b>Punto de referencia</b>\n` +
      `<i>Ej: Casa azul, frente al parque, apto 302...</i>\n` +
      `<i>(Escribe "no" si no hay)</i>`,
      { parse_mode: 'HTML' }
    );
  }

  if (!drivers[uid]) {
    return ctx.reply('ℹ️ Solo los domiciliarios activos pueden compartir ubicación.');
  }

  drivers[uid].lat = lat;
  drivers[uid].lng = lng;
  drivers[uid].latTs = Date.now();
  drivers[uid].lastActivity = Date.now();

  if (!driversLastSeen[uid]) driversLastSeen[uid] = {};
  driversLastSeen[uid].nombre = drivers[uid].nombre;
  driversLastSeen[uid].lat = lat;
  driversLastSeen[uid].lng = lng;

  console.log(`📍 ${esEnVivo ? '🔴 VIVO' : 'Manual'} — ${drivers[uid].nombre}: ${lat}, ${lng}`);

  const pedidoId = drivers[uid].pedidoActual;

  if (esEnVivo) return;

  if (pedidoId) {
    const p = pool[pedidoId];
    if (p) {
      const gmaps = buildGmapsUrl(p.barrio || p.direccion || '', p, lat, lng);
      await ctx.reply(
        `📍 <b>Ubicación recibida</b>\n` +
        `🗺️ Tu ruta actualizada:\n${gmaps}\n\n` +
        `<i>El link de "Ver Ruta" en tu pedido también se actualizó.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('🗺️ Ver Ruta Actualizada', gmaps)],
            [Markup.button.callback('✅ Entregar', `entregar_${pedidoId}`)]
          ])
        }
      );
      return;
    }
  }

  await ctx.reply(
    `📍 <b>Ubicación guardada</b>\n` +
    `Cuando tomes un pedido, el link de ruta partirá desde aquí.\n` +
    `<i>Válida por esta sesión.</i>`,
    { parse_mode: 'HTML' }
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// HANDLER TEXTO PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════
bot.action('loc_confirmado', async ctx => {
  try { await ctx.answerCbQuery('✅ ¡Perfecto!'); } catch (_) { }
  try {
    await ctx.editMessageText(
      `✅ <b>Ubicación activa</b>\n` +
      `Tu posición se actualiza automáticamente.\n` +
      `El admin puede ver tu ruta en tiempo real. 🗺️`,
      { parse_mode: 'HTML' }
    );
  } catch (_) { }
});

bot.action(/^cli_skip_ubi_(.+)$/, async ctx => {
  try { await ctx.answerCbQuery(); } catch (_) { }
  const uid = ctx.match[1];
  const s = S[uid];
  if (!s || s.tipo !== 'pedido') return;
  delete clienteUbicacion[uid];
  s.paso = 'referencia';
  try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) { }
  return ctx.reply(
    `📌 <b>Punto de referencia</b>\n` +
    `<i>Ej: Casa azul, frente al parque, apto 302...</i>\n` +
    `<i>(Escribe "no" si no hay)</i>`,
    { parse_mode: 'HTML' }
  );
});

const clienteUbicacion = {};

bot.on('edited_message', async ctx => {
  const msg = ctx.editedMessage;
  if (!msg?.location) return;
  const uid = msg.from?.id;
  if (!uid) return;
  const lat = msg.location.latitude;
  const lng = msg.location.longitude;

  if (drivers[uid]) {
    drivers[uid].lat = lat;
    drivers[uid].lng = lng;
    drivers[uid].latTs = Date.now();
    drivers[uid].lastActivity = Date.now();
    if (!driversLastSeen[uid]) driversLastSeen[uid] = {};
    driversLastSeen[uid].nombre = drivers[uid].nombre;
    driversLastSeen[uid].lat = lat;
    driversLastSeen[uid].lng = lng;
    console.log(`🔴 VIVO driver ${drivers[uid].nombre}: ${lat}, ${lng}`);
    return;
  }

  const cu = clienteUbicacion[uid];
  if (cu?.pedidoId && pool[cu.pedidoId]) {
    const p = pool[cu.pedidoId];
    p.latCliente = lat;
    p.lngCliente = lng;
    p.latTs = Date.now();
    actualizarUbicacionPedido(cu.pedidoId, lat, lng).catch(() => { });
    console.log(`📍 VIVO cliente pedido=${cu.pedidoId}: ${lat}, ${lng}`);
  }
});

bot.on('text', async ctx => {
  const uid = ctx.from.id;
  const txt = ctx.message.text.trim();
  const mid = ctx.message.message_id;
  if (txt.startsWith('/')) return;

  if (drivers[uid]) drivers[uid].lastActivity = Date.now();

  if (drivers[uid] || esAdmin(uid)) {
    if (txt.includes('📋 Pendientes')) return await mostrarPendientes(ctx);
    if (txt.includes('🚚 En Proceso')) return await mostrarEnProceso(ctx);
    if (txt.includes('✅ Finalizados')) return await mostrarFinalizados(ctx);
    if (txt.includes('📍 Compartir Ubicación') || txt.includes('📍 Ubicación activa')) {
      const d = drivers[uid];
      const hasLoc = d?.lat && d?.latTs && (Date.now() - d.latTs < 3600000);
      if (hasLoc) {
        return ctx.reply(
          `📍 <b>Ubicación activa</b>\n` +
          `Lat: <code>${d.lat.toFixed(5)}</code> — Lng: <code>${d.lng.toFixed(5)}</code>\n` +
          `<i>Comparte tu ubicación nuevamente para actualizarla.</i>\n\n` +
          `👇 Toca el clip 📎 → Ubicación → <b>Ubicación actual</b>`,
          { parse_mode: 'HTML' }
        );
      }
      return ctx.reply(
        `📍 <b>Compartir tu ubicación</b>\n\n` +
        `Así el link <b>"Ver Ruta"</b> partirá desde donde estás tú,\n` +
        `no desde la sede.\n\n` +
        `👇 Toca el clip 📎 → Ubicación → <b>Enviar ubicación actual</b>`,
        { parse_mode: 'HTML' }
      );
    }
    if (txt === '🚪 Cerrar Sesión') {
      if (drivers[uid]) {
        driversLastSeen[uid] = {
          nombre: drivers[uid].nombre,
          ts: Date.now(),
          lat: drivers[uid].lat || null,
          lng: drivers[uid].lng || null,
        };
      }
      delete drivers[uid]; delete espClave[uid];
      return ctx.reply(`👋 <b>Sesión cerrada.</b>`, { parse_mode: 'HTML', ...menuPublico() });
    }
  }

  if (txt === '🛵 Hacer Pedido') return mostrarOpcionesPedido(ctx);
  if (txt === '📦 Paquetería') return mostrarOpcionesPaqueteria(ctx);

  if (txt === '💲 Ver Tarifas') {
    delete S[uid];
    S[uid] = { tipo: 'consulta_tarifa', paso: 'barrio' };
    return ctx.reply(
      `💲 <b>CONSULTAR TARIFA</b>\n\n📍 Escribe el <b>barrio o dirección</b>:\n<i>Ej: Barrio Asunción, Castilla Medellín, Cra 50 #30-10 Bello...</i>`,
      { parse_mode: 'HTML' }
    );
  }

  if (txt === '🔐 Ingresar como Domiciliario') {
    espClave[uid] = true;
    return ctx.reply(
      `🔐 Escribe tu <b>clave de acceso</b>:\n<i>(El mensaje se borrará automáticamente)</i>`,
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
  }

  if (txt === '👑 Admin') {
    espClaveAdmin[uid] = true;
    return ctx.reply(`👑 Escribe tu <b>clave de administrador</b>:`, { parse_mode: 'HTML', ...Markup.removeKeyboard() });
  }

  if (txt === '🤝 Trabaja con Nosotros') {
    delete espPostulante[uid];
    espPostulante[uid] = { paso: 'nombre' };
    return ctx.reply(
      `🤝 <b>ÚNETE AL EQUIPO WIL</b>\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `¡Nos alegra tu interés en ser parte del equipo! 🛵\n\n` +
      `📝 <b>Nombre Completo:</b>\n<i>Escribe tu nombre completo como aparece en la cédula.</i>`,
      { parse_mode: 'HTML', ...Markup.removeKeyboard() }
    );
  }

  if (esAdmin(uid)) {
    if (txt === '📊 Resumen') return await cmdResumen(ctx);
    if (txt.startsWith('📋 Pendientes') || txt === '📋 Ver Pendientes') return await mostrarPendientes(ctx);
    if (txt.startsWith('🚚 En Proceso')) return await mostrarEnProceso(ctx);
    if (txt.startsWith('✅ Finalizados')) return await mostrarFinalizados(ctx);
    if (txt.startsWith('🛵 Domiciliarios')) return await cmdDomiciliarios(ctx);
    if (txt === '📣 Mensaje Masivo') {
      espMsg[uid] = true;
      return ctx.reply('📣 Escribe el mensaje para todos los domiciliarios:');
    }
    if (txt === '⏰ Recordatorio') { await enviarRecordatorio(); return ctx.reply('✅ Recordatorio enviado.'); }
    if (txt === '🔙 Salir Admin') {
      const kb = await menuDriver(uid);
      return ctx.reply('👋 Saliste del panel admin.', { ...kb });
    }
  }

  if (espClaveAdmin[uid]) { await manejarAutenticacionAdmin(ctx, uid, txt, mid); return; }
  if (espClave[uid]) { await manejarAutenticacion(ctx, uid, txt, mid); return; }
  if (espMsg[uid] && esAdmin(uid)) { await manejarMensajeMasivo(ctx, uid, txt); return; }
  if (espTotalManual[uid]) { await manejarTotalManual(ctx, uid, txt); return; }
  if (espPostulante[uid]) { await manejarPostulante(ctx, uid, txt); return; }
  if (S[uid]) { await manejarSesionCliente(ctx, uid, txt); return; }

  if (await detectarIntencion(txt)) return mostrarOpcionesPedido(ctx);
  return ctx.reply('❓ No entendí. Usa /start para comenzar.');
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN ADMIN
// ══════════════════════════════════════════════════════════════════════════════
async function manejarAutenticacionAdmin(ctx, uid, clave, msgId) {
  delete espClaveAdmin[uid];
  try { await ctx.deleteMessage(msgId); } catch (_) { }

  let adminValido = false;
  let adminNombre = '';
  try {
    const { google } = require('googleapis');
    const authG = new google.auth.GoogleAuth({ keyFile: './credentials.json', scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const client = await authG.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: 'Admins!A:D' });
    const rows = (res.data.values || []).slice(1);
    for (const [idx, r] of rows.entries()) {
      const claveSheet = (r[2] || '').toString().trim();
      const activoSheet = (r[3] || '').toString().trim().toUpperCase();
      if (claveSheet === clave.trim() && activoSheet === 'SI') {
        adminValido = true;
        adminNombre = (r[1] || 'Admin').toString().trim();
        if (!r[0] || r[0].toString().trim() !== uid.toString()) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: `Admins!A${idx + 2}`, valueInputOption: 'USER_ENTERED',
            resource: { values: [[uid.toString()]] }
          });
        }
        break;
      }
    }
  } catch (e) {
    console.error('manejarAutenticacionAdmin:', e.message);
    return ctx.reply('❌ Error verificando clave. Intenta de nuevo.', menuPublico());
  }

  if (!adminValido) return ctx.reply(`❌ <b>Clave incorrecta o admin inactivo.</b>`, { parse_mode: 'HTML', ...menuPublico() });

  const { pend, proc, fin } = await getContadores();
  return ctx.reply(
    `<b>¡Bienvenido, ${adminNombre}!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🟡 Pendientes:      <b>${pend}</b>\n` +
    `🔵 En proceso:      <b>${proc}</b>\n` +
    `🟢 Finalizados hoy: <b>${fin}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'HTML', ...await menuAdmin() }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN DOMICILIARIO
// PARCHE 1+2: Lee columna E (teléfono) y lo guarda en drivers[uid]
// ══════════════════════════════════════════════════════════════════════════════
async function manejarAutenticacion(ctx, uid, clave, msgId) {
  delete espClave[uid];
  try { await ctx.deleteMessage(msgId); } catch (_) { }
  const r = await verificarClave(clave);
  if (!r.valida) return ctx.reply(`❌ <b>Clave incorrecta.</b>\nPide una nueva al administrador.`, { parse_mode: 'HTML' });
  drivers[uid] = { nombre: r.nombre, pedidoActual: null, loginTs: Date.now() };

  // PARCHE 2: Buscar teléfono del domiciliario en el cache del sheet (columna E)
  await getSheetDrivers(); // asegurar que el cache esté fresco
  const sheetEntry = _sheetCache.find(x => x.nombre === r.nombre);
  if (sheetEntry?.telefono) {
    drivers[uid].telefono = sheetEntry.telefono;
    console.log(`📱 Teléfono domiciliario ${r.nombre}: ${sheetEntry.telefono}`);
  }

  await guardarTelegramDriver(r.fila, uid);
  const kb = await menuDriver(uid);
  await ctx.reply(`🎉 <b>¡Acceso concedido!</b>\nHola <b>${r.nombre}</b> 👋`, { parse_mode: 'HTML', ...kb });
  await ctx.reply(
    `📍 <b>Comparte tu ubicación en tiempo real</b>\n\n` +
    `Esto nos permite ver dónde estás y calcular rutas precisas.\n\n` +
    `👇 Toca el clip 📎 → <b>Ubicación</b> → <b>Compartir ubicación en tiempo real</b>\n` +
    `Elige <b>8 horas</b> para cubrir tu turno completo.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('📍 Ya la compartí ✅', 'loc_confirmado')
      ]])
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PANEL ADMIN — COMANDOS
// ══════════════════════════════════════════════════════════════════════════════
async function cmdResumen(ctx) {
  const r = await resumenDia();
  return ctx.reply(
    `📊 <b>RESUMEN — ${r.hoy}</b>\n━━━━━━━━━━━━━━\n` +
    `📦 Total hoy:    <b>${r.total}</b>\n🟡 Pendientes:   <b>${r.pendientes}</b>\n` +
    `🔵 En proceso:   <b>${r.enProceso}</b>\n🟢 Finalizados:  <b>${r.finalizados}</b>\n` +
    `❌ Cancelados:   <b>${r.cancelados}</b>\n\n💰 Ventas hoy:   <b>${COP(r.ventas)}</b>`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DOMICILIARIOS — cache, lista, card detalle
// PARCHE 1: getSheetDrivers lee columna E (teléfono)
// ══════════════════════════════════════════════════════════════════════════════
let _sheetCache = [];
let _sheetCacheTs = 0;

async function getSheetDrivers() {
  if (Date.now() - _sheetCacheTs < 60000 && _sheetCache.length) return _sheetCache;
  try {
    const { google } = require('googleapis');
    const authG = new google.auth.GoogleAuth({ keyFile: './credentials.json', scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const client = await authG.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Domiciliarios!A:E'   // PARCHE 1: ampliar rango hasta columna E
    });
    // PARCHE 1: leer índice 4 = columna E (teléfono)
    _sheetCache = (res.data.values || []).slice(1).filter(r => r[1]).map(r => ({
      telegramId: (r[0] || '').toString().trim(),
      nombre:     (r[1] || '').toString().trim(),
      telefono:   (r[4] || '').toString().trim(),  // columna E
    }));
    _sheetCacheTs = Date.now();
  } catch (e) { console.error('getSheetDrivers:', e.message); }
  return _sheetCache;
}

function statsDriverPool(nombre) {
  const ps = Object.values(pool).filter(p => p.estado === 'FINALIZADO' && p.domiciliario === nombre);
  return {
    entregas: ps.length,
    ganancia: ps.reduce((a, p) => a + (p.precioDomicilio || 0), 0)
  };
}

function tFmt(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '< 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm > 0 ? `${h}h ${String(mm).padStart(2, '0')}min` : `${h}h`;
}

function buildCard(nombre, telegramId) {
  const d = drivers[telegramId];
  const ahora = Date.now();
  const online = !!d;
  const { entregas, ganancia } = statsDriverPool(nombre);

  if (!online) {
    const seen = driversLastSeen[telegramId];
    const desdeTs = seen?.ts || null;
    const fechaStr = desdeTs ? moment(desdeTs).tz('America/Bogota').format('DD/MM/YYYY') : null;
    const horaStr = desdeTs ? moment(desdeTs).tz('America/Bogota').format('hh:mm A') : null;
    const haceStr = desdeTs ? tFmt(ahora - desdeTs) : null;
    const seen_loc = seen?.lat && seen?.lng;
    const gmOffline = seen_loc ? `https://www.google.com/maps?q=${seen.lat},${seen.lng}` : null;

    const cardText =
      `🔴 <b>${nombre}</b>  <i>· Sin conexión</i>\n\n` +
      `🕐 <b>Última conexión</b>\n` +
      (desdeTs
        ? `  📅 <b>${fechaStr}</b>  a las  <b>${horaStr}</b>\n` +
        `  ⏱ Hace  <b>${haceStr}</b>\n`
        : `  <i>Sin registro todavía</i>\n`) +
      `\n📍 <b>Última ubicación GPS</b>\n` +
      (seen_loc
        ? `  ✅ ${seen.lat.toFixed(6)}, ${seen.lng.toFixed(6)}\n`
        : `  ❌ <i>Nunca compartió ubicación</i>\n`) +
      `\n📊 <b>Estadísticas hoy</b>\n` +
      `  📦 Entregas   <b>${entregas}</b> pedido${entregas !== 1 ? 's' : ''}\n` +
      `  💵 Recaudado  <b>${ganancia > 0 ? COP(ganancia) : '$0'}</b>`;

    return { text: cardText, gmapsLink: gmOffline };
  }

  const enRuta = !!d.pedidoActual;
  const sesionMs = d.loginTs ? (ahora - d.loginTs) : 0;
  const actMs = d.lastActivity ? (ahora - d.lastActivity) : sesionMs;
  const horaLogin = d.loginTs ? moment(d.loginTs).tz('America/Bogota').format('hh:mm A') : '—';
  const hasLoc = !!(d.lat && d.latTs && (ahora - d.latTs < 3600000));
  const locHace = hasLoc ? tFmt(ahora - d.latTs) : null;
  const pedido = enRuta ? (pool[d.pedidoActual] || null) : null;
  const horaTomo = pedido?.horaTomo || '—';
  const destino = pedido?.barrio || pedido?.direccion || '—';
  const cliente = pedido?.cliente || '—';
  const telCliente = pedido?.telefono || '—';
  const valDom = pedido?.precioDomicilio ? COP(pedido.precioDomicilio) : '—';
  const negocio = pedido?.negocioNombre || '—';

  let gmapsLink = null;
  if (hasLoc && enRuta && pedido) {
    gmapsLink = buildGmapsUrl(pedido.barrio || pedido.direccion || '', pedido, d.lat, d.lng);
  } else if (hasLoc) {
    gmapsLink = `https://www.google.com/maps?q=${d.lat},${d.lng}`;
  } else if (enRuta && pedido) {
    gmapsLink = buildGmapsUrl(pedido.barrio || pedido.direccion || '', pedido, null, null);
  }

  const badge = enRuta ? '🔵' : '🟢';
  const estadoTx = enRuta ? 'En ruta' : 'Disponible';
  const actTxt = actMs > 300000
    ? `⚠️ Sin actividad hace <b>${tFmt(actMs)}</b>`
    : `✅ Activo en este momento`;

  const pct = Math.min(1, sesionMs / (8 * 3600000));
  const filled = Math.round(pct * 8);
  const bar = '▓'.repeat(filled) + '░'.repeat(8 - filled) + `  ${Math.round(pct * 100)}%`;

  let cardText =
    `${badge} <b>${nombre}</b>  ·  <i>${estadoTx}</i>\n` +
    `―――――――――――――――――――――\n\n` +
    `🔗 <b>Sesión activa</b>\n` +
    `    ⏰ Ingresó a las  <b>${horaLogin}</b>\n` +
    `    ⏱ Tiempo activo  <b>${tFmt(sesionMs)}</b>\n` +
    `    ${bar}\n` +
    `    ${actTxt}\n\n` +
    `📍 <b>Ubicación GPS</b>\n` +
    (hasLoc
      ? `    ✅ Activa  ·  hace <b>${locHace}</b>\n` +
      `    ${d.lat.toFixed(6)}, ${d.lng.toFixed(6)}\n`
      : `    ❌ No compartida\n` +
      `    <i>La ruta parte desde la sede</i>\n`) +
    `\n`;

  if (enRuta && pedido) {
    cardText +=
      `🛵 <b>Pedido en ruta</b>\n` +
      `    🆔 ID:         <b>${d.pedidoActual}</b>\n` +
      `    🏪 Negocio:    <b>${negocio}</b>\n` +
      `    👤 Cliente:    <b>${cliente}</b>\n` +
      `    📱 Teléfono:   <b>${telCliente}</b>\n` +
      `    📍 Destino:    <b>${destino}</b>\n` +
      `    💵 Domicilio:  <b>${valDom}</b>\n` +
      `    ⏰ Tomado a las <b>${horaTomo}</b>\n\n`;
  } else {
    const pendCount = Object.values(pool).filter(p => p.estado === 'PENDIENTE').length;
    cardText +=
      `📋 <b>Sin pedido activo</b>\n` +
      (pendCount > 0
        ? `    ⚡ Hay <b>${pendCount}</b> pedido${pendCount !== 1 ? 's' : ''} esperando\n`
        : `    ✅ Sin pedidos pendientes\n`) +
      `\n`;
  }

  cardText +=
    `📊 <b>Estadísticas hoy</b>\n` +
    `    📦 Entregas  →  <b>${entregas}</b> pedido${entregas !== 1 ? 's' : ''}\n` +
    `    💵 Recaudado →  <b>${ganancia > 0 ? COP(ganancia) : '$0'}</b>`;

  return { text: cardText, gmapsLink };
}

async function buildLista() {
  const todosSheet = await getSheetDrivers();
  const idsOnline = new Set(Object.keys(drivers).map(String));
  const ahora = moment().tz('America/Bogota').format('hh:mm A');
  const fecha = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const totalEntregas = Object.values(pool).filter(p => p.estado === 'FINALIZADO').length;
  const totalGanancia = Object.values(pool)
    .filter(p => p.estado === 'FINALIZADO')
    .reduce((a, p) => a + (p.precioDomicilio || 0), 0);

  const nOnline = idsOnline.size;
  const nOffline = todosSheet.filter(d => !idsOnline.has(d.telegramId)).length;

  const header =
    `👷 <b>Domiciliarios</b>  ·  ${fecha}  ⏰ ${ahora}\n\n` +
    `🟢 <b>${nOnline}</b> en línea   🔴 <b>${nOffline}</b> offline\n` +
    `📦 Entregas hoy: <b>${totalEntregas}</b>   💵 <b>${COP(totalGanancia)}</b>\n\n` +
    `<i>Toca un nombre para ver el detalle</i>`;

  const online = Object.entries(drivers).map(([id, d]) => {
    const badge = d.pedidoActual ? '🔵' : '🟢';
    return { telegramId: id, nombre: d.nombre, badge };
  });

  const offline = todosSheet
    .filter(d => !idsOnline.has(d.telegramId))
    .map(d => ({ telegramId: d.telegramId, nombre: d.nombre, badge: '🔴' }));

  const filas = [...online, ...offline].map(d => ([
    Markup.button.callback(`${d.badge} ${d.nombre}`, `drv_nop`),
    Markup.button.callback(`📋 Ver detalles`, `drv_det_${d.telegramId}`)
  ]));

  return { header, filas };
}

async function cmdDomiciliarios(ctx) {
  if (!esAdmin(ctx.from.id)) return ctx.reply('🚫 Sin acceso.');
  const { header, filas } = await buildLista();
  return ctx.reply(header, { parse_mode: 'HTML', ...Markup.inlineKeyboard(filas) });
}

bot.action('drv_nop', async ctx => { try { await ctx.answerCbQuery(); } catch (_) { } });

bot.action(/^drv_det_(.+)$/, async ctx => {
  try { await ctx.answerCbQuery(); } catch (_) { }
  if (!esAdmin(ctx.from.id)) return;

  const chatId = ctx.callbackQuery.message.chat.id;
  const msgId = ctx.callbackQuery.message.message_id;
  const telegramId = ctx.match[1];
  const d = drivers[telegramId];
  const sheet = _sheetCache.find(x => x.telegramId === telegramId);
  const nombre = d?.nombre || sheet?.nombre || 'Desconocido';

  const { text: cardText, gmapsLink } = buildCard(nombre, telegramId);

  const btns = [];

  if (d) {
    if (d.pedidoActual) {
      const p = pool[d.pedidoActual];
      const dLat = d.lat || null;
      const dLng = d.lng || null;
      const gmRuta = p ? buildGmapsUrl(p.barrio || p.direccion || '', p, dLat, dLng) : null;

      if (gmRuta) {
        const labelMaps = dLat ? '🗺️ Ver ruta en tiempo real' : '🗺️ Ver ruta al destino';
        btns.push([Markup.button.url(labelMaps, gmRuta)]);
      }
      btns.push([Markup.button.callback(`✅ Marcar entregado · ${d.pedidoActual}`, `entregar_${d.pedidoActual}`)]);
      btns.push([Markup.button.callback(`❌ Cancelar pedido · ${d.pedidoActual}`, `cancelar_order_${d.pedidoActual}`)]);
    } else {
      if (gmapsLink) {
        btns.push([Markup.button.url('📍 Ver ubicación actual en Maps', gmapsLink)]);
      }
      const pendientes = Object.values(pool).filter(p => p.estado === 'PENDIENTE');
      pendientes.slice(0, 2).forEach(p => {
        btns.push([Markup.button.callback(`📋 Asignar pedido ${p.id}`, `asignar_${p.id}_${telegramId}`)]);
      });
    }
  } else {
    const seen = driversLastSeen[telegramId];
    if (seen?.lat && seen?.lng) {
      btns.push([Markup.button.url('📍 Última ubicación conocida', `https://www.google.com/maps?q=${seen.lat},${seen.lng}`)]);
    }
  }

  btns.push([Markup.button.callback('🔙 Volver al panel', 'drv_back')]);

  try {
    await ctx.telegram.editMessageText(chatId, msgId, null, cardText, {
      parse_mode: 'HTML', ...Markup.inlineKeyboard(btns)
    });
  } catch (e) { console.error('drv_det:', e.message); }
});

bot.action('drv_back', async ctx => {
  try { await ctx.answerCbQuery(); } catch (_) { }
  if (!esAdmin(ctx.from.id)) return;

  const chatId = ctx.callbackQuery.message.chat.id;
  const msgId = ctx.callbackQuery.message.message_id;
  const { header, filas } = await buildLista();
  try {
    await ctx.telegram.editMessageText(chatId, msgId, null, header, {
      parse_mode: 'HTML', ...Markup.inlineKeyboard(filas)
    });
  } catch (e) { console.error('drv_back:', e.message); }
});

async function manejarMensajeMasivo(ctx, uid, txt) {
  delete espMsg[uid];
  const ids = Object.keys(drivers);
  if (!ids.length) return ctx.reply('😴 No hay domiciliarios conectados.', await menuAdmin());
  let enviados = 0;
  for (const did of ids) {
    try { await bot.telegram.sendMessage(did, `📣 <b>Mensaje Admin:</b>\n\n${txt}`, { parse_mode: 'HTML' }); enviados++; } catch (_) { }
  }
  return ctx.reply(`✅ Enviado a <b>${enviados}</b> domiciliario(s).`, { parse_mode: 'HTML', ...await menuAdmin() });
}

// ══════════════════════════════════════════════════════════════════════════════
// TRABAJA CON NOSOTROS
// ══════════════════════════════════════════════════════════════════════════════
async function manejarPostulante(ctx, uid, txt) {
  const s = espPostulante[uid];
  if (!s) return;
  switch (s.paso) {
    case 'nombre':
      if (txt.length < 3) return ctx.reply(`❌ Nombre muy corto.\nEscribe tu <b>nombre completo</b>:`, { parse_mode: 'HTML' });
      s.nombre = txt; s.paso = 'cedula';
      return ctx.reply(`✅ Nombre: <b>${txt}</b>\n\n1️⃣ <b>Cédula de ciudadanía:</b>\n<i>Solo el número, sin puntos ni espacios.</i>`, { parse_mode: 'HTML' });
    case 'cedula': {
      const ced = txt.replace(/\D/g, '');
      if (ced.length < 6) return ctx.reply(`❌ Cédula inválida. Escribe solo los números (mín. 6 dígitos):`);
      s.cedula = ced; s.paso = 'telefono';
      return ctx.reply(`✅ Cédula: <b>${ced}</b>\n\n2️⃣ <b>Número de teléfono:</b>\n<i>Ej: 3001234567</i>`, { parse_mode: 'HTML' });
    }
    case 'telefono': {
      const tel = txt.replace(/\D/g, '');
      if (tel.length < 7) return ctx.reply(`❌ Teléfono inválido. Escribe el número completo:`);
      s.telefono = tel; s.paso = 'licencia';
      return ctx.reply(`✅ Teléfono: <b>${tel}</b>\n\n3️⃣ <b>Foto de la LICENCIA de conducción</b> 📷\n<i>Envía una foto clara.</i>`, { parse_mode: 'HTML' });
    }
    default:
      if (['licencia', 'tecnomecanica', 'seguro'].includes(s.paso)) {
        const nombres = { licencia: '3️⃣ licencia', tecnomecanica: '4️⃣ tecnomecánica', seguro: '5️⃣ SOAT' };
        return ctx.reply(`📷 Envíame una <b>foto</b> de tu ${nombres[s.paso]}.\n<i>Adjunta la imagen directamente en el chat.</i>`, { parse_mode: 'HTML' });
      }
  }
}

async function manejarFotoPostulante(ctx, uid) {
  const s = espPostulante[uid];
  if (!s) return;
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  switch (s.paso) {
    case 'licencia':
      s.fotoLicencia = fileId; s.paso = 'tecnomecanica';
      return ctx.reply(`✅ Licencia recibida 📷\n\n4️⃣ <b>Foto de la TECNOMECÁNICA vigente</b> 📷`, { parse_mode: 'HTML' });
    case 'tecnomecanica':
      s.fotoTecnomecanica = fileId; s.paso = 'seguro';
      return ctx.reply(`✅ Tecnomecánica recibida 📷\n\n5️⃣ <b>Foto del SOAT vigente</b> 📷`, { parse_mode: 'HTML' });
    case 'seguro':
      s.fotoSeguro = fileId; s.paso = 'confirmando';
      return ctx.reply(
        `✅ SOAT recibido 📷\n\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 <b>RESUMEN DE TU POSTULACIÓN</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🪪 Nombre: <b>${s.nombre}</b>\n🪪 Cédula: <b>${s.cedula}</b>\n📱 Teléfono: <b>${s.telefono}</b>\n` +
        `📷 Licencia: ✅\n📷 Tecnomecánica: ✅\n📷 SOAT: ✅\n━━━━━━━━━━━━━━━━━━━━━━\n\n¿Todos los datos son correctos?`,
        {
          parse_mode: 'HTML', ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Enviar postulación', 'enviar_postulacion')],
            [Markup.button.callback('❌ Cancelar', 'cancelar_postulacion')]
          ])
        }
      );
  }
}

bot.action('enviar_postulacion', async ctx => {
  const uid = ctx.from.id; const s = espPostulante[uid];
  await ctx.answerCbQuery();
  if (!s || s.paso !== 'confirmando') return ctx.reply('❌ Algo salió mal. Inicia de nuevo con /start');
  try { await ctx.editMessageText(`⏳ <b>Enviando tu postulación...</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }); } catch (_) { }
  try {
    await registrarPostulante({
      nombre: s.nombre, cedula: s.cedula, telefono: s.telefono,
      fotoLicencia: s.fotoLicencia, fotoTecnomecanica: s.fotoTecnomecanica, fotoSeguro: s.fotoSeguro,
      telegramId: uid, botToken: process.env.BOT_TOKEN
    });
  } catch (e) {
    console.error('registrarPostulante error:', e.message);
    return ctx.reply(`❌ <b>Error al guardar.</b>\nContáctanos: 📱 <b>${process.env.WHATSAPP_NUMERO || '3XXXXXXXXX'}</b>`, { parse_mode: 'HTML', ...menuPublico() });
  }
  delete espPostulante[uid];
  const adminMsg = `🆕 <b>NUEVA POSTULACIÓN</b>\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 <b>${s.nombre}</b>\n🪪 ${s.cedula}\n📱 ${s.telefono}\n🆔 Telegram: <code>${uid}</code>\n` +
    `📅 ${moment().tz('America/Bogota').format('DD/MM/YYYY hh:mm A')}\n━━━━━━━━━━━━━━━━━━━━━━`;
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'HTML' });
      await bot.telegram.sendPhoto(adminId, s.fotoLicencia, { caption: '📷 Licencia' });
      await bot.telegram.sendPhoto(adminId, s.fotoTecnomecanica, { caption: '📷 Tecnomecánica' });
      await bot.telegram.sendPhoto(adminId, s.fotoSeguro, { caption: '📷 SOAT' });
    } catch (e) { console.error('Notif admin postulacion:', e.message); }
  }
  return ctx.reply(
    `🎉 <b>¡Postulación enviada con éxito!</b>\n\n` +
    `Uno de nuestros asesores se <b>contactará pronto</b> al <b>${s.telefono}</b>. 🛵\n\n` +
    `<i>¡Gracias por querer ser parte del equipo WIL!</i>`,
    { parse_mode: 'HTML', ...menuPublico() }
  );
});

bot.action('cancelar_postulacion', async ctx => {
  delete espPostulante[ctx.from.id];
  await ctx.answerCbQuery('❌ Cancelado');
  try { await ctx.editMessageText(`❌ <b>Postulación cancelada.</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }); } catch (_) { }
  return ctx.reply('Puedes comenzar de nuevo cuando quieras. /start', menuPublico());
});

// ══════════════════════════════════════════════════════════════════════════════
// CARDS DRIVER + BOTONES
// PARCHE 8: botonesCard agrega botón 📍 Ver en Maps con dirección del cliente
// ══════════════════════════════════════════════════════════════════════════════
function botonesCard(p, gmaps) {
  const id = p.id;
  // PARCHE 8: usar direccionCliente (lo que ingresó el cliente) para el link Maps
  const dirCliente = p.direccionCliente || p.direccion || '';
  const mapsDirBtn = dirCliente
    ? [Markup.button.url('📍 Ver en Maps', gmapsLinkDir(dirCliente))]
    : null;

  if (p.estado === 'EN_PROCESO') {
    const filas = [
      [Markup.button.callback('✅ Entregar', `entregar_${id}`), Markup.button.url('🗺️ Ver Ruta', gmaps)],
    ];
    if (mapsDirBtn) filas.push(mapsDirBtn);
    filas.push([Markup.button.callback('❌ Cancelar pedido', `cancelar_order_${id}`)]);
    return Markup.inlineKeyboard(filas);
  }
  const filas = [
    [Markup.button.callback('🎯 Tomar', `tomar_${id}`), Markup.button.callback('📸 Subir Factura', `factura_${id}`)],
    [Markup.button.url('🗺️ Ver Ruta', gmaps), Markup.button.callback('❌ Cancelar', `cancelar_order_${id}`)],
  ];
  if (mapsDirBtn) filas.splice(1, 0, mapsDirBtn);
  return Markup.inlineKeyboard(filas);
}

async function mostrarPendientes(ctx) {
  const uid = ctx.from.id;
  try {
    const enMem = Object.values(pool).filter(p => p.estado === 'PENDIENTE');
    const enSheets = await getPedidos('PENDIENTE').catch(() => []);
    const ids = new Set(enMem.map(p => p.id));
    const merged = [
      ...enMem,
      ...enSheets.filter(p => !ids.has(p.id)).map(p => ({
        id: p.id, negocioNombre: p.negocio || p.negocioNombre || '—', tienda: p.tienda || null,
        tipo: p.tipo || null, cliente: p.cliente || '—', telefono: p.telefono || '—',
        // PARCHE: preservar direccionCliente si viene del sheet, si no usar direccion
        direccionCliente: p.direccionCliente || p.direccion || '—',
        direccion: p.direccion || '—', barrio: p.barrio || p.direccion || '—',
        origen: p.origen || null, productos: p.productos || '—',
        total: p.total ? (Number(String(p.total).replace(/[^0-9.]/g, '')) || null) : null,
        precioDomicilio: Number(p.precioDomicilio) || 0, estado: 'PENDIENTE',
        clienteId: p.clienteId || null, presupuesto: p.presupuesto || null, carrito: p.carrito || []
      }))
    ];
    if (!merged.length) return ctx.reply('😴 No hay pedidos pendientes ahora.');
    for (const p of merged) {
      try {
        const dLat1 = drivers[uid]?.lat || null;
        const dLng1 = drivers[uid]?.lng || null;
        const gmaps = buildGmapsUrl(p.barrio || p.direccion || '', p, dLat1, dLng1);
        await ctx.reply(cardPedidoDriver(p, 'PENDIENTE'), { parse_mode: 'HTML', disable_web_page_preview: true, ...botonesCard(p, gmaps) });
      } catch (err) { console.error(`Error pedido ${p.id}:`, err.message); }
    }
  } catch (error) {
    console.error('mostrarPendientes:', error);
    return ctx.reply('❌ Error al cargar pedidos. Intenta de nuevo.');
  }
}

async function mostrarEnProceso(ctx) {
  const uid = ctx.from.id;
  const enMem = Object.values(pool).filter(p => p.estado === 'EN_PROCESO');
  const enSheets = await getPedidos('EN_PROCESO').catch(() => []);
  const ids = new Set(enMem.map(p => p.id));
  const merged = [
    ...enMem,
    ...enSheets.filter(p => !ids.has(p.id)).map(p => ({
      id: p.id, negocioNombre: p.negocio, tienda: p.tienda || null, tipo: p.tipo || null,
      cliente: p.cliente, telefono: p.telefono,
      direccionCliente: p.direccionCliente || p.direccion || '—',
      direccion: p.direccion,
      barrio: p.barrio || p.direccion, origen: p.origen || null, productos: p.productos,
      total: p.total ? (Number(String(p.total).replace(/[^0-9.]/g, '')) || null) : null,
      precioDomicilio: Number(p.precioDomicilio) || 0, domiciliario: p.domiciliario,
      horaTomo: p.horaTomo, estado: 'EN_PROCESO', clienteId: p.clienteId || null, carrito: p.carrito || []
    }))
  ];
  if (!merged.length) return ctx.reply('📭 Ningún pedido en proceso.');
  for (const p of merged) {
    const dEntry = Object.entries(drivers).find(([, d]) => d.nombre === p.domiciliario);
    const dLat = dEntry?.[1]?.lat || null;
    const dLng = dEntry?.[1]?.lng || null;
    const gmaps = buildGmapsUrl(p.barrio || p.direccion || '', p, dLat, dLng);
    await ctx.reply(
      cardPedidoDriver(p, 'EN_PROCESO') + `\n🛵 <b>${p.domiciliario || '?'}</b> — ⏰ ${p.horaTomo || '?'}`,
      { parse_mode: 'HTML', disable_web_page_preview: true, ...botonesCard(p, gmaps) }
    );
  }
}

async function mostrarFinalizados(ctx) {
  const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const ps = (await getPedidos('FINALIZADO').catch(() => [])).filter(p => p.fecha === hoy);
  if (!ps.length) return ctx.reply(`📭 Sin entregas finalizadas hoy (${hoy})`);
  let msg = `✅ <b>${ps.length}</b> entrega(s) hoy ${hoy}:\n\n`;
  ps.forEach((p, i) => {
    msg += `${i + 1}. 🆔 <b>${p.id}</b>  <i>${tipoBadge(p)}</i>\n`;
    msg += `   📍 ${p.barrio || p.direccion}\n`;
    msg += `   🛵 ${p.domiciliario || '?'} ⏰ ${p.horaEntrego || '?'}\n`;
    msg += `   💵 ${COP(p.total)}\n`;
    if (p.calificacion) msg += `   ⭐ ${p.calificacion}\n`;
    msg += '\n';
  });
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

// ══════════════════════════════════════════════════════════════════════════════
// TOMAR PEDIDO
// PARCHE 6+9: notifica cliente con nombre+teléfono del domi, 40 min estimado
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^tomar_(.+)$/, async ctx => {
  const id = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  const d = drivers[uid];
  if (!d && !esAdmin(uid)) return ctx.reply('❌ Autentícate primero. Usa /start');
  const domiciliario = d || { nombre: 'Admin', pedidoActual: null };
  if (domiciliario.pedidoActual) return ctx.answerCbQuery('⚠️ Ya tienes un pedido activo. Entrégalo primero.', true);
  if (pool[id] && pool[id].estado !== 'PENDIENTE') return ctx.answerCbQuery('⚠️ Ese pedido ya fue tomado.', true);
  if (!pool[id]) {
    const lista = await getPedidos('PENDIENTE').catch(() => []);
    const found = lista.find(x => x.id === id);
    if (!found) return ctx.answerCbQuery('⚠️ No encontré ese pedido.', true);
    pool[id] = {
      id: found.id, negocioNombre: found.negocio || found.negocioNombre || '—',
      tienda: found.tienda || null, tipo: found.tipo || null, cliente: found.cliente || '—',
      telefono: found.telefono || '—', clienteId: found.clienteId || null,
      direccionCliente: found.direccionCliente || found.direccion || '—',
      direccion: found.direccion || '—', barrio: found.barrio || found.direccion || '—',
      origen: found.origen || null, productos: found.productos || '—', total: found.total || null,
      precioDomicilio: found.precioDomicilio || 0, presupuesto: found.presupuesto || null,
      estado: 'PENDIENTE', carrito: found.carrito || [], hora: found.hora || null
    };
  }
  pool[id].estado = 'EN_PROCESO';
  pool[id].domiciliario = domiciliario.nombre;
  pool[id].horaTomo = moment().tz('America/Bogota').format('hh:mm A');
  if (drivers[uid]) { drivers[uid].pedidoActual = id; drivers[uid].lastActivity = Date.now(); }
  await asignarDomiciliario(id, domiciliario.nombre);
  const p = pool[id];
  const dLat3 = drivers[uid]?.lat || null;
  const dLng3 = drivers[uid]?.lng || null;
  const gmaps = buildGmapsUrl(p.barrio || p.direccion || '', p, dLat3, dLng3);

  // PARCHE 9: Notificar cliente con nombre + teléfono del domiciliario + 40 min
  if (p.clienteId) {
    const telDomi = drivers[uid]?.telefono || '';
    const dirDisplay = p.direccionCliente || p.direccion || p.barrio || '—';
    let productosDetalle = p.productos || '—';
    if (p.carrito?.length > 0) productosDetalle = p.carrito.map(i => `• ${i.cantidad}× ${i.descripcion}`).join('\n');

    const trackerMsg =
      `🛵 <b>¡Tu pedido está en camino!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ <b>Domiciliario asignado</b>\n\n` +
      `👤 <b>${domiciliario.nombre}</b>\n` +
      (telDomi ? `📱 <b>${telDomi}</b>\n` : '') +
      `\n🏪 ${p.negocioNombre || '—'}\n` +
      `📍 ${dirDisplay}\n\n` +
      `📦 <b>Productos:</b>\n${productosDetalle}\n\n` +
      `🛵 Domicilio: <b>${COP(p.precioDomicilio || 0)}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔴 <b>Tiempo estimado: 40 minutos</b>\n` +
      `🏍️🏍️🏍️🏍️🏍️............\n` +
      `<i>¡Tu pedido viene en camino! 🛵❤️</i>`;
    bot.telegram.sendMessage(p.clienteId, trackerMsg, { parse_mode: 'HTML' }).catch(() => { });
  }

  // PARCHE 4a: Canal de pedidos con dirección clickeable
  if (process.env.CANAL_PEDIDOS_ID) {
    const dirCliente = p.direccionCliente || p.direccion || p.barrio || '—';
    const dirLink = gmapsLinkDir(dirCliente);
    const cardTomar =
      `🔵 <b>TOMADO — ${id}</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `🛵 Domiciliario: <b>${domiciliario.nombre}</b>\n` +
      `👤 Cliente: ${p.cliente || '—'}  📱 ${p.telefono || '—'}\n` +
      `📍 <a href="${dirLink}">${dirCliente}</a>\n` +
      `🏪 ${p.negocioNombre || '—'}\n` +
      `💵 Domicilio: <b>${COP(p.precioDomicilio || 0)}</b>\n` +
      `⏰ ${pool[id].horaTomo}\n━━━━━━━━━━━━━━━━━━`;
    bot.telegram.sendMessage(process.env.CANAL_PEDIDOS_ID, cardTomar, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => { });
  }

  try {
    await ctx.editMessageText(
      cardPedidoDriver({ ...p, domiciliario: domiciliario.nombre }, 'EN_PROCESO') +
      `\n🛵 <b>${domiciliario.nombre}</b> — ⏰ ${pool[id].horaTomo}`,
      { parse_mode: 'HTML', disable_web_page_preview: true, ...botonesCard({ ...p, estado: 'EN_PROCESO' }, gmaps) }
    );
  } catch (e) { console.error('edit tomar:', e.message); }

  const kb = await menuDriver(uid);
  return ctx.reply(`🔵 <b>Pedido #${id}</b>\n✅ Tomado\n⏰ ${pool[id].horaTomo}`, { parse_mode: 'HTML', ...kb });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUBIR FACTURA
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^factura_(.+)$/, async ctx => {
  const id = ctx.match[1];
  const uid = ctx.from.id;
  const chatId = ctx.callbackQuery.message.chat.id;
  const msgId = ctx.callbackQuery.message.message_id;
  await ctx.answerCbQuery();
  if (!drivers[uid] && !esAdmin(uid)) return ctx.reply('❌ Autentícate primero.');
  let p = pool[id];
  if (p && p.estado === 'PENDIENTE') {
    const domiciliario = drivers[uid] || { nombre: 'Admin', pedidoActual: null };
    if (!domiciliario.pedidoActual) {
      p.estado = 'EN_PROCESO'; p.domiciliario = domiciliario.nombre;
      p.horaTomo = moment().tz('America/Bogota').format('hh:mm A');
      if (drivers[uid]) drivers[uid].pedidoActual = id;
      await asignarDomiciliario(id, domiciliario.nombre);
    }
  }
  espFacturaDrv[uid] = {
    pedidoId: id, chatId, msgId, precioDomicilio: p?.precioDomicilio || 0,
    clienteId: p?.clienteId || null, nombre: drivers[uid]?.nombre || 'Admin', pedido: p
  };
  try {
    await ctx.editMessageText(
      cardPedidoDriver(p || { id }, 'EN_PROCESO') + `\n\n📸 <b>Envía la foto de la factura...</b>`,
      { parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Volver', `verpedido_wil_${id}`)]]) }
    );
  } catch (e) { console.error('edit factura prompt:', e.message); }
});

// ══════════════════════════════════════════════════════════════════════════════
// FOTO
// ══════════════════════════════════════════════════════════════════════════════
bot.on('photo', async ctx => {
  const uid = ctx.from.id;
  if (espPostulante[uid] && ['licencia', 'tecnomecanica', 'seguro'].includes(espPostulante[uid].paso)) {
    await manejarFotoPostulante(ctx, uid); return;
  }
  if (espFacturaDrv[uid]) { await procesarFacturaDomiciliario(ctx, uid); return; }
  const s = S[uid];
  if (s && s.paso === 'comprobante') {
    s.imagenFileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    await procesarPedido(ctx, uid);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PROCESAR FACTURA DOMICILIARIO
// PARCHE 4b: NO enviar "en camino" al canal al subir factura
// ══════════════════════════════════════════════════════════════════════════════
async function procesarFacturaDomiciliario(ctx, uid) {
  const { pedidoId, chatId, msgId, precioDomicilio, clienteId, nombre, pedido } = espFacturaDrv[uid];
  delete espFacturaDrv[uid];
  try { await ctx.deleteMessage(); } catch (_) { }
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  try { await bot.telegram.editMessageText(chatId, msgId, null, `🔄 <b>Leyendo factura...</b>`, { parse_mode: 'HTML' }); } catch (_) { }
  const resultado = await leerTotalFactura(fileId, process.env.BOT_TOKEN);
  if (!resultado.ok || !resultado.total) {
    try {
      await bot.telegram.editMessageText(chatId, msgId, null,
        cardPedidoDriver(pedido || { id: pedidoId }, 'EN_PROCESO') +
        `\n\n❌ <b>No pude leer el total.</b>\n${resultado.error || 'Intenta con una foto más nítida.'}\n\n📸 Envía la foto de nuevo:`,
        {
          parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard([
            [Markup.button.callback('✏️ Ingresar total manual', `corregir_total_${pedidoId}`)],
            [Markup.button.callback('🔙 Volver', `verpedido_wil_${pedidoId}`)]
          ])
        });
    } catch (_) { }
    espFacturaDrv[uid] = { pedidoId, chatId, msgId, precioDomicilio, clienteId, nombre, pedido };
    return;
  }
  const totalProductos = resultado.total;

  const esCopa = esZonaCopacabana(pedido?.zona || pedido?.municipio || '', pedido?.barrio || '');
  const items = pedido?.carrito?.length || 1;
  const recargo = calcularRecargos(pedido?.hora || pool[pedidoId]?.hora, items, esCopa);
  const domFinal = (precioDomicilio || 0) + recargo;
  const totalFinal = totalProductos + domFinal;

  await actualizarTotalPedido(pedidoId, totalFinal);
  if (pool[pedidoId]) {
    pool[pedidoId].total = totalFinal;
    pool[pedidoId].totalProductos = totalProductos;
    pool[pedidoId].facturaFileId = fileId;
  }

  let productosDetalle = pedido?.productos || '—';
  if (pedido?.carrito?.length > 0) productosDetalle = pedido.carrito.map(i => `• ${i.cantidad}× ${i.descripcion}`).join('\n');

  // Notificar al cliente con la factura (incluye desglose)
  if (clienteId) {
    const dirCliente = pedido?.direccionCliente || pedido?.direccion || '—';
    try {
      await bot.telegram.sendPhoto(clienteId, fileId, {
        caption:
          `🧾 <b>FACTURA DE TU PEDIDO</b>\n━━━━━━━━━━━━━━━━━━\n🆔 <b>${pedidoId}</b>\n` +
          `👤 ${pedido?.cliente || '—'}\n📍 <b>${dirCliente}</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n📦 <b>PRODUCTOS:</b>\n${productosDetalle}\n━━━━━━━━━━━━━━━━━━\n` +
          `🧾 Productos: <b>${COP(totalProductos)}</b>\n🛵 Domicilio: <b>${COP(domFinal)}</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n💵 <b>TOTAL: ${COP(totalFinal)}</b>\n🛵 ${nombre}`,
        parse_mode: 'HTML'
      });
    } catch (e) { console.error('Factura al cliente:', e.message); }
  }

  // PARCHE 4b: NO enviar "en camino" al canal al subir factura — solo actualizar card del driver
  const driverId = uid;
  const dLat4 = drivers[driverId]?.lat || null;
  const dLng4 = drivers[driverId]?.lng || null;
  const gmaps = buildGmapsUrl(pedido?.barrio || pedido?.direccion || '', pedido, dLat4, dLng4);
  const pActual = pool[pedidoId] || pedido || { id: pedidoId };
  try {
    await bot.telegram.editMessageText(chatId, msgId, null,
      cardPedidoDriver({ ...pActual, total: totalFinal }, 'EN_PROCESO') +
      `\n🛵 <b>${nombre}</b>\n🧾 ${COP(totalProductos)} + 🛵 ${COP(domFinal)} = 💵 <b>${COP(totalFinal)}</b>\n📲 <i>Cliente notificado ✅</i>`,
      {
        parse_mode: 'HTML', disable_web_page_preview: true, ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Entregar', `entregar_${pedidoId}`), Markup.button.url('🗺️ Ver Ruta', gmaps)],
          [Markup.button.callback('❌ Cancelar pedido', `cancelar_order_${pedidoId}`)]
        ])
      }
    );
  } catch (e) { console.error('edit factura result:', e.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// VOLVER AL PEDIDO
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^verpedido_wil_(.+)$/, async ctx => {
  const id = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  if (espFacturaDrv[uid]?.pedidoId === id) delete espFacturaDrv[uid];
  let p = pool[id];
  if (!p) {
    const lista = await getPedidos('ALL').catch(() => []);
    const f = lista.find(x => x.id === id);
    if (f) p = { ...f, barrio: f.barrio || f.direccion, direccionCliente: f.direccionCliente || f.direccion };
  }
  if (!p) return;
  const dLat5 = drivers[uid]?.lat || null;
  const dLng5 = drivers[uid]?.lng || null;
  const gmaps = buildGmapsUrl(p.barrio || p.direccion || '', p, dLat5, dLng5);
  try { await ctx.editMessageText(cardPedidoDriver(p, p.estado || 'EN_PROCESO'), { parse_mode: 'HTML', disable_web_page_preview: true, ...botonesCard(p, gmaps) }); } catch (_) { }
});

bot.action('volver_pendientes', async ctx => { await ctx.answerCbQuery(); await mostrarPendientes(ctx); });

// ══════════════════════════════════════════════════════════════════════════════
// TOTAL MANUAL
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^corregir_total_(.+)$/, async ctx => {
  const id = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  const datos = espConfirmar[uid];
  if (datos) delete espConfirmar[uid];
  espTotalManual[uid] = {
    pedidoId: id,
    precioDomicilio: pool[id]?.precioDomicilio || 0,
    clienteId: pool[id]?.clienteId || null,
    fileId: datos?.fileId || null,
    pedido: datos?.pedido || pool[id] || null
  };
  return ctx.reply(
    `✏️ <b>Ingresa el total correcto de la factura</b>\n\n🛵 Domicilio: <b>${COP(pool[id]?.precioDomicilio || 0)}</b>\n\nEscribe solo el <b>valor de los productos</b>:\n<i>Ej: 87500</i>`,
    { parse_mode: 'HTML' }
  );
});

async function manejarTotalManual(ctx, uid, txt) {
  const { pedidoId, precioDomicilio, clienteId, fileId, pedido } = espTotalManual[uid];
  const raw = txt.replace(/[^0-9.,]/g, '').trim();
  const valor = parseFloat(raw.replace(/\./g, '').replace(/,/g, '.'));
  if (!raw || isNaN(valor) || valor <= 0) return ctx.reply(`❌ Valor inválido. Escribe solo el número:\n<b>87500</b>`, { parse_mode: 'HTML' });
  delete espTotalManual[uid];

  const esCopa = esZonaCopacabana(pedido?.zona || pedido?.municipio || '', pedido?.barrio || '');
  const items = pedido?.carrito?.length || 1;
  const recargo = calcularRecargos(pedido?.hora || pool[pedidoId]?.hora, items, esCopa);
  const domFinal = (precioDomicilio || 0) + recargo;
  const totalFinal = valor + domFinal;

  await actualizarTotalPedido(pedidoId, totalFinal);
  if (pool[pedidoId]) { pool[pedidoId].total = totalFinal; pool[pedidoId].totalProductos = valor; }

  let productosDetalle = pedido?.productos || '—';
  if (pedido?.carrito?.length > 0) productosDetalle = pedido.carrito.map(i => `• ${i.cantidad}× ${i.descripcion}`).join('\n');

  if (clienteId) {
    try {
      const clienteMsg =
        `🧾 <b>FACTURA DE TU PEDIDO</b>\n━━━━━━━━━━━━━━━━━━\n🆔 <b>${pedidoId}</b>\n` +
        `📦 <b>PRODUCTOS:</b>\n${productosDetalle}\n━━━━━━━━━━━━━━━━━━\n` +
        `🧾 Productos: <b>${COP(valor)}</b>\n🛵 Domicilio: <b>${COP(domFinal)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n💵 <b>TOTAL: ${COP(totalFinal)}</b>`;
      if (fileId) await bot.telegram.sendPhoto(clienteId, fileId, { caption: clienteMsg, parse_mode: 'HTML' });
      else await bot.telegram.sendMessage(clienteId, clienteMsg, { parse_mode: 'HTML' });
    } catch (e) { console.error('factura manual al cliente:', e.message); }
  }
  const kb = await menuDriver(uid);
  return ctx.reply(`✅ <b>¡FACTURA PROCESADA!</b>\n💵 Total: ${COP(totalFinal)}`, { parse_mode: 'HTML', ...kb });
}

// ══════════════════════════════════════════════════════════════════════════════
// ENTREGAR + CALIFICACIÓN
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^entregar_(.+)$/, async ctx => {
  const id = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  if (!drivers[uid] && !esAdmin(uid)) return ctx.reply('❌ Autentícate primero.');
  if (drivers[uid] && drivers[uid].pedidoActual !== id && !esAdmin(uid)) return ctx.answerCbQuery('⚠️ No puedes finalizar ese pedido.', true);
  const hora = await marcarEntregado(id);
  if (pool[id]) pool[id].estado = 'FINALIZADO';
  if (drivers[uid]) drivers[uid].pedidoActual = null;
  const p = pool[id];

  let productosDetalle = p?.productos || '—';
  if (p?.carrito?.length > 0) productosDetalle = p.carrito.map(i => `• ${i.cantidad}× ${i.descripcion}`).join('\n');

  const nomDomi = drivers[uid]?.nombre || p?.domiciliario || 'Admin';

  const resumenDriver =
    `🟢 <b>ENTREGADO · ${hora || '—'}</b>\n━━━━━━━━━━━━━━━━━━\n` +
    (p ? cardPedidoDriver({ ...p, estado: 'FINALIZADO' }, 'FINALIZADO') + '\n' : `🆔 ${id}\n`) +
    `📦 <b>PRODUCTOS:</b>\n${productosDetalle}\n━━━━━━━━━━━━━━━━━━\n` +
    (p?.totalProductos ? `🧾 Productos: <b>${COP(p.totalProductos)}</b>\n` : '') +
    (p?.precioDomicilio ? `🛵 Domicilio: <b>${COP(p.precioDomicilio)}</b>\n` : '') +
    (p?.total ? `💵 <b>TOTAL COBRADO: ${COP(p.total)}</b>\n` : '') +
    `🛵 ${nomDomi} ⏰ ${hora || '—'}`;

  if (p?.facturaFileId) {
    try { await bot.telegram.sendPhoto(ctx.chat.id, p.facturaFileId, { caption: resumenDriver, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }); } catch (_) { }
    try { await ctx.editMessageText(`🟢 Pedido <b>${id}</b> finalizado · ⏰ ${hora || '—'}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }); } catch (_) { }
  } else {
    try { await ctx.editMessageText(resumenDriver, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } }); } catch (_) { }
  }

  if (p?.clienteId) {
    const trackerMsg = trackerCliente('ENTREGADO', nomDomi, null) +
      `\n\n🆔 <b>${id}</b>\n📦 ${productosDetalle}\n` +
      (p?.total ? `💵 <b>Total: ${COP(p.total)}</b>\n` : '') +
      `\n<i>¡Gracias por pedir con Domicilios WIL! 🛵❤️</i>`;
    try { await bot.telegram.sendMessage(p.clienteId, trackerMsg, { parse_mode: 'HTML' }); } catch (_) { }
    await enviarMensajeCalificacion(p.clienteId, id);
  }

  if (process.env.CANAL_PEDIDOS_ID) {
    const dirCliente = p?.direccionCliente || p?.direccion || p?.barrio || '—';
    const dirLink = gmapsLinkDir(dirCliente);
    const cardCanal =
      `🟢 <b>ENTREGADO — ${id}</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `🛵 Domiciliario: <b>${nomDomi}</b>\n` +
      `👤 ${p?.cliente || '—'}  📱 ${p?.telefono || '—'}\n` +
      `📍 <a href="${dirLink}">${dirCliente}</a>\n` +
      `🏪 ${p?.negocioNombre || '—'}\n` +
      `📦 ${productosDetalle}\n━━━━━━━━━━━━━━━━━━\n` +
      (p?.totalProductos ? `🧾 Productos: <b>${COP(p.totalProductos)}</b>\n` : '') +
      (p?.precioDomicilio ? `🛵 Domicilio: <b>${COP(p.precioDomicilio)}</b>\n` : '') +
      (p?.total ? `💵 <b>TOTAL: ${COP(p.total)}</b>\n` : '') +
      `⏰ Entregado: ${hora || '—'}`;
    bot.telegram.sendMessage(process.env.CANAL_PEDIDOS_ID, cardCanal, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => { });
  }

  const kb = await menuDriver(uid);
  const { pend } = await getContadores();
  return ctx.reply(
    `¡Buen trabajo ${nomDomi}! 💪` + (pend > 0 ? `   🔴 <b>${pend}</b> pendiente(s)` : `   ✅ Sin más pendientes`),
    { parse_mode: 'HTML', ...kb }
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// CANCELAR PEDIDO
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^cancelar_order_(.+)$/, async ctx => {
  const id = ctx.match[1];
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  if (!esAdmin(uid) && !esDriver(uid)) return;
  if (pool[id]) pool[id].estado = 'CANCELADO';
  if (drivers[uid]?.pedidoActual === id) drivers[uid].pedidoActual = null;
  try { if (typeof cancelarPedido === 'function') await cancelarPedido(id); } catch (_) { }
  const clienteId = pool[id]?.clienteId;
  if (clienteId) {
    bot.telegram.sendMessage(clienteId,
      `❌ <b>Tu pedido fue cancelado</b>\n🆔 ${id}\n\n<i>Haz un nuevo pedido con /start</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => { });
  }
  try { await ctx.editMessageText(`❌ <b>Pedido ${id} cancelado</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }); } catch (_) { }
  const kb = await menuDriver(uid);
  return ctx.reply(`❌ Pedido <b>${id}</b> cancelado.`, { parse_mode: 'HTML', ...kb });
});

// ══════════════════════════════════════════════════════════════════════════════
// PAQUETERÍA
// ══════════════════════════════════════════════════════════════════════════════
bot.action('ver_tarifas', async ctx => {
  await ctx.answerCbQuery();
  delete S[ctx.from.id];
  S[ctx.from.id] = { tipo: 'consulta_tarifa', paso: 'barrio' };
  return ctx.reply(`💲 <b>CONSULTAR TARIFA</b>\n\n📍 Escribe el <b>barrio o dirección</b>:`, { parse_mode: 'HTML' });
});

bot.action('menu_pedido', async ctx => { await ctx.answerCbQuery(); return mostrarOpcionesPedido(ctx); });

async function mostrarOpcionesPedido(ctx) {
  delete S[ctx.from.id];
  return ctx.reply('¿De dónde quieres pedir?', Markup.inlineKeyboard([
    [Markup.button.callback('🏪 Domicilios WIL (general)', 'neg_wil')],
    [Markup.button.callback('💊 FarmaExpertos Copacabana', 'neg_expertos')],
    [Markup.button.callback('🏥 Farmacia Central Copacabana', 'neg_central')],
    [Markup.button.callback('📦 Paquetería', 'paqueteria')]
  ]));
}

async function mostrarOpcionesPaqueteria(ctx) {
  delete S[ctx.from.id];
  return ctx.reply(
    `📦 <b>PAQUETERÍA WIL</b>\n\n¿Qué necesitas?`,
    {
      parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Recoger en un lugar y llevar a otro', 'paq_recogida')]
      ])
    }
  );
}

bot.action('paqueteria', async ctx => {
  await ctx.answerCbQuery();
  delete S[ctx.from.id];
  return ctx.reply(
    `📦 <b>PAQUETERÍA WIL</b>\n\n¿Qué necesitas?`,
    {
      parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Recoger en un lugar y llevar a otro', 'paq_recogida')]
      ])
    }
  );
});

bot.action('paq_recogida', async ctx => {
  await ctx.answerCbQuery();
  S[ctx.from.id] = { tipo: 'paqueteria', subtipo: 'recogida', paso: 'nombre' };
  return ctx.reply(
    `📦 <b>PAQUETERÍA — RECOGIDA Y ENTREGA</b>\n\nVoy a recoger el paquete donde me digas y lo llevo a otra dirección.\n\n✏️ ¿Cuál es tu <b>nombre completo</b>?`,
    { parse_mode: 'HTML' }
  );
});

bot.action('ingresar', async ctx => {
  const uid = ctx.from.id;
  await ctx.answerCbQuery();
  if (drivers[uid]) {
    const kb = await menuDriver(uid);
    return ctx.reply(`🛵 Ya estás autenticado, <b>${drivers[uid].nombre}</b>`, { parse_mode: 'HTML', ...kb });
  }
  espClave[uid] = true;
  return ctx.reply(`🔐 Escribe tu <b>clave de acceso</b>:`, { parse_mode: 'HTML', ...Markup.removeKeyboard() });
});

bot.action('confirmar_paquete', async ctx => {
  const s = S[ctx.from.id]; await ctx.answerCbQuery();
  if (!s) return;
  s.metodoPago = 'EFECTIVO';
  await procesarPaquete(ctx, ctx.from.id);
});

bot.action('modificar_paquete', async ctx => {
  const s = S[ctx.from.id]; await ctx.answerCbQuery();
  if (!s) return;
  s.paso = 'tipo_paquete';
  return ctx.reply(
    `📦 ¿Qué tipo de paquete es?\n\n1️⃣ Documento\n2️⃣ Pequeño (hasta 2 kg)\n3️⃣ Mediano (2 a 5 kg)\n4️⃣ Grande (más de 5 kg)\n\nResponde con el número:`
  );
});

async function procesarPaquete(ctx, uid) {
  const s = S[uid];
  const dom = s.precioDomicilio || 0;
  const productosStr = `${s.tipoPaquete}${s.pesoAprox ? ' (~' + s.pesoAprox + ')' : ''}: ${s.descripcion || 'Sin descripción'} (Recoge: ${s.origenBarrio} → Entrega: ${s.barrioDestino || s.direccionDestino})`;

  const id = await registrarPedido({
    nombre: s.nombre, telefono: s.telefono, metodoPago: 'EFECTIVO',
    imagenFileId: '', carrito: [{ descripcion: productosStr, cantidad: 1, precioUnitario: 0, subtotal: 0 }],
    negocioNombre: '📦 Paquetería WIL — Recogida', tienda: null, tipo: 'paqueteria',
    direccion: s.barrioDestino || s.direccionDestino, precioDomicilio: dom, totalFinal: dom
  });

  await ctx.reply(
    `✅ <b>¡PAQUETE REGISTRADO!</b>\n\n🆔 <b>${id}</b>\n👤 ${s.nombre}  📱 ${s.telefono}\n` +
    `🔄 Recoge en: <b>${s.origenBarrio}</b>\n📍 Entrega en: <b>${s.barrioDestino || s.direccionDestino}</b>\n` +
    (s.puntoReferenciaOrigen ? `📌 Ref. recogida: <i>${s.puntoReferenciaOrigen}</i>\n` : '') +
    (s.puntoReferenciaDestino ? `📌 Ref. entrega: <i>${s.puntoReferenciaDestino}</i>\n` : '') +
    `📦 ${s.tipoPaquete}${s.pesoAprox ? ' (~' + s.pesoAprox + ')' : ''}: <i>${s.descripcion || '—'}</i>\n` +
    `🛵 Valor del envío: <b>${COP(dom)}</b>\n\n` +
    `<i>Guarda este ID para consultar tu pedido.</i>`,
    { parse_mode: 'HTML' }
  );

  pool[id] = {
    id, negocioNombre: '📦 Paquetería WIL — Recogida', tienda: null, tipo: 'paqueteria',
    cliente: s.nombre, telefono: s.telefono, clienteId: uid,
    direccionCliente: s.barrioDestino || s.direccionDestino,
    direccion: s.barrioDestino || s.direccionDestino, barrio: s.barrioDestino || s.direccionDestino,
    origen: s.origenBarrio || null, productos: productosStr, total: null,
    precioDomicilio: dom, estado: 'PENDIENTE',
    hora: moment().tz('America/Bogota').format('hh:mm A'),
    createdAt: Date.now()
  };

  const { pend } = await getContadores();
  for (const [did, d] of Object.entries(drivers)) {
    if (!d.pedidoActual) {
      bot.telegram.sendMessage(did,
        `📦 <b>Nuevo paquete</b>\n🆕 <b>${id}</b>\n👤 ${s.nombre}  📱 ${s.telefono}\n` +
        `🔄 Recoge en: ${s.origenBarrio}\n📍 Entrega en: ${s.barrioDestino || s.direccionDestino}\n` +
        (s.puntoReferenciaOrigen ? `📌 Ref: ${s.puntoReferenciaOrigen}\n` : '') +
        `🛵 <b>${COP(dom)}</b>\n\nPresiona 📋 Pendientes (${pend})`,
        { parse_mode: 'HTML' }
      ).catch(() => { });
    }
  }
  delete S[uid];
}

// ══════════════════════════════════════════════════════════════════════════════
// FLUJO CLIENTE
// ══════════════════════════════════════════════════════════════════════════════
const NEGOCIOS = {
  wil: { nombre: '🏪 Domicilios WIL', tienda: null },
  expertos: { nombre: '💊 Farmacia Expertos', tienda: 'EXPERTOS' },
  central: { nombre: '🏥 Farmacia La Central', tienda: 'CENTRAL' }
};

bot.action(/^neg_(.+)$/, async ctx => {
  const key = ctx.match[1];
  await ctx.answerCbQuery();
  S[ctx.from.id] = { tipo: 'pedido', negocio: key, negocioNombre: NEGOCIOS[key].nombre, tienda: NEGOCIOS[key].tienda, carrito: [], paso: 'nombre' };
  return ctx.reply(`🛵 <b>${NEGOCIOS[key].nombre}</b>\n\n✏️ ¿Cuál es tu <b>nombre completo</b>?`, { parse_mode: 'HTML' });
});

async function manejarSesionCliente(ctx, uid, txt) {
  const s = S[uid];

  if (s.tipo === 'consulta_tarifa') {
    await ctx.reply('🔍 Buscando...', { parse_mode: 'HTML' });
    const r = await obtenerTarifaRapida(txt);
    let msg;
    if (r.tarifa || r.paqPeq) {
      msg = r.mensaje + `\n\n━━━━━━━━━━━━━━━━━━\n` +
        `🛵 Domicilio:      <b>${COP(r.tarifa)}</b>\n` +
        `📦 Envío paquete:  <b>${COP(r.paqPeq)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━`;
    } else {
      msg = `⚠️ <b>${txt}</b>\n<i>No se encontró tarifa — se confirma al hacer el pedido.</i>`;
    }
    delete S[uid];
    return ctx.reply(msg, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📦 Enviar paquete', 'paqueteria')],
        [Markup.button.callback('🛵 Hacer pedido', 'menu_pedido')],
        [Markup.button.callback('🔍 Consultar otro barrio', 'ver_tarifas')]
      ])
    });
  }

  if (s.tipo === 'paqueteria') {
    switch (s.paso) {
      case 'nombre':
        s.nombre = txt; s.paso = 'telefono';
        return ctx.reply(`📦 <b>PAQUETERÍA</b>\n👤 ${s.nombre}\n\n📱 ¿Cuál es tu <b>teléfono</b>?`, { parse_mode: 'HTML' });

      case 'telefono':
        s.telefono = txt; s.paso = 'origen';
        return ctx.reply(
          `📦 <b>PAQUETERÍA — RECOGIDA</b>\n👤 ${s.nombre}  📱 ${s.telefono}\n\n` +
          `📍 ¿En qué <b>dirección o barrio</b> debo <b>RECOGER</b> el paquete?\n<i>Ej: Cra 50 #30-10 Barrio El Centro, Copacabana</i>`,
          { parse_mode: 'HTML' }
        );

      case 'origen': {
        s.origen = txt; s.paso = 'punto_referencia_origen';
        return ctx.reply(
          `📌 <b>Punto de referencia para la recogida</b>\n` +
          `<i>Edificio, local, color fachada, apto... — escribe "no" si no hay</i>`,
          { parse_mode: 'HTML' }
        );
      }

      case 'punto_referencia_origen': {
        s.puntoReferenciaOrigen = txt.toLowerCase() === 'no' ? '' : txt;
        let dirRefOrigen = null;
        try {
          const matchSheet = await buscarBarrioEnSheet(s.origen);
          dirRefOrigen = matchSheet?.direccion || matchSheet?.nota || null;
        } catch (_) { }
        await ctx.reply('📍 Verificando dirección de recogida...', { parse_mode: 'HTML' });
        const rOrigen = await obtenerTarifaRapida(s.origen, dirRefOrigen);
        s.origenBarrio = rOrigen.barrio || s.origen;
        s.rOrigen = rOrigen;
        s.paso = 'contacto_origen';
        return ctx.reply(
          rOrigen.mensaje + `\n\n👤 ¿Quién entrega el paquete?\n<i>Nombre y teléfono — escribe "yo mismo" si eres tú</i>`,
          { parse_mode: 'HTML' }
        );
      }

      case 'contacto_origen': {
        s.contactoOrigen = txt.toLowerCase().includes('yo') ? `${s.nombre} ${s.telefono}` : txt;
        s.paso = 'direccion_destino';
        return ctx.reply(
          `✅ Recogida configurada\n\n📍 <b>Dirección de entrega</b>\n` +
          `Escribe la <b>dirección y barrio</b>:\n` +
          `<i>Ej: Calle 10 #45-20 Barrio Castilla, Medellín</i>`,
          { parse_mode: 'HTML' }
        );
      }

      case 'direccion_destino': {
        s.direccionDestino = txt; s.paso = 'punto_referencia_destino';
        return ctx.reply(
          `📌 <b>Punto de referencia para la entrega</b>\n` +
          `<i>Apto, piso, empresa, color fachada... — escribe "no" si no hay</i>`,
          { parse_mode: 'HTML' }
        );
      }

      case 'punto_referencia_destino': {
        s.puntoReferenciaDestino = txt.toLowerCase() === 'no' ? '' : txt;
        await ctx.reply('📍 Verificando dirección de entrega...', { parse_mode: 'HTML' });
        let dirRefDest = null;
        try {
          const matchSheet = await buscarBarrioEnSheet(s.direccionDestino);
          dirRefDest = matchSheet?.direccion || matchSheet?.nota || null;
        } catch (_) { }
        const rDest = await obtenerTarifaRapida(s.direccionDestino, dirRefDest);
        s.barrioDestino = rDest.barrio || s.direccionDestino;
        s.zonaDestino = rDest.zona || '';
        s.municipioDestino = rDest.municipio || '';

        const latOrigen = s.rOrigen?.lat;
        const lngOrigen = s.rOrigen?.lng;
        const latDest = rDest.lat;
        const lngDest = rDest.lng;

        if (latOrigen && lngOrigen && latDest && lngDest) {
          const dist = calcularPrecioPorKm(latOrigen, lngOrigen, latDest, lngDest);
          s.precioDomicilio = dist.precioCOP;
        } else if (latDest && lngDest) {
          s.precioDomicilio = rDest.tarifa || rDest.paqPeq || 0;
        } else {
          s.precioDomicilio = Math.max(s.rOrigen?.paqPeq || 0, rDest.paqPeq || 0);
        }

        s.paso = 'contacto_destino';
        return ctx.reply(
          rDest.mensaje + `\n\n👤 ¿Quién recibe el paquete?\n<i>Nombre y teléfono — Ej: María López 3109876543</i>`,
          { parse_mode: 'HTML' }
        );
      }

      case 'contacto_destino': {
        s.contactoDestino = txt;
        s.paso = 'tipo_paquete';
        return ctx.reply(
          `✅ Destino configurado\n\n📦 ¿Qué tipo de paquete es?\n\n` +
          `1️⃣ Documento\n2️⃣ Pequeño (hasta 2 kg)\n3️⃣ Mediano (2 a 5 kg)\n4️⃣ Grande (más de 5 kg)\n\nResponde con el número:`,
          { parse_mode: 'HTML' }
        );
      }

      case 'tipo_paquete': {
        const opcion = parseInt(txt);
        const tipos = ['Documento', 'Pequeño', 'Mediano', 'Grande'];
        if (isNaN(opcion) || opcion < 1 || opcion > 4) return ctx.reply('❌ Elige 1, 2, 3 o 4:');
        s.tipoPaquete = tipos[opcion - 1];
        s.paso = 'peso';
        return ctx.reply(
          `📦 Tipo: <b>${s.tipoPaquete}</b>\n\n⚖️ ¿Cuánto pesa aproximadamente?\n<i>Ej: 500g, 2kg, 10kg — escribe "no sé" si no sabes</i>`,
          { parse_mode: 'HTML' }
        );
      }

      case 'peso': {
        s.pesoAprox = txt.toLowerCase() === 'no sé' ? '' : txt;
        s.paso = 'descripcion';
        return ctx.reply(
          `⚖️ Peso: <b>${s.pesoAprox || 'No especificado'}</b>\n\n✏️ Describe brevemente el contenido del paquete:`,
          { parse_mode: 'HTML' }
        );
      }

      case 'descripcion':
        s.descripcion = txt;
        s.paso = 'confirmar';
        return ctx.reply(
          `📦 <b>RESUMEN PAQUETERÍA</b>\n━━━━━━━━━━━━━━━━━━\n` +
          `👤 ${s.nombre}  📱 ${s.telefono}\n` +
          `🔄 <b>Recoge en:</b> ${s.origenBarrio}\n` +
          (s.puntoReferenciaOrigen ? `   📌 ${s.puntoReferenciaOrigen}\n` : '') +
          `   👤 ${s.contactoOrigen || '—'}\n` +
          `📍 <b>Entrega en:</b> ${s.barrioDestino || s.direccionDestino}\n` +
          (s.puntoReferenciaDestino ? `   📌 ${s.puntoReferenciaDestino}\n` : '') +
          `   👤 ${s.contactoDestino || '—'}\n` +
          `📦 ${s.tipoPaquete}${s.pesoAprox ? ' (~' + s.pesoAprox + ')' : ''}: <i>${s.descripcion}</i>\n` +
          `🛵 Valor del envío: <b>${COP(s.precioDomicilio || 0)}</b>\n━━━━━━━━━━━━━━━━━━\n¿Todo está correcto?`,
          {
            parse_mode: 'HTML', ...Markup.inlineKeyboard([
              [Markup.button.callback('✅ Confirmar', 'confirmar_paquete')],
              [Markup.button.callback('✏️ Corregir', 'modificar_paquete')],
              [Markup.button.callback('❌ Cancelar', 'cancelar_pedido')]
            ])
          }
        );
    }
    return;
  }

  // ── Pedido normal ─────────────────────────────────────────────────────────
  switch (s.paso) {
    case 'nombre':
      s.nombre = txt; s.paso = 'telefono';
      return ctx.reply(cardPedidoCliente(s) + `\n\n📱 ¿Cuál es tu <b>teléfono</b>?`, { parse_mode: 'HTML' });

    case 'telefono':
      s.telefono = txt; s.paso = 'direccion';
      return ctx.reply(
        cardPedidoCliente(s) +
        `\n\n📍 <b>Dirección de entrega</b>\n` +
        `Escribe la <b>dirección y barrio</b>:\n` +
        `<i>Ej: Cra 68 #97-95 Barrio Castilla, Medellín</i>`,
        { parse_mode: 'HTML' }
      );

    case 'direccion': {
      s.direccion = txt;  // guardamos la dirección RAW del cliente
      s.paso = 'esperando_ubi_cliente';
      clienteUbicacion[uid] = { pedidoId: null, barrio: txt };
      return ctx.reply(
        cardPedidoCliente(s) +
        `\n\n📍 <b>Comparte tu ubicación en tiempo real</b>\n\n` +
        `Así el domiciliario llega directo a donde estás.\n` +
        `👇 Toca 📎 → <b>Ubicación</b> → <b>Compartir en tiempo real</b>\n\n` +
        `<i>Si prefieres continuar solo con la dirección:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('⏭ Continuar sin GPS', `cli_skip_ubi_${uid}`)
          ]])
        }
      );
    }

    case 'esperando_ubi_cliente': {
      return ctx.reply(
        `📍 Por favor comparte tu <b>ubicación en tiempo real</b>,\n` +
        `o toca <b>Continuar sin GPS</b> para avanzar.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('⏭ Continuar sin GPS', `cli_skip_ubi_${uid}`)
          ]])
        }
      );
    }

    case 'referencia': {
      s.referencia = txt.toLowerCase() === 'no' ? '' : txt;
      await ctx.reply('📍 Verificando dirección...', { parse_mode: 'HTML' });
      let dirRefSheet = null;
      try {
        const matchSheet = await buscarBarrioEnSheet(s.direccion);
        dirRefSheet = matchSheet?.direccion || matchSheet?.nota || null;
      } catch (_) { }
      const r = await obtenerTarifaRapida(s.direccion, dirRefSheet);
      s.barrioDetectado = r.barrio || s.direccion;
      s.precioDomicilio = r.tarifa || 0;
      s.zona = r.zona || '';
      s.municipio = r.municipio || '';
      s.paqPeq = r.paqPeq || 0;
      s.paqMed = r.paqMed || 0;
      s.paqGran = r.paqGran || 0;
      if (s.negocio === 'wil') {
        s.paso = 'presupuesto';
        return ctx.reply(
          cardPedidoCliente(s) + `\n\n${r.mensaje}\n\n💰 ¿Cuánto tienes de <b>presupuesto</b>?\n<i>(Ej: 30000 o escribe "no sé")</i>`,
          { parse_mode: 'HTML' }
        );
      }
      s.paso = 'buscar';
      return ctx.reply(cardPedidoCliente(s) + `\n\n${r.mensaje}\n\n🔍 Escribe el nombre del medicamento:`, { parse_mode: 'HTML' });
    }

    case 'presupuesto': {
      const n = parseInt(txt.replace(/[^0-9]/g, ''));
      s.presupuesto = isNaN(n) ? 'Sin límite' : COP(n);
      s.paso = 'pedido_libre';
      return ctx.reply(
        cardPedidoCliente(s) + `\n\n💰 Presupuesto: <b>${s.presupuesto}</b>\n\n📦 ¿Qué necesitas?\n<i>Ej: "2 aceites, 1 arroz, 3 cervezas"</i>`,
        { parse_mode: 'HTML' }
      );
    }

    case 'pedido_libre': {
      await ctx.reply('🤖 Analizando tu pedido...');
      const items = await extraerProductosIA(txt);
      if (!items.length) return ctx.reply(`😕 No pude identificar productos.\nIntenta: <i>"2 aceites, 1 arroz"</i>`, { parse_mode: 'HTML' });
      s.carrito = items; s.paso = 'confirmar_libre';
      let lista = '';
      s.carrito.forEach((item, i) => { lista += `  ${i + 1}. ${item.descripcion} × ${item.cantidad}\n`; });
      return ctx.reply(
        `📋 <b>Entendí este pedido:</b>\n\n<code>${lista}</code>\n` +
        `💰 Presupuesto: <b>${s.presupuesto || 'Sin límite'}</b>\n` +
        `🛵 Domicilio: <b>${s.precioDomicilio ? COP(s.precioDomicilio) : 'Por confirmar'}</b>\n\n¿Es correcto?`,
        {
          parse_mode: 'HTML', ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Sí, confirmar', 'confirmar_pedido_libre')],
            [Markup.button.callback('✏️ Modificar pedido', 'modificar_libre')],
            [Markup.button.callback('❌ Cancelar', 'cancelar_pedido')]
          ])
        }
      );
    }

    case 'buscar': {
      if (txt.length < 2) return ctx.reply('🔍 Escribe al menos 2 letras.');
      const matchCant = txt.match(/^(\d+)\s+(.+)$/);
      if (matchCant) { s._cantPendiente = parseInt(matchCant[1]); return await buscarYMostrar(ctx, s, matchCant[2]); }
      return await buscarYMostrar(ctx, s, txt);
    }

    case 'cantidad': {
      const n = parseInt(txt);
      if (isNaN(n) || n <= 0) return ctx.reply('❌ Ingresa un número válido:');
      await agregarAlCarrito(ctx, s, n);
      break;
    }
  }
}

async function buscarYMostrar(ctx, s, termino) {
  await ctx.reply(`⏳ Buscando <b>"${termino}"</b>...`, { parse_mode: 'HTML' });
  const res = await buscarProductos(termino, s.tienda);
  if (!res.length) {
    return ctx.reply(
      `😕 No encontré <b>"${termino}"</b>.\nIntenta con otro nombre:`,
      {
        parse_mode: 'HTML', ...Markup.inlineKeyboard([
          ...(s.carrito.length ? [[Markup.button.callback('✅ Finalizar pedido', 'finalizar')]] : []),
          [Markup.button.callback('📞 No encuentro lo que busco', 'no_encuentro')]
        ])
      }
    );
  }
  s.busqueda = res;
  let msg = `💊 <b>${res.length}</b> resultado(s) para <b>"${termino}"</b>:\n\n`;
  res.forEach((p, i) => {
    const precioDisplay = p.tienePrecioVarios
      ? `1 und: <b>${COP(p.precioUnidad)}</b>  |  Varios: <b>${COP(p.precioUnitario)}</b>`
      : `<b>${COP(p.precioUnitario)}</b> c/u`;
    msg += `${i + 1}. <b>${p.descripcionCompleta || p.descripcion}</b>\n   🏭 ${p.laboratorio || '—'}  📦 ${p.unidad || 'Unidad'}\n   💰 ${precioDisplay}\n\n`;
  });
  const botones = res.map((p, i) => [Markup.button.callback(`${i + 1}. ${p.descripcion.substring(0, 28)} ${COP(p.precioUnitario)}`, `prod_${i}`)]);
  botones.push([Markup.button.callback('🔍 Buscar otro', 'buscar_otro')]);
  if (s.carrito.length) botones.push([Markup.button.callback('✅ Finalizar pedido', 'finalizar')]);
  return ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(botones) });
}

async function agregarAlCarrito(ctx, s, cantidad) {
  const p = s.prodSel;
  const pu = cantidad === 1 ? (p.precioUnidad || p.precioUnitario || 0) : (p.precioUnitario || p.precioUnidad || 0);
  s.carrito.push({ descripcion: p.descripcionCompleta || p.descripcion, laboratorio: p.laboratorio, unidad: p.unidad, cantidad, precioUnitario: pu, subtotal: pu * cantidad });
  s.paso = 'buscar'; delete s._cantPendiente;
  return ctx.reply(
    cardPedidoCliente(s) + `\n\n✅ <b>Agregado al carrito</b>\n\n🔍 ¿Qué más necesitas?`,
    {
      parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Agregar otro producto', 'buscar_otro')],
        [Markup.button.callback('✅ Finalizar pedido', 'finalizar')],
        [Markup.button.callback('🗑️ Vaciar carrito', 'vaciar')]
      ])
    }
  );
}

bot.action(/^prod_(\d+)$/, async ctx => {
  const uid = ctx.from.id; const s = S[uid];
  await ctx.answerCbQuery();
  if (!s?.busqueda?.[ctx.match[1]]) return ctx.reply('❌ Busca de nuevo.');
  s.prodSel = s.busqueda[parseInt(ctx.match[1])];
  if (s._cantPendiente) return await agregarAlCarrito(ctx, s, s._cantPendiente);
  s.paso = 'cantidad';
  const p = s.prodSel;
  return ctx.reply(
    `💊 <b>${p.descripcionCompleta || p.descripcion}</b>\n🏭 ${p.laboratorio || '—'}\n📦 ${p.unidad || 'Unidad'}\n` +
    (p.tienePrecioVarios
      ? `💰 1 und: <b>${COP(p.precioUnidad)}</b>  |  Varios: <b>${COP(p.precioUnitario)}</b>\n\n`
      : `💰 <b>${COP(p.precioUnitario)}</b> c/u\n\n`) +
    `¿Cuántas unidades?`,
    { parse_mode: 'HTML' }
  );
});

bot.action('buscar_otro', async ctx => { const s = S[ctx.from.id]; await ctx.answerCbQuery(); if (!s) return; s.paso = 'buscar'; return ctx.reply('🔍 Escribe el nombre del medicamento:'); });
bot.action('no_encuentro', async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply(`📞 <b>¿No encontraste lo que buscas?</b>\n\nWhatsApp: <b>${process.env.WHATSAPP_NUMERO || '3XXXXXXXXX'}</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Volver', 'menu_pedido')]]) });
});
bot.action('vaciar', async ctx => { const s = S[ctx.from.id]; await ctx.answerCbQuery('🗑️ Vaciado'); if (!s) return; s.carrito = []; s.paso = 'buscar'; return ctx.reply(cardPedidoCliente(s) + '\n\n🔍 Busca un producto:', { parse_mode: 'HTML' }); });
bot.action('modificar_libre', async ctx => { const s = S[ctx.from.id]; await ctx.answerCbQuery(); if (!s) return; s.carrito = []; s.paso = 'pedido_libre'; return ctx.reply('✏️ Escribe de nuevo tu pedido:'); });
bot.action('cancelar_pedido', async ctx => { delete S[ctx.from.id]; await ctx.answerCbQuery('❌ Cancelado'); return ctx.reply('❌ Pedido cancelado. /start para comenzar.'); });

bot.action('finalizar', async ctx => {
  const s = S[ctx.from.id]; await ctx.answerCbQuery();
  if (!s?.carrito?.length) return ctx.reply('❌ Tu carrito está vacío.');
  s.paso = 'pago';
  return ctx.reply(cardPedidoCliente(s) + `\n\n💳 ¿Cómo vas a pagar?`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💵 Efectivo', 'pago_EFECTIVO')],
      [Markup.button.callback('📲 Nequi/Daviplata', 'pago_NEQUI')],
      [Markup.button.callback('🏦 Transferencia', 'pago_TRANSFERENCIA')]
    ])
  });
});

bot.action('confirmar_pedido_libre', async ctx => {
  const s = S[ctx.from.id]; await ctx.answerCbQuery();
  if (!s) return;
  s.paso = 'pago';
  return ctx.reply(cardPedidoCliente(s) + `\n\n💳 ¿Cómo vas a pagar?`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💵 Efectivo', 'pago_EFECTIVO')],
      [Markup.button.callback('📲 Nequi/Daviplata', 'pago_NEQUI')],
      [Markup.button.callback('🏦 Transferencia', 'pago_TRANSFERENCIA')]
    ])
  });
});

bot.action(/^pago_(.+)$/, async ctx => {
  const s = S[ctx.from.id]; await ctx.answerCbQuery();
  if (!s) return;
  s.metodoPago = ctx.match[1];
  if (s.metodoPago !== 'EFECTIVO') { s.paso = 'comprobante'; return ctx.reply('📸 Envía la <b>foto del comprobante</b>:', { parse_mode: 'HTML' }); }
  await procesarPedido(ctx, ctx.from.id);
});

// ══════════════════════════════════════════════════════════════════════════════
// PROCESAR PEDIDO
// PARCHE 4a: Canal con dirección clickeable + PARCHE guarda direccionCliente
// ══════════════════════════════════════════════════════════════════════════════
async function procesarPedido(ctx, uid) {
  const s = S[uid];
  const sub = s.carrito.reduce((a, i) => a + (i.subtotal || 0), 0);
  const dom = s.precioDomicilio || 0;
  const tot = !s.tienda ? 0 : sub + dom;
  const id = await registrarPedido({
    nombre: s.nombre, telefono: s.telefono, metodoPago: s.metodoPago,
    imagenFileId: s.imagenFileId || '', carrito: s.carrito, negocioNombre: s.negocioNombre,
    tienda: s.tienda, direccion: s.barrioDetectado || s.direccion,
    precioDomicilio: dom, totalFinal: tot, presupuesto: s.presupuesto
  });
  await ctx.reply(facturaHTML(s, id) + `\n\n🆔 <b>${id}</b>\n<i>Guarda este ID para consultar tu pedido.</i>`, { parse_mode: 'HTML' });

  // PARCHE: guardar direccionCliente (la que ingresó el cliente literalmente)
  pool[id] = {
    id, negocioNombre: s.negocioNombre, tienda: s.tienda || null, tipo: 'pedido',
    cliente: s.nombre, telefono: s.telefono, clienteId: uid,
    direccionCliente: s.direccion,                     // ← RAW del cliente
    direccion: s.barrioDetectado || s.direccion,       // ← normalizada para lógica interna
    barrio: s.barrioDetectado || s.direccion,
    presupuesto: s.presupuesto || null, zona: s.zona || '', municipio: s.municipio || '',
    productos: s.carrito.map(i => `${i.cantidad}× ${i.descripcion}`).join(', '),
    carrito: s.carrito, total: tot > 0 ? tot : null, precioDomicilio: dom,
    estado: 'PENDIENTE', hora: moment().tz('America/Bogota').format('hh:mm A'),
    createdAt: Date.now(),
    latCliente: s.latCliente || null,
    lngCliente: s.lngCliente || null,
  };

  if (s.latCliente && s.lngCliente) {
    clienteUbicacion[uid] = { pedidoId: id, barrio: s.barrioDetectado || s.direccion || '' };
    actualizarUbicacionPedido(id, s.latCliente, s.lngCliente).catch(() => { });
  }

  const { pend } = await getContadores();
  for (const [did, d] of Object.entries(drivers)) {
    if (!d.pedidoActual) {
      bot.telegram.sendMessage(did,
        `🔴 <b>Nuevo pedido</b>\n🆕 <b>${id}</b>\n🏪 ${s.negocioNombre}\n` +
        `📍 ${s.direccion}\n🛵 Domicilio: <b>${COP(dom)}</b>\n\nPresiona 📋 Pendientes (${pend})`,
        { parse_mode: 'HTML' }
      ).catch(() => { });
    }
  }

  // PARCHE 4a: Canal con dirección clickeable
  if (process.env.CANAL_PEDIDOS_ID) {
    const dirLink = gmapsLinkDir(s.direccion);
    const cardCanal =
      `🔴 <b>NUEVO PEDIDO — ${id}</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `🏪 ${s.negocioNombre}\n` +
      `👤 ${s.nombre}  📱 ${s.telefono}\n` +
      `📍 <a href="${dirLink}">${s.direccion}</a>\n` +
      `🛵 Domicilio: <b>${COP(dom)}</b>\n` +
      `⏰ ${moment().tz('America/Bogota').format('hh:mm A')}\n━━━━━━━━━━━━━━━━━━`;
    bot.telegram.sendMessage(process.env.CANAL_PEDIDOS_ID, cardCanal, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => { });
  }
  delete S[uid];
}

function facturaHTML(s, id) {
  const esWIL = !s.tienda;
  const dom = s.precioDomicilio || 0;
  const ahora = moment().tz('America/Bogota').format('DD/MM/YYYY hh:mm A');
  const sub = s.carrito.reduce((a, i) => a + (i.subtotal || 0), 0);
  const tot = sub + dom;
  let filas = '';
  s.carrito.forEach(item => {
    filas += `╠══════════════════════════╣\n`;
    filas += `║ ${item.descripcion.substring(0, 26).padEnd(26)} ║\n`;
    if (!esWIL && item.precioUnitario > 0) {
      const precStr = COP(item.precioUnitario).padEnd(10);
      const subStr = COP(item.subtotal).padStart(8);
      filas += `║ ${item.cantidad}x ${precStr} ${subStr} ║\n`;
    } else {
      filas += `║ Cant: ${String(item.cantidad).padEnd(21)} ║\n`;
    }
  });
  const bloqueTotal = esWIL
    ? `║ Productos  PENDIENTE      ║\n║ Domicilio  ${COP(dom).padStart(14)} ║\n╠══════════════════════════╣\n║ TOTAL      POR CONFIRMAR ║\n║ Pago: ${(s.metodoPago || '').padEnd(20)} ║\n╚══════════════════════════╝</code>\n\n<i>🛵 El domiciliario comprará y te enviará la factura con el total.</i>`
    : (sub > 0 ? `║ Subtotal   ${COP(sub).padStart(14)} ║\n` : '') +
    `║ Domicilio  ${COP(dom).padStart(14)} ║\n╠══════════════════════════╣\n║ TOTAL      ${COP(tot).padStart(14)} ║\n║ Pago: ${(s.metodoPago || '').padEnd(20)} ║\n╚══════════════════════════╝</code>\n\n<i>🛵 En breve un domiciliario tomará tu pedido.</i>`;
  return (
    `✅ <b>¡PEDIDO CONFIRMADO!</b>\n\n<code>` +
    `╔══════════════════════════╗\n║    🛵 DOMICILIOS WIL    ║\n║   Copacabana, Ant.      ║\n` +
    `╠══════════════════════════╣\n║ ID: ${id.substring(0, 21).padEnd(21)} ║\n║ ${ahora.padEnd(26)} ║\n` +
    `╠══════════════════════════╣\n║ 👤 ${(s.nombre || '').substring(0, 22).padEnd(22)} ║\n║ 📍 ${(s.barrioDetectado || s.direccion || '').substring(0, 22).padEnd(22)} ║\n` +
    `╠══════════════════════════╣\n║ 🏪 ${(s.negocioNombre || '').substring(0, 22).padEnd(22)} ║\n` +
    filas + `╠══════════════════════════╣\n` + bloqueTotal
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// RECORDATORIO AUTOMÁTICO
// ══════════════════════════════════════════════════════════════════════════════
const _yaAlertados = new Set();
const _inactividadAlertada = new Set();

async function enviarRecordatorio() {
  const hoy = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const ahora = moment().tz('America/Bogota');

  const psSheet = await pendientesSinAtender(10).catch(() => []);
  const psPool = Object.values(pool).filter(p => {
    if (p.estado !== 'PENDIENTE') return false;
    const horaRef = p.hora || p.createdAt || null;
    if (!horaRef) return true;
    const t = p.createdAt
      ? moment(p.createdAt)
      : moment.tz(`${hoy} ${horaRef}`, 'DD/MM/YYYY hh:mm A', 'America/Bogota');
    return t.isValid() && ahora.diff(t, 'minutes') >= 10;
  });

  const todos = [...psSheet];
  for (const pp of psPool) {
    if (!todos.find(x => x.id === pp.id)) todos.push(pp);
  }

  const nuevos = todos.filter(p => !_yaAlertados.has(p.id));
  if (!nuevos.length) return;

  nuevos.forEach(p => _yaAlertados.add(p.id));
  setTimeout(() => nuevos.forEach(p => _yaAlertados.delete(p.id)), 20 * 60 * 1000);

  let msg = `⚠️ <b>PEDIDOS SIN ATENDER (+10 min)</b>\n━━━━━━━━━━━━━━\n\n`;
  nuevos.forEach(p => {
    const t = moment.tz(`${hoy} ${p.hora}`, 'DD/MM/YYYY hh:mm A', 'America/Bogota');
    const mins = ahora.diff(t, 'minutes');
    msg +=
      `🔴 <b>${p.id}</b>\n` +
      `👤 ${p.cliente || '—'}  📱 ${p.telefono || '—'}\n` +
      `📍 ${p.direccionCliente || p.direccion || p.barrio || '—'}\n` +
      `⏰ Hace <b>${mins} min</b>\n\n`;
  });

  if (process.env.CANAL_PEDIDOS_ID) {
    bot.telegram.sendMessage(process.env.CANAL_PEDIDOS_ID, msg, { parse_mode: 'HTML' }).catch(() => { });
  }
  for (const id of ADMIN_IDS) {
    bot.telegram.sendMessage(id, msg, { parse_mode: 'HTML' }).catch(() => { });
  }
  for (const [did, d] of Object.entries(drivers)) {
    if (!d.pedidoActual) {
      bot.telegram.sendMessage(did,
        `🔴 <b>${nuevos.length}</b> pedido(s) sin atender más de 10 min\nRevisa 📋 <b>Pendientes</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => { });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ALERTA INACTIVIDAD DOMICILIARIO
// ══════════════════════════════════════════════════════════════════════════════
async function revisarInactividad() {
  const ahora = Date.now();
  const UNA_HORA = 60 * 60 * 1000;

  for (const [did, d] of Object.entries(drivers)) {
    if (d.pedidoActual) {
      _inactividadAlertada.delete(did);
      continue;
    }

    const ultimaAct = d.lastActivity || d.loginTs || ahora;
    const inactivo = ahora - ultimaAct;

    if (inactivo >= UNA_HORA && !_inactividadAlertada.has(did)) {
      _inactividadAlertada.add(did);

      const mins = Math.floor(inactivo / 60000);
      const horas = Math.floor(mins / 60);
      const resto = mins % 60;
      const tStr = horas > 0 ? `${horas}h ${resto}m` : `${mins} min`;

      const pendientes = Object.values(pool).filter(p => p.estado === 'PENDIENTE');

      for (const adminId of ADMIN_IDS) {
        let msg =
          `⚠️ <b>DOMICILIARIO INACTIVO</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━\n` +
          `👤  <b>${d.nombre}</b>\n` +
          `⏱  Sin actividad hace  <b>${tStr}</b>\n` +
          `📡  Conectado pero sin responder\n` +
          `━━━━━━━━━━━━━━━━━━━━━━`;

        const botonesAdmin = [];
        if (pendientes.length > 0) {
          msg += `\n\n📋  Hay <b>${pendientes.length}</b> pedido(s) pendiente(s).\nPuedes asignarle uno directamente:`;
          pendientes.slice(0, 3).forEach(p => {
            botonesAdmin.push([Markup.button.callback(`Asignar ${p.id} a ${d.nombre}`, `asignar_${p.id}_${did}`)]);
          });
        } else {
          msg += `\n\n<i>No hay pedidos pendientes en este momento.</i>`;
        }

        bot.telegram.sendMessage(adminId, msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(botonesAdmin) }).catch(() => { });
      }
    }

    if (inactivo < UNA_HORA) {
      _inactividadAlertada.delete(did);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ASIGNAR PEDIDO (admin → driver inactivo)
// ══════════════════════════════════════════════════════════════════════════════
bot.action(/^asignar_(.+)_(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  if (!esAdmin(ctx.from.id)) return;

  const pedidoId = ctx.match[1];
  const driverId = ctx.match[2];
  const d = drivers[driverId];

  if (!d) {
    return ctx.editMessageText(`❌ El domiciliario ya no está conectado.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }).catch(() => { });
  }
  if (d.pedidoActual) {
    return ctx.editMessageText(`⚠️ <b>${d.nombre}</b> ya tiene el pedido <b>${d.pedidoActual}</b> activo.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }).catch(() => { });
  }

  if (!pool[pedidoId]) {
    const lista = await getPedidos('PENDIENTE').catch(() => []);
    const found = lista.find(x => x.id === pedidoId);
    if (!found) {
      return ctx.editMessageText(`❌ Pedido <b>${pedidoId}</b> ya no está disponible.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }).catch(() => { });
    }
    pool[pedidoId] = {
      id: found.id, negocioNombre: found.negocio || found.negocioNombre || '—',
      tienda: found.tienda || null, tipo: found.tipo || null,
      cliente: found.cliente || '—', telefono: found.telefono || '—',
      clienteId: found.clienteId || null,
      direccionCliente: found.direccionCliente || found.direccion || '—',
      direccion: found.direccion || '—',
      barrio: found.barrio || found.direccion || '—', productos: found.productos || '—',
      total: found.total || null, precioDomicilio: found.precioDomicilio || 0,
      estado: 'PENDIENTE', carrito: found.carrito || [], hora: found.hora || null
    };
  }

  const p = pool[pedidoId];
  if (p.estado !== 'PENDIENTE') {
    return ctx.editMessageText(`⚠️ El pedido <b>${pedidoId}</b> ya fue tomado.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }).catch(() => { });
  }

  p.estado = 'EN_PROCESO';
  p.domiciliario = d.nombre;
  p.horaTomo = moment().tz('America/Bogota').format('hh:mm A');
  d.pedidoActual = pedidoId;
  d.lastActivity = Date.now();
  _inactividadAlertada.delete(driverId);

  await asignarDomiciliario(pedidoId, d.nombre).catch(() => { });

  try {
    await ctx.editMessageText(
      `✅ <b>Pedido ${pedidoId} asignado a ${d.nombre}</b>\n⏰ ${p.horaTomo}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
  } catch (_) { }

  const dLat6 = drivers[driverId]?.lat || null;
  const dLng6 = drivers[driverId]?.lng || null;
  const gmaps = buildGmapsUrl(p.barrio || p.direccion || '', p, dLat6, dLng6);
  const telDomi = d.telefono || '';

  bot.telegram.sendMessage(driverId,
    `👋 <b>Hola ${d.nombre},</b>\n\n` +
    `Te han asignado un nuevo pedido. Por favor atiéndelo tan pronto puedas 🙏\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔  <b>${pedidoId}</b>\n` +
    `🏪  ${p.negocioNombre || '—'}\n` +
    `👤  ${p.cliente || '—'}  📱 ${p.telefono || '—'}\n` +
    `📍  <b>${p.direccionCliente || p.direccion || p.barrio}</b>\n` +
    `💵  Domicilio: <b>${COP(p.precioDomicilio || 0)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Recuerda ser puntual y amable con el cliente 😊</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Entregar', `entregar_${pedidoId}`), Markup.button.url('🗺️ Ver Ruta', gmaps)],
        [Markup.button.callback('📸 Subir Factura', `factura_${pedidoId}`)]
      ])
    }
  ).catch(() => { });

  // PARCHE 9: Notificar cliente con nombre + teléfono del domiciliario al asignar
  if (p.clienteId) {
    const dirDisplay = p.direccionCliente || p.direccion || p.barrio || '—';
    let productosDetalle = p.productos || '—';
    if (p.carrito?.length > 0) productosDetalle = p.carrito.map(i => `• ${i.cantidad}× ${i.descripcion}`).join('\n');

    const trackerMsg =
      `🛵 <b>¡Tu pedido está en camino!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ <b>Domiciliario asignado</b>\n\n` +
      `👤 <b>${d.nombre}</b>\n` +
      (telDomi ? `📱 <b>${telDomi}</b>\n` : '') +
      `\n🏪 ${p.negocioNombre || '—'}\n` +
      `📍 ${dirDisplay}\n\n` +
      `📦 <b>Productos:</b>\n${productosDetalle}\n\n` +
      `🛵 Domicilio: <b>${COP(p.precioDomicilio || 0)}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔴 <b>Tiempo estimado: 40 minutos</b>\n` +
      `🏍️🏍️🏍️🏍️🏍️............\n` +
      `<i>¡Tu pedido viene en camino! 🛵❤️</i>`;
    bot.telegram.sendMessage(p.clienteId, trackerMsg, { parse_mode: 'HTML' }).catch(() => { });
  }

  if (process.env.CANAL_PEDIDOS_ID) {
    const dirCliente = p.direccionCliente || p.direccion || p.barrio || '—';
    const dirLink = gmapsLinkDir(dirCliente);
    bot.telegram.sendMessage(process.env.CANAL_PEDIDOS_ID,
      `🔵 <b>ASIGNADO POR ADMIN — ${pedidoId}</b>\n` +
      `🛵 Domiciliario: <b>${d.nombre}</b>\n` +
      `👤 ${p.cliente || '—'}  📱 ${p.telefono || '—'}\n` +
      `📍 <a href="${dirLink}">${dirCliente}</a>\n⏰ ${p.horaTomo}`,
      { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(() => { });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════════════════════════════
async function saludarAlArrancar() {
  const hora = moment().tz('America/Bogota').format('hh:mm A');
  const fecha = moment().tz('America/Bogota').format('DD/MM/YYYY');
  if (process.env.CANAL_PEDIDOS_ID) {
    bot.telegram.sendMessage(process.env.CANAL_PEDIDOS_ID,
      `🟢 <b>¡Domicilios WIL en línea!</b>\n📅 ${fecha}   ⏰ ${hora}\n📍 Copacabana, Antioquia\n\n✅ Bot listo para recibir pedidos.`,
      { parse_mode: 'HTML' }
    ).catch(() => { });
  }
  for (const id of ADMIN_IDS) {
    menuAdmin().then(kb => bot.telegram.sendMessage(id, `🟢 <b>Bot WIL iniciado</b>\n⏰ ${hora} — ${fecha}`, { parse_mode: 'HTML', ...kb })).catch(() => { });
  }
}

function iniciarCron() {
  cron.schedule('*/10 * * * *', () => enviarRecordatorio().catch(e => console.error('cron pedidos:', e.message)), { timezone: 'America/Bogota' });
  cron.schedule('*/10 * * * *', () => revisarInactividad().catch(e => console.error('cron inactividad:', e.message)), { timezone: 'America/Bogota' });
  console.log('⏰ Crons activos: pedidos (10 min) | inactividad drivers (10 min)');
}

module.exports = {
  bot, wilBot: bot,
  iniciarCron, saludarAlArrancar,
  getPool: () => pool,
  getDrivers: () => drivers
};

/*
── USO EN index.js ──────────────────────────────────────────────
const { wilBot, iniciarCron, saludarAlArrancar } = require('./bots/wilBot');
wilBot.launch().then(async () => {
  console.log('🤖 WilBot corriendo');
  iniciarCron();
  await saludarAlArrancar();
});
────────────────────────────────────────────────────────────────
*/