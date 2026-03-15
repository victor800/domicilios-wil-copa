// ══════════════════════════════════════════════════════════════════════════════
// features.js — Domicilios WIL
// Módulo de funcionalidades avanzadas:
//   1. Pedidos programados (agendar para fecha/hora futura)
//   2. Historial del cliente
//   3. Negocios aliados dinámicos (catálogo desde sheet)
//   4. Foto del domiciliario (columna F hoja Domiciliarios — URL local o web)
//   5. Encuesta post-entrega mejorada (estrellas + categoría)
//   6. ETA en tiempo real (actualización automática con GPS del domi)
//   7. Turno del domi (mañana / tarde / noche / completo)
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Markup } = require('telegraf');
const moment     = require('moment-timezone');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');

// sharp es opcional — si no está instalado, se envía la foto sin procesar
let sharp = null;
try { sharp = require('sharp'); } catch (_) { console.warn('⚠️  sharp no instalado — foto sin recorte circular. Instala con: npm install sharp'); }

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS LOCALES
// ──────────────────────────────────────────────────────────────────────────────
const COP = n => {
  if (n === null || n === undefined || n === '') return '$0';
  if (typeof n === 'string') n = parseFloat(n.replace(/\./g, '').replace(/[^0-9\-]/g, '')) || 0;
  const num = Math.round(Number(n));
  if (isNaN(num)) return '$0';
  return (num < 0 ? '-$' : '$') + Math.abs(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};

const TZ      = 'America/Bogota';
const ahoraBog = () => moment().tz(TZ);

// ══════════════════════════════════════════════════════════════════════════════
// 1. PEDIDOS PROGRAMADOS
// ══════════════════════════════════════════════════════════════════════════════

/** Almacén en memoria  id → { pedido, dispararEn, dispararEnStr, enviado } */
const pedidosProgramados = {};

/**
 * Agenda un pedido para dispararse en una fecha/hora futura.
 * @param {string} id        ID del pedido
 * @param {object} pedido    objeto pedido completo (mismo formato del pool)
 * @param {string} fechaHora texto libre: "mañana 2pm" | "hoy 14:30" | "pasado 9am"
 * @returns {{ ok, dispararEn, error }}
 */
function agendarPedido(id, pedido, fechaHora) {
  try {
    const txtLow    = fechaHora.toLowerCase().trim();
    const horaMatch = txtLow.match(/(\d{1,2})[:\.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i);
    if (!horaMatch) return { ok: false, error: 'No reconocí la hora. Usa: 2:30pm o 14:30' };

    let horas    = parseInt(horaMatch[1]);
    const minutos = parseInt(horaMatch[2]);
    const mer     = (horaMatch[3] || '').replace(/\./g, '').toLowerCase();
    if (mer === 'pm' && horas < 12) horas += 12;
    if (mer === 'am' && horas === 12) horas = 0;

    const base = txtLow.includes('pasado')
      ? ahoraBog().add(2, 'day').startOf('day')
      : txtLow.includes('mañana')
        ? ahoraBog().add(1, 'day').startOf('day')
        : ahoraBog().startOf('day');

    const ts = base.hours(horas).minutes(minutos).seconds(0);

    if (ts.isBefore(ahoraBog())) {
      if (!txtLow.includes('mañana') && !txtLow.includes('pasado')) {
        ts.add(1, 'day');
      } else {
        return { ok: false, error: 'Esa hora ya pasó. Elige una hora futura.' };
      }
    }

    pedidosProgramados[id] = {
      pedido:        { ...pedido, estado: 'PROGRAMADO' },
      dispararEn:    ts.valueOf(),
      dispararEnStr: ts.format('DD/MM/YYYY hh:mm A'),
      enviado:       false
    };

    console.log(`⏰ Pedido programado ${id} → ${ts.format('DD/MM/YYYY hh:mm A')}`);
    return { ok: true, dispararEn: ts.format('DD/MM/YYYY hh:mm A'), error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Cron cada minuto: revisa pedidos programados vencidos y los activa.
 * @param {Function} activarCallback  (id, pedido) → Promise
 */
function iniciarCronProgramados(activarCallback) {
  cron.schedule('* * * * *', async () => {
    const ahora = Date.now();
    for (const [id, entry] of Object.entries(pedidosProgramados)) {
      if (!entry.enviado && entry.dispararEn <= ahora) {
        entry.enviado = true;
        console.log(`⏰ Disparando pedido programado ${id}`);
        try {
          await activarCallback(id, entry.pedido);
        } catch (e) {
          console.error(`Error activando pedido programado ${id}:`, e.message);
          entry.enviado = false; // retry
        }
      }
    }
  }, { timezone: TZ });
  console.log('⏰ Cron pedidos programados activo (cada minuto)');
}

/**
 * Pedidos programados pendientes de un cliente.
 */
function getPedidosProgramadosCliente(clienteId) {
  return Object.entries(pedidosProgramados)
    .filter(([, e]) => e.pedido.clienteId === clienteId && !e.enviado)
    .map(([id, e]) => ({ id, dispararEnStr: e.dispararEnStr, pedido: e.pedido }));
}

/**
 * Cancela un pedido programado.
 */
function cancelarPedidoProgramado(id) {
  if (pedidosProgramados[id]) { delete pedidosProgramados[id]; return true; }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. HISTORIAL DEL CLIENTE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Construye el mensaje de historial para un cliente.
 * @param {number}   clienteId
 * @param {object}   pool        pool global de pedidos de wilBot
 * @param {Function} getPedidos  fn(estado) → rows del sheet
 */
async function buildHistorialCliente(clienteId, pool, getPedidos) {
  const enPool = Object.values(pool)
    .filter(p => p.clienteId === clienteId && p.estado !== 'CANCELADO')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 10);

  let enSheet = [];
  try {
    enSheet = (await getPedidos('FINALIZADO'))
      .filter(p => String(p.clienteId) === String(clienteId))
      .slice(0, 10);
  } catch (_) {}

  const ids   = new Set(enPool.map(p => p.id));
  const todos = [...enPool, ...enSheet.filter(p => !ids.has(p.id))].slice(0, 8);

  if (!todos.length) {
    return `📋 <b>Tu historial</b>\n\n<i>Aún no tienes pedidos registrados.\nHaz tu primer pedido con el menú 🛵</i>`;
  }

  const badge = e => ({ FINALIZADO:'✅', ENTREGADO:'✅', EN_PROCESO:'🔵', PENDIENTE:'🟡', PROGRAMADO:'⏰' }[e] || '⚪');

  let msg = `📋 <b>Tus últimos pedidos</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
  todos.forEach((p, i) => {
    const total = p.total ? COP(Number(String(p.total).replace(/\./g,'').replace(/[^0-9]/g,''))) : '—';
    const prods = p.productos
      ? p.productos.split(',').slice(0,2).map(x=>x.trim()).join(', ') + (p.productos.split(',').length > 2 ? '...' : '')
      : '—';
    msg +=
      `${i+1}. ${badge(p.estado)} <b>${p.id}</b>\n` +
      `   📅 ${p.fecha || p.hora || '—'}  💵 ${total}\n` +
      `   📦 ${prods}\n` +
      `   📍 ${(p.direccionCliente || p.direccion || '—').slice(0,35)}\n\n`;
  });
  msg += `<i>¿Quieres repetir algún pedido? Toca el botón 👇</i>`;
  return msg;
}

/**
 * Botones de historial con opción de repetir.
 */
function botonesHistorial(todos) {
  const fin  = todos.filter(p => p.estado === 'FINALIZADO' || p.estado === 'ENTREGADO').slice(0, 3);
  const btns = fin.map(p => [Markup.button.callback(`🔄 Repetir ${p.id}`, `repetir_${p.id}`)]);
  btns.push([Markup.button.callback('🛵 Nuevo pedido', 'menu_pedido')]);
  return Markup.inlineKeyboard(btns);
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. NEGOCIOS ALIADOS DINÁMICOS
// ══════════════════════════════════════════════════════════════════════════════

let _aliadosCache  = null;
let _aliadosCacheTs = 0;
const ALIADOS_TTL   = 5 * 60 * 1000;

/**
 * Carga aliados desde la hoja "Aliados" del sheet.
 * Columnas: A=id, B=nombre, C=emoji, D=descripcion, E=activo(SI/NO), F=tienda_key
 */
async function getAliados(getSheetFn) {
  const ahora = Date.now();
  if (_aliadosCache && ahora - _aliadosCacheTs < ALIADOS_TTL) return _aliadosCache;
  try {
    const rows = await getSheetFn('Aliados!A2:F50');
    _aliadosCache = (rows || [])
      .filter(r => r[0] && r[4]?.toString().toUpperCase() === 'SI')
      .map(r => ({
        id:          r[0].toString().trim(),
        nombre:      (r[2]?.trim() || '') + ' ' + (r[1]?.trim() || ''),
        emoji:       r[2]?.trim() || '🏪',
        descripcion: r[3]?.trim() || '',
        tienda:      r[5]?.trim() || r[0].toString().trim().toUpperCase(),
        activo:      true
      }));
    _aliadosCacheTs = ahora;
    console.log(`🏪 ${_aliadosCache.length} aliados cargados desde sheet`);
  } catch (e) {
    console.warn('getAliados (sheet no disponible):', e.message);
    _aliadosCache = _aliadosCache || [];
  }
  return _aliadosCache;
}

function invalidarCacheAliados() {
  _aliadosCache   = null;
  _aliadosCacheTs = 0;
}

/**
 * Inline keyboard del menú de pedido con aliados dinámicos incluidos.
 */
async function buildMenuPedido(getSheetFn) {
  const aliados = await getAliados(getSheetFn);
  const btns = [
    [Markup.button.callback('🏪 Domicilios WIL (general)',   'neg_wil')],
    [Markup.button.callback('💊 Drogueria Farma Expertos Copacabana',   'neg_expertos')],
    [Markup.button.callback('🏥 Drogueria Central Copacabana','neg_central')],
  ];
  aliados.forEach(a => btns.push([Markup.button.callback(a.nombre, `neg_${a.id}`)]));
  btns.push([Markup.button.callback('📦 Paquetería', 'paqueteria')]);
  if (aliados.length > 0) btns.push([Markup.button.callback('🤝 Ver todos los aliados','ver_aliados')]);
  return Markup.inlineKeyboard(btns);
}

/**
 * Devuelve el objeto negocio {nombre, tienda} dado un key de aliado.
 */
async function resolverNegocio(key, getSheetFn) {
  const BASE = {
    wil:      { nombre: '🏪 Domicilios WIL',       tienda: null },
    expertos: { nombre: '💊 Drogueria Farma Expertos',     tienda: 'EXPERTOS' },
    central:  { nombre: '🏥 Drogueria Central',   tienda: 'CENTRAL' },
  };
  if (BASE[key]) return BASE[key];
  const aliados = await getAliados(getSheetFn);
  const a = aliados.find(x => x.id === key);
  if (a) return { nombre: a.nombre, tienda: a.tienda };
  return { nombre: '🏪 ' + key, tienda: key.toUpperCase() };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. FOTO DEL DOMICILIARIO
// ══════════════════════════════════════════════════════════════════════════════
//
// FUENTES DE FOTO (en orden de prioridad):
//   1. Enviada por el domi en vivo con caption "mi foto"  → fileId Telegram
//   2. URL en columna F de la hoja Domiciliarios           → archivo local en
//      /assets/<nombre>.jpg  o URL http/https
//   3. Sin foto → mensaje texto plano
//
// Para la hoja: pon en col F la ruta relativa "assets/juan.jpg"
// (o una URL https://...).  El bot cargará la imagen y la enviará como
// InputFile local o como URL directa.
// ══════════════════════════════════════════════════════════════════════════════

/** Cache driverNombre → { fileId?, urlLocal?, ts } */
const fotosDomiciliarios = {};

/**
 * Guarda el fileId de Telegram de la foto enviada por el domi (priority 1).
 */
function guardarFotoDomi(nombre, fileId) {
  const key = nombre.toLowerCase().trim();
  fotosDomiciliarios[key] = { ...fotosDomiciliarios[key], fileId, ts: Date.now() };
  console.log(`📷 Foto (fileId) guardada para domiciliario: ${nombre}`);
}

/**
 * Guarda la URL/ruta de la foto leída desde el sheet (priority 2).
 * Se llama desde getSheetDrivers() al cargar la hoja Domiciliarios.
 */
function guardarFotoDomiUrl(nombre, urlOrPath) {
  if (!urlOrPath || !urlOrPath.trim()) return;
  const key = nombre.toLowerCase().trim();
  const actual = fotosDomiciliarios[key];
  const tieneFileIdFresco = actual?.fileId && (Date.now() - (actual.ts || 0)) < 86400000;
  if (!tieneFileIdFresco) {
    let valorFinal = urlOrPath.trim();
    if (!/^https?:\/\//i.test(valorFinal)) {
      const intentos = [
        path.resolve(process.cwd(), valorFinal),
        path.resolve(process.cwd(), 'assets', path.basename(valorFinal)),
        path.resolve(__dirname, '..', 'assets', path.basename(valorFinal)),
        path.resolve(__dirname, 'assets', path.basename(valorFinal)),
      ];
      for (const intento of intentos) {
        if (fs.existsSync(intento)) { valorFinal = intento; break; }
      }
    }
    fotosDomiciliarios[key] = { ...actual, urlLocal: valorFinal, ts: Date.now() };
    console.log(`📷 Foto registrada para ${nombre}: ${valorFinal}`);
  }
}

/**
 * Intenta auto-detectar la foto del domi buscando en la carpeta assets/
 * por el nombre del domiciliario (normalizado, sin tildes, en minúsculas).
 * Extensiones soportadas: jpg, jpeg, png, webp.
 * Se llama al hacer login si no hay fileId ni urlLocal.
 */
function autoDetectarFotoAssets(nombre) {
  const key = nombre.toLowerCase().trim();
  const entry = fotosDomiciliarios[key];
  if (entry?.fileId || entry?.urlLocal) return; // ya tiene foto

  const normalizar = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const nombreNorm = normalizar(nombre);
  const primerNombre = nombreNorm.split(' ')[0];

  // Buscar en assets/ relativo al cwd del proceso
  const posiblesDirs = [
    path.resolve(process.cwd(), 'assets'),
    path.resolve(process.cwd(), 'src', 'assets'),
    path.resolve(__dirname, '..', 'assets'),
    path.resolve(__dirname, 'assets'),
  ];

  const exts = ['.jpg', '.jpeg', '.png', '.webp'];
  let encontrado = null;

  for (const assetsDir of posiblesDirs) {
    if (!fs.existsSync(assetsDir)) continue;
    try {
      const archivos = fs.readdirSync(assetsDir);
      console.log(`📁 assets/ encontrado en: ${assetsDir} (${archivos.length} archivos)`);
      for (const archivo of archivos) {
        const ext = path.extname(archivo).toLowerCase();
        if (!exts.includes(ext)) continue;
        const baseSinExt = normalizar(path.basename(archivo, ext));
        if (baseSinExt === nombreNorm || baseSinExt === primerNombre || nombreNorm.startsWith(baseSinExt) || primerNombre.startsWith(baseSinExt)) {
          encontrado = path.join(assetsDir, archivo);
          console.log(`📷 Coincidencia: "${archivo}" para domi "${nombre}"`);
          break;
        }
      }
    } catch (e) {
      console.warn(`autoDetectarFotoAssets error en ${assetsDir}: ${e.message}`);
    }
    if (encontrado) break;
  }

  if (encontrado) {
    fotosDomiciliarios[key] = { ...entry, urlLocal: encontrado, ts: Date.now() };
    console.log(`📷 Foto registrada para ${nombre}: ${encontrado}`);
  } else {
    console.warn(`📷 No se encontró foto en assets/ para domi: "${nombre}" (buscado: "${nombreNorm}", "${primerNombre}")`);
  }
}

/**
 * Resuelve el "input" de foto para sendPhoto / sendMessage.
 * Devuelve:
 *   { tipo: 'fileId', fileId }          → usar bot.telegram.sendPhoto(chat, fileId, ...)
 *   { tipo: 'url',    url    }          → usar bot.telegram.sendPhoto(chat, url, ...)
 *   { tipo: 'local',  source }          → usar bot.telegram.sendPhoto(chat, { source }, ...)
 *   { tipo: 'none'             }        → sin foto, usar sendMessage
 */
function resolverFotoDomi(nombre) {
  const key   = nombre.toLowerCase().trim();
  const entry = fotosDomiciliarios[key];
  if (!entry) return { tipo: 'none' };

  // Prioridad 1: fileId Telegram (enviado en vivo por el domi)
  if (entry.fileId) return { tipo: 'fileId', fileId: entry.fileId };

  // Prioridad 2: URL o ruta local
  if (entry.urlLocal) {
    const u = entry.urlLocal;
    if (/^https?:\/\//i.test(u)) return { tipo: 'url', url: u };

    // Devolvemos el absPath, NO el stream (el stream se crea en el momento de enviar)
    const absPath = path.resolve(process.cwd(), u);
    if (fs.existsSync(absPath)) return { tipo: 'local', absPath };

    const assetsPath = path.resolve(process.cwd(), 'assets', path.basename(u));
    if (fs.existsSync(assetsPath)) return { tipo: 'local', absPath: assetsPath };

    console.warn(`📷 Foto no encontrada en disco: ${u} (domi: ${nombre})`);
  }

  return { tipo: 'none' };
}

/**
 * Construye el caption del mensaje de "pedido asignado" para el cliente.
 * Diseño tipo tarjeta de perfil con stats del domi.
 */
/**
 * Genera una imagen de tarjeta con foto circular del domi + info básica.
 * Devuelve un Buffer PNG listo para sendPhoto, o null si falla.
 *
 * Layout:  [foto circular 120px a la izq]  Nombre
 *                                           📲 Teléfono
 *                                           ⭐ 4.0  |  N entregas
 */
async function generarTarjetaDomi(absPath, domiciliario, telDomi, entregas, prom) {
  if (!sharp || !absPath || !fs.existsSync(absPath)) return null;

  try {
    // Dimensiones — foto a la izquierda, texto a la derecha
    const FOTO_D = 130;        // diámetro círculo foto
    const W      = 620;        // ancho total
    const H      = 200;        // alto total
    const PAD_H  = 75;         // padding izquierdo — círculo completamente visible
    const PAD_V  = 30;         // padding vertical
    const GAP    = 26;         // espacio foto → texto
    const txtX   = PAD_H + FOTO_D + GAP;

    // 1. Foto circular
    const mask = Buffer.from(
      `<svg width="${FOTO_D}" height="${FOTO_D}">` +
      `<circle cx="${FOTO_D/2}" cy="${FOTO_D/2}" r="${FOTO_D/2}" fill="white"/>` +
      `</svg>`
    );
    // Recortar cuadrado superior-central para mostrar el rostro
    const meta = await sharp(absPath).metadata();
    const srcW = meta.width  || 400;
    const srcH = meta.height || 400;
    const cropSize = Math.min(srcW, srcH);
    const cropLeft = Math.max(0, Math.floor((srcW - cropSize) / 2));
    const cropTop  = 0; // desde arriba para capturar el rostro

    const fotoCirc = await sharp(absPath)
      .extract({ left: cropLeft, top: cropTop, width: cropSize, height: cropSize })
      .resize(FOTO_D, FOTO_D, { fit: 'cover', position: 'centre' })
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();

    // 2. Estrellas unicode rellenas/vacías
    const nEst   = Math.min(5, Math.max(0, Math.round(prom)));
    const estStr = '★'.repeat(nEst) + '☆'.repeat(5 - nEst);
    const telStr = telDomi ? `Contacto : ${telDomi}` : '';
    const entStr = `Entregas : ${entregas}`;

    // 3. Tarjeta con iconos bonitos
    const lineX = txtX - GAP / 2;
    // Escapar caracteres XML en el nombre
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const svg = Buffer.from(
      `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
      // Fondo blanco con borde suave
      `<rect width="${W}" height="${H}" rx="12" ry="12" fill="#ffffff"/>` +
      // Sombra interior sutil
      `<rect x="1" y="1" width="${W-2}" height="${H-2}" rx="11" ry="11" fill="none" stroke="#e8e8e8" stroke-width="1.5"/>` +
      // Línea separadora vertical
      `<line x1="${lineX}" y1="16" x2="${lineX}" y2="${H-16}" stroke="#e0e0e0" stroke-width="1.5"/>` +
      // Fila 1: 🛵 Nombre en negrita
      `<text x="${txtX}" y="50" font-family="Arial,sans-serif" font-size="13" fill="#888888">&#x1F6F5; DOMICILIARIO</text>` +
      `<text x="${txtX}" y="76" font-family="Arial Black,Arial,sans-serif" font-size="22" font-weight="bold" fill="#1a1a1a">${esc(domiciliario)}</text>` +
      // Línea delgada bajo el nombre
      `<line x1="${txtX}" y1="84" x2="${W-20}" y2="84" stroke="#f0f0f0" stroke-width="1"/>` +
      // Fila 2: 📞 Contacto
      (telStr ? `<text x="${txtX}" y="108" font-family="Arial,sans-serif" font-size="17" fill="#555555">&#x1F4DE; ${esc(telStr)}</text>` : '') +
      // Fila 3: ✅ Estado activo
      `<text x="${txtX}" y="${telStr ? 132 : 112}" font-family="Arial,sans-serif" font-size="16" fill="#27ae60">&#x2705; Estado Activo</text>` +
      // Fila 4: ⭐ Calificacion
      `<text x="${txtX}" y="${telStr ? 156 : 138}" font-family="Arial,sans-serif" font-size="17" fill="#555555">&#x1F91D; Calif: <tspan fill="#f5a623" font-size="19" font-weight="bold">${estStr}</tspan></text>` +
      // Fila 5: 📦 Entregas
      `<text x="${txtX}" y="${telStr ? 178 : 162}" font-family="Arial,sans-serif" font-size="17" fill="#555555">&#x1F4E6; ${esc(entStr)}</text>` +
      `</svg>`
    );

    // 4. Componer
    const tarjeta = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([
        { input: svg, top: 0, left: 0 },
        { input: fotoCirc, top: Math.floor((H - FOTO_D) / 2), left: PAD_H },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();

    return tarjeta;
  } catch (e) {
    console.error('generarTarjetaDomi error:', e.message);
    return null;
  }
}

function buildCaptionPedidoTomado(p, domiciliario, telDomi, horaTomo, stats) {
  const esWIL = !p.tienda;
  let productosDetalle = '';
  let totalStr = '';

  // Parsear precioDomicilio correctamente (puede llegar como string "$20.500" o número)
  const parsearNum = v => {
    if (!v && v !== 0) return 0;
    if (typeof v === 'number') return Math.round(v);
    const s = String(v).replace(/\./g, '').replace(/[^0-9\-]/g, '');
    return parseInt(s) || 0;
  };

  const domicilio = parsearNum(p.precioDomicilio);

  if (p.carrito && p.carrito.length > 0) {
    const sub = p.carrito.reduce((a, i) => a + parsearNum(i.subtotal), 0);
    productosDetalle = p.carrito.map(i => {
      const pu = parsearNum(i.precioUnitario);
      const st = parsearNum(i.subtotal);
      if (!esWIL && pu > 0) {
        const subtotalStr = i.cantidad > 1 ? ` = ${COP(st)}` : '';
        return `  • ${i.cantidad}× ${i.descripcion} @ ${COP(pu)}${subtotalStr}`;
      }
      return `  • ${i.cantidad}× ${i.descripcion}`;
    }).join('\n');

    if (!esWIL && sub > 0) {
      const total = sub + domicilio;
      totalStr =
        `\n\n  💵 Productos:  <b>${COP(sub)}</b>` +
        (domicilio > 0 ? `\n  🛵 Domicilio:  <b>${COP(domicilio)}</b>` : '') +
        `\n  💰 TOTAL:      <b>${COP(total)}</b>`;
    } else if (esWIL) {
      totalStr = (domicilio > 0 ? `\n\n  🛵 Domicilio:  <b>${COP(domicilio)}</b>` : '') +
        `\n\n  <i>El domi comprará y te enviará la factura con el total 🧾</i>`;
    }
  } else {
    productosDetalle = `  ${p.productos || '—'}`;
    if (esWIL) {
      totalStr = (domicilio > 0 ? `\n\n  🛵 Domicilio:  <b>${COP(domicilio)}</b>` : '') +
        `\n\n  <i>El domi comprará y te enviará la factura con el total 🧾</i>`;
    }
  }

  const entregas = stats?.entregas ?? 0;
  const prom = stats?.promEstrellas ?? 4.0;
  const estrellas = '⭐'.repeat(Math.round(prom));
  const dirCliente = p.direccionCliente || p.direccion || '—';

  const metodoPago = p.metodoPago === 'TRANSFERENCIA'
    ? '🏦 Transferencia Bancolombia'
    : '💵 Efectivo';

  return (
    `🛵 <b>¡Tu pedido fue asignado!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `  🏪  <b>${p.negocioNombre || '—'}</b>\n` +
    `  📍  ${dirCliente}\n` +
    `  ⏰  Tomado a las <b>${horaTomo}</b>\n` +
    `  💳  Pago: <b>${metodoPago}</b>\n` +
    `\n  📋 <b>Tu pedido:</b>\n${productosDetalle}` +
    totalStr
  );
}

/**
 * Envía al cliente la notificación de "pedido tomado" con foto del domi si existe.
 * Foto grande tipo perfil + datos del domi + stats + resumen del pedido.
 */
async function notificarClientePedidoTomado(bot, clienteId, p, domiciliario, telDomi, horaTomo) {
  if (!clienteId) return;

  // Auto-detectar foto en assets si no está registrada aún
  autoDetectarFotoAssets(domiciliario);

  // Stats del domi desde el pool (acceso vía closure en integrar)
  let stats = { entregas: 0, promEstrellas: 4.0 };
  try {
    const poolRef = _poolRef;
    if (poolRef) {
      // Contar TODAS las entregas del domi en el pool (todos los días acumulados)
      const entregasDomi = Object.values(poolRef).filter(
        x => x.estado === 'FINALIZADO' && x.domiciliario === domiciliario
      );
      const cals = entregasDomi.map(x => Number(x.calificacion)).filter(n => !isNaN(n) && n > 0);
      stats.entregas = entregasDomi.length;
      stats.promEstrellas = cals.length > 0
        ? Math.round((cals.reduce((a, b) => a + b, 0) / cals.length) * 10) / 10
        : 4.0;
    }
  } catch (_) {}

  const caption = buildCaptionPedidoTomado(p, domiciliario, telDomi, horaTomo, stats);
  const foto    = resolverFotoDomi(domiciliario);

  // Intentar generar tarjeta con foto circular si hay foto local
  const absPathFoto = foto.tipo === 'local' ? foto.absPath
                    : foto.tipo === 'fileId' ? null   // fileId: enviar directo
                    : null;

  let tarjetaBuffer = null;
  if (absPathFoto) {
    tarjetaBuffer = await generarTarjetaDomi(
      absPathFoto, domiciliario, telDomi, stats.entregas, stats.promEstrellas
    );
  }

  console.log(`📷 Enviando notif cliente ${clienteId} — foto: ${foto.tipo} — tarjeta: ${tarjetaBuffer ? 'sí' : 'no'}`);

  try {
    if (tarjetaBuffer) {
      // Tarjeta generada con foto circular — enviar como imagen con caption del pedido
      await bot.telegram.sendPhoto(
        clienteId,
        { source: tarjetaBuffer, filename: 'domi.jpg' },
        { caption, parse_mode: 'HTML' }
      );
    } else if (foto.tipo === 'fileId') {
      await bot.telegram.sendPhoto(clienteId, foto.fileId, { caption, parse_mode: 'HTML' });
    } else if (foto.tipo === 'url') {
      await bot.telegram.sendPhoto(clienteId, foto.url, { caption, parse_mode: 'HTML' });
    } else {
      await bot.telegram.sendMessage(clienteId, caption, { parse_mode: 'HTML' });
    }
    console.log(`✅ Notificación "pedido tomado" enviada al cliente ${clienteId}`);
  } catch (e) {
    console.error(`❌ notificarClientePedidoTomado ERROR: ${e.message}`);
    try {
      await bot.telegram.sendMessage(clienteId, caption, { parse_mode: 'HTML' });
    } catch (_) {}
  }
}

/**
 * Envía la tarjeta de perfil del domi a su propio chat (para Mi Perfil).
 * Usa la misma lógica de generación de foto que notificarClientePedidoTomado.
 */
async function enviarTarjetaPerfil(ctx, nombre, tel, entregas, caption, extraKb) {
  const foto = resolverFotoDomi(nombre);
  const absPathFoto = foto.tipo === 'local' ? foto.absPath : null;

  let tarjetaBuffer = null;
  if (absPathFoto) {
    tarjetaBuffer = await generarTarjetaDomi(absPathFoto, nombre, tel, entregas, 4.0).catch(() => null);
  }

  try {
    if (tarjetaBuffer) {
      await ctx.replyWithPhoto(
        { source: tarjetaBuffer, filename: 'perfil.jpg' },
        { caption, parse_mode: 'HTML', ...extraKb }
      );
    } else if (foto.tipo === 'fileId') {
      await ctx.replyWithPhoto(foto.fileId, { caption, parse_mode: 'HTML', ...extraKb });
    } else if (foto.tipo === 'url') {
      await ctx.replyWithPhoto(foto.url, { caption, parse_mode: 'HTML', ...extraKb });
    } else {
      await ctx.reply(caption, { parse_mode: 'HTML', ...extraKb });
    }
  } catch (e) {
    console.error('enviarTarjetaPerfil:', e.message);
    await ctx.reply(caption, { parse_mode: 'HTML', ...extraKb });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. ENCUESTA POST-ENTREGA MEJORADA
// ══════════════════════════════════════════════════════════════════════════════

/** espEncuesta[clienteId] = { pedidoId, estrellas } */
const espEncuesta = {};

/**
 * Envía la encuesta de calificación (paso 1: estrellas).
 */
async function enviarEncuestaPostEntrega(bot, clienteId, pedidoId) {
  try {
    await bot.telegram.sendMessage(clienteId,
      `🛵 <b>¡Tu pedido fue entregado!</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `<i>Gracias por confiar en Domicilios WIL ❤️</i>\n\n` +
      `⭐ <b>¿Cómo calificarías el servicio?</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('1⭐', `encuesta_${pedidoId}_1`),
          Markup.button.callback('2⭐', `encuesta_${pedidoId}_2`),
          Markup.button.callback('3⭐', `encuesta_${pedidoId}_3`),
          Markup.button.callback('4⭐', `encuesta_${pedidoId}_4`),
          Markup.button.callback('5⭐', `encuesta_${pedidoId}_5`),
        ]])
      }
    );
  } catch (e) { console.error('enviarEncuestaPostEntrega:', e.message); }
}

/**
 * Registra los actions de encuesta en el bot (paso 2: categoría → paso 3: gracias).
 */
function registrarEncuesta(bot, guardarCalificacionFn, ADMIN_IDS, CANAL_PEDIDOS_ID, pool) {

  // Paso 1 → 2: recibe estrellas, pregunta categoría
  bot.action(/^encuesta_(.+)_(\d)$/, async ctx => {
    const pedidoId = ctx.match[1];
    const estrellas = parseInt(ctx.match[2]);
    const uid = ctx.from.id;
    await ctx.answerCbQuery('⭐ ¡Gracias!');
    try {
      await ctx.editMessageText(
        `${'⭐'.repeat(estrellas)} <b>${estrellas}/5</b>\n\n` +
        `💬 <b>¿Qué podemos mejorar?</b>\n<i>Elige la categoría más importante:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⚡ Velocidad de entrega',     `mejora_${pedidoId}_velocidad`)],
            [Markup.button.callback('😊 Trato del domiciliario',   `mejora_${pedidoId}_trato`)],
            [Markup.button.callback('📦 Estado del pedido',        `mejora_${pedidoId}_empaque`)],
            [Markup.button.callback('💵 Precio justo',             `mejora_${pedidoId}_precio`)],
            [Markup.button.callback('✅ Todo estuvo perfecto',     `mejora_${pedidoId}_perfecto`)],
          ])
        }
      );
    } catch (_) {}
    espEncuesta[uid] = { pedidoId, estrellas };
  });

  // Paso 2 → 3: recibe categoría, agradece y guarda
  bot.action(/^mejora_(.+)_(velocidad|trato|empaque|precio|perfecto)$/, async ctx => {
    const pedidoId  = ctx.match[1];
    const categoria = ctx.match[2];
    const uid       = ctx.from.id;
    await ctx.answerCbQuery('✅ ¡Registrado!');

    const datos    = espEncuesta[uid] || {};
    const estrellas = datos.estrellas || 5;
    delete espEncuesta[uid];

    const etiquetas  = { velocidad:'⚡ Velocidad', trato:'😊 Trato', empaque:'📦 Estado del pedido', precio:'💵 Precio', perfecto:'✅ Todo perfecto' };
    const respuestas = {
      velocidad: 'Trabajamos para ser cada vez más rápidos 🚀',
      trato:     'Le transmitiremos tu opinión al domiciliario 🛵',
      empaque:   'Cuidaremos más el estado de tu pedido 📦',
      precio:    'Buscamos siempre ofrecerte el mejor valor 💵',
      perfecto:  '¡Eso nos alegra! Tu satisfacción es nuestra motivación 🎉'
    };

    try {
      await ctx.editMessageText(
        `${'⭐'.repeat(estrellas)} <b>${estrellas}/5</b>  ·  ${etiquetas[categoria]}\n\n` +
        `<b>¡Gracias por tu opinión!</b>\n${respuestas[categoria]}\n\n` +
        `<i>Tu feedback nos ayuda a mejorar el servicio. 🛵❤️</i>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      );
    } catch (_) {}

    await guardarCalificacionFn(pedidoId, estrellas, categoria).catch(e => console.error('guardarCalificacion:', e.message));

    const p      = pool[pedidoId];
    const msgCal =
      `${'⭐'.repeat(estrellas)} <b>Calificación — ${pedidoId}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      (p?.domiciliario ? `🛵 ${p.domiciliario}\n` : '') +
      (p?.cliente      ? `👤 ${p.cliente}\n`      : '') +
      `⭐ <b>${estrellas}/5</b>  ·  ${etiquetas[categoria]}`;

    if (CANAL_PEDIDOS_ID) bot.telegram.sendMessage(CANAL_PEDIDOS_ID, msgCal, { parse_mode: 'HTML' }).catch(() => {});
    for (const adminId of ADMIN_IDS) bot.telegram.sendMessage(adminId, msgCal, { parse_mode: 'HTML' }).catch(() => {});
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. ETA EN TIEMPO REAL
// ══════════════════════════════════════════════════════════════════════════════

/** etaActivos[pedidoId] = { clienteId, chatId, msgId, clienteLat, clienteLng, ultimoUpdate, minsAnterior } */
const etaActivos = {};

const VELOCIDAD_KMH  = 30;
const METROS_POR_MIN = (VELOCIDAD_KMH * 1000) / 60;

/**
 * Distancia Haversine en metros.
 */
function haversineMetros(lat1, lng1, lat2, lng2) {
  const R    = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtMins(mins) {
  if (mins <= 1) return 'Ahora 🟢';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins/60)}h ${mins%60}min`;
}

/**
 * Activa el tracker ETA: envía mensaje inicial al cliente.
 */
async function activarETA(bot, clienteId, pedidoId, domiLat, domiLng, clienteLat, clienteLng) {
  if (!clienteId || !clienteLat || !clienteLng) return;

  const metros  = haversineMetros(domiLat || 0, domiLng || 0, clienteLat, clienteLng);
  const distKm  = (metros * 1.35 / 1000).toFixed(1);
  const mins    = Math.max(2, Math.round((metros * 1.35) / METROS_POR_MIN));

  const texto =
    `🛵 <b>Tu domiciliario está en camino</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⏱ Tiempo estimado: <b>${fmtMins(mins)}</b>\n` +
    `📍 Distancia aprox: <b>${distKm} km</b>\n` +
    `<i>Se actualiza automáticamente con el GPS del domiciliario</i>`;

  try {
    const sent = await bot.telegram.sendMessage(clienteId, texto, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📍 Ver punto de entrega', `eta_mapa_${pedidoId}`)]])
    });
    etaActivos[pedidoId] = {
      clienteId, chatId: clienteId,
      msgId:       sent.message_id,
      clienteLat,  clienteLng,
      ultimoUpdate: Date.now(),
      minsAnterior: mins
    };
    console.log(`📡 ETA activado para pedido ${pedidoId} — ${mins} min`);
  } catch (e) { console.error('activarETA:', e.message); }
}

/**
 * Actualiza el mensaje ETA cuando el domi mueve su GPS.
 * Solo edita si cambió ≥ 1 minuto la estimación (throttle 30 seg).
 */
async function actualizarETA(bot, pedidoId, domiLat, domiLng) {
  const eta = etaActivos[pedidoId];
  if (!eta) return;

  const ahora = Date.now();
  if (ahora - eta.ultimoUpdate < 30000) return;

  const metros = haversineMetros(domiLat, domiLng, eta.clienteLat, eta.clienteLng);
  const distKm = (metros * 1.35 / 1000).toFixed(1);
  const mins   = Math.max(0, Math.round((metros * 1.35) / METROS_POR_MIN));

  if (Math.abs(mins - eta.minsAnterior) < 1) return;

  const texto =
    `🛵 <b>Tu domiciliario está en camino</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⏱ Tiempo estimado: <b>${fmtMins(mins)}</b>\n` +
    `📍 Distancia aprox: <b>${distKm} km</b>\n` +
    `🕐 Actualizado: <i>${ahoraBog().format('hh:mm A')}</i>`;

  try {
    await bot.telegram.editMessageText(eta.chatId, eta.msgId, null, texto, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('📍 Ver punto de entrega', `eta_mapa_${pedidoId}`)]])
    });
    eta.ultimoUpdate  = ahora;
    eta.minsAnterior  = mins;
    console.log(`📡 ETA actualizado ${pedidoId}: ${mins} min`);
  } catch (e) {
    if (e.message?.includes('message to edit not found') || e.message?.includes('message is not modified')) {
      delete etaActivos[pedidoId];
    }
  }
}

/**
 * Desactiva el tracker ETA al entregar el pedido.
 */
async function desactivarETA(bot, pedidoId) {
  const eta = etaActivos[pedidoId];
  if (!eta) return;
  try {
    await bot.telegram.editMessageText(eta.chatId, eta.msgId, null,
      `✅ <b>¡Tu domiciliario llegó!</b>\n<i>Pedido entregado exitosamente 🛵❤️</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
  } catch (_) {}
  delete etaActivos[pedidoId];
}

/**
 * Registra el action del botón "Ver punto de entrega" del ETA.
 */
function registrarETA(bot) {
  bot.action(/^eta_mapa_(.+)$/, async ctx => {
    const pedidoId = ctx.match[1];
    await ctx.answerCbQuery();
    const eta = etaActivos[pedidoId];
    if (!eta) return ctx.answerCbQuery('Pedido ya entregado', true);
    const gmapsUrl = `https://www.google.com/maps?q=${eta.clienteLat},${eta.clienteLng}`;
    return ctx.reply(`📍 <b>Tu punto de entrega</b>\n${gmapsUrl}`, { parse_mode: 'HTML' });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. TURNO DEL DOMICILIARIO
// ══════════════════════════════════════════════════════════════════════════════

/** turnos[uid] = 'manana' | 'tarde' | 'noche' | 'completo' */
const turnos = {};

const TURNOS = {
  manana:   { label: '☀️ Mañana',    inicio: 6,  fin: 13 },
  tarde:    { label: '🌤 Tarde',     inicio: 13, fin: 20 },
  noche:    { label: '🌙 Noche',    inicio: 20, fin: 24 },
  completo: { label: '🔁 Completo', inicio: 0,  fin: 24 },
};

/**
 * Devuelve true si el domi debe recibir alertas ahora según su turno.
 */
function estaEnTurno(uid) {
  const turno = turnos[uid];
  if (!turno || turno === 'completo') return true;
  const h = ahoraBog().hours();
  const { inicio, fin } = TURNOS[turno] || TURNOS.completo;
  return h >= inicio && h < fin;
}

function setTurno(uid, turno) {
  if (TURNOS[turno]) { turnos[uid] = turno; return true; }
  return false;
}

/**
 * Inline keyboard para elegir turno.
 */
function keyboardTurno() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('☀️ Mañana  (6am – 1pm)',  'turno_manana')],
    [Markup.button.callback('🌤 Tarde   (1pm – 8pm)',  'turno_tarde')],
    [Markup.button.callback('🌙 Noche   (8pm – 12am)', 'turno_noche')],
    [Markup.button.callback('🔁 Turno completo',       'turno_completo')],
  ]);
}

/**
 * Registra los actions de turno en el bot.
 */
function registrarTurnos(bot, drivers) {
  bot.action(/^turno_(manana|tarde|noche|completo)$/, async ctx => {
    const uid   = ctx.from.id;
    const turno = ctx.match[1];
    await ctx.answerCbQuery();
    if (!drivers[uid]) return ctx.reply('❌ Debes iniciar sesión primero.');
    setTurno(uid, turno);
    const t = TURNOS[turno];
    try {
      await ctx.editMessageText(
        `✅ <b>Turno configurado: ${t.label}</b>\n\n` +
        `🕐 Recibirás alertas entre <b>${t.inicio}:00 y ${t.fin}:00</b>\n\n` +
        `<i>Puedes cambiarlo en cualquier momento escribiendo "mi turno".</i>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      );
    } catch (_) {}
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// INTEGRACIÓN PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════
//
// USO en wilBot.js (agrega estas líneas al final del archivo, antes del module.exports):
//
//   const features = require('./features');   // o la ruta que corresponda
//
//   features.integrar(bot, {
//     pool,                           // objeto pool de wilBot
//     drivers,                        // objeto drivers de wilBot
//     ADMIN_IDS,
//     getPedidos,                     // fn del sheet
//     guardarCalificacion,            // fn del sheet
//     getSheetRows: async (rango) => {// wrapper de tu google sheets
//       const { google } = require('googleapis');
//       const auth   = new google.auth.GoogleAuth({ keyFile:'./credentials.json', scopes:['...spreadsheets'] });
//       const client = await auth.getClient();
//       const sheets = google.sheets({ version:'v4', auth: client });
//       const res    = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: rango });
//       return res.data.values || [];
//     },
//     registrarPedido,                // fn del sheet (para repetir pedidos)
//   });
//
//   // También en manejarAutenticacion(), después de cargar el domi del sheet,
//   // agrega una línea para cargar la foto de la columna F:
//   //   features.guardarFotoDomiUrl(r.nombre, sheetEntry?.fotoUrl || '');
//   //   (asegúrate de que getSheetDrivers mapee r[5] como fotoUrl)
//
// ══════════════════════════════════════════════════════════════════════════════

function integrar(bot, opts) {
  const {
    pool, drivers, ADMIN_IDS,
    getPedidos, guardarCalificacion,
    getSheetRows, registrarPedido,
    activarPedidoFn
  } = opts;

  const CANAL = process.env.CANAL_PEDIDOS_ID;

  // ── Encuesta mejorada ──────────────────────────────────────────────────────
  registrarEncuesta(bot, guardarCalificacion, ADMIN_IDS, CANAL, pool);

  // ── ETA botón mapa ─────────────────────────────────────────────────────────
  registrarETA(bot);

  // ── Turnos ─────────────────────────────────────────────────────────────────
  registrarTurnos(bot, drivers);

  // ── Foto del domi: caption "mi foto" o "foto perfil" ──────────────────────
  //    NOTA: este handler usa next() para no bloquear el handler photo de wilBot
  // IMPORTANTE: este handler solo captura fotos con caption "mi foto" / "foto perfil"
  // Para todo lo demás llama next() para que wilBot procese (facturas, comprobantes, etc.)
  bot.on('photo', async (ctx, next) => {
    const uid     = ctx.from.id;
    const caption = (ctx.message.caption || '').toLowerCase().trim();
    if (drivers[uid] && (caption === 'mi foto' || caption === 'foto perfil')) {
      const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      guardarFotoDomi(drivers[uid].nombre, fileId);
      return ctx.reply(
        `✅ <b>¡Foto guardada!</b>\nLos clientes verán tu foto al asignarte un pedido. 📷`,
        { parse_mode: 'HTML' }
      );
    }
    // No es foto de perfil — dejar que wilBot maneje (factura, comprobante, etc.)
    return next();
  });

  // ── Historial del cliente ──────────────────────────────────────────────────
  bot.hears(/mis pedidos|historial|mis ó?rdenes/i, async ctx => {
    const uid = ctx.from.id;
    if (drivers[uid]) return; // domi usa su propio panel
    const msg  = await buildHistorialCliente(uid, pool, getPedidos);
    const enPool = Object.values(pool)
      .filter(p => p.clienteId === uid && (p.estado === 'FINALIZADO' || p.estado === 'ENTREGADO'))
      .slice(0, 3);
    return ctx.reply(msg, { parse_mode: 'HTML', ...botonesHistorial(enPool) });
  });

  // ── Repetir pedido ─────────────────────────────────────────────────────────
  bot.action(/^repetir_(.+)$/, async ctx => {
    const pedidoId = ctx.match[1];
    const uid      = ctx.from.id;
    await ctx.answerCbQuery();
    const po = pool[pedidoId];
    if (!po?.carrito?.length) return ctx.reply('❌ No se pudo recuperar ese pedido. Haz uno nuevo 🛵');
    const prods = po.carrito.map(i => `• ${i.cantidad}× ${i.descripcion}`).join('\n');
    return ctx.reply(
      `🔄 <b>Repetir pedido ${pedidoId}</b>\n━━━━━━━━━━━━━━━━━━\n${prods}\n━━━━━━━━━━━━━━━━━━\n\n¿Confirmas?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Sí, repetir',  `confirmar_repetir_${pedidoId}`)],
          [Markup.button.callback('❌ Cancelar',     'menu_pedido')],
        ])
      }
    );
  });

  bot.action(/^confirmar_repetir_(.+)$/, async ctx => {
    const pedidoId = ctx.match[1];
    const uid      = ctx.from.id;
    await ctx.answerCbQuery('🔄 Procesando...');
    const p = pool[pedidoId];
    if (!p) return ctx.reply('❌ Pedido no encontrado. Haz uno nuevo.');
    try { await ctx.editMessageText('⏳ <b>Registrando tu pedido...</b>', { parse_mode:'HTML', reply_markup:{inline_keyboard:[]} }); } catch (_) {}
    if (registrarPedido) {
      try {
        const nuevoId = await registrarPedido({
          nombre: p.cliente, telefono: p.telefono, metodoPago: p.metodoPago || 'EFECTIVO',
          imagenFileId: '', carrito: p.carrito,
          negocioNombre: p.negocioNombre, tienda: p.tienda,
          direccion: p.direccionCliente || p.direccion,
          precioDomicilio: p.precioDomicilio || 0,
          totalFinal: 0, presupuesto: null
        });
        pool[nuevoId] = { ...p, id: nuevoId, estado: 'PENDIENTE', clienteId: uid, hora: ahoraBog().format('hh:mm A'), createdAt: Date.now() };
        return ctx.reply(`✅ <b>¡Pedido repetido!</b>\n🆔 <b>${nuevoId}</b>\n\n<i>Un domiciliario lo tomará pronto 🛵</i>`, { parse_mode: 'HTML' });
      } catch (e) {
        return ctx.reply(`❌ Error al registrar: ${e.message}`);
      }
    }
    return ctx.reply('❌ Función de registro no disponible. Haz un nuevo pedido.');
  });

  // ── Pedidos programados: el cliente escribe "programar" ───────────────────
  bot.hears(/programar|agendar|para mañana|para el/i, async ctx => {
    if (drivers[ctx.from.id]) return;
    return ctx.reply(
      `⏰ <b>Pedido Programado</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
      `Haz tu pedido normalmente con el menú 🛵,\n` +
      `y al confirmar elige <b>"⏰ Programar para más tarde"</b>.\n\n` +
      `<i>Disponible para hoy o mañana.</i>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🛵 Hacer pedido ahora', 'menu_pedido')]]) }
    );
  });

  // ── Turno: el domi escribe "mi turno" ─────────────────────────────────────
  bot.hears(/mi turno|cambiar turno/i, async ctx => {
    const uid = ctx.from.id;
    if (!drivers[uid]) return;
    const label = turnos[uid] ? TURNOS[turnos[uid]]?.label : 'Sin definir';
    return ctx.reply(
      `🕐 <b>Configurar turno</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `Turno actual: <b>${label}</b>\n\n` +
      `Solo recibirás alertas durante tu turno.\nElige el horario de hoy:`,
      { parse_mode: 'HTML', ...keyboardTurno() }
    );
  });

  // ── Ver todos los aliados ─────────────────────────────────────────────────
  bot.action('ver_aliados', async ctx => {
    await ctx.answerCbQuery();
    const aliados = getSheetRows ? await getAliados(getSheetRows) : [];
    if (!aliados.length) return ctx.reply('ℹ️ No hay aliados adicionales configurados todavía.');
    let msg = `🤝 <b>Aliados WIL</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
    aliados.forEach(a => {
      msg += `${a.emoji} <b>${a.nombre}</b>\n`;
      if (a.descripcion) msg += `   <i>${a.descripcion}</i>\n`;
      msg += '\n';
    });
    return ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // ── Cron pedidos programados ───────────────────────────────────────────────
  if (typeof activarPedidoFn === 'function') {
    iniciarCronProgramados(activarPedidoFn);
  }

  console.log('✅ features.js integrado: pedidos programados | historial | aliados | foto domi | encuesta mejorada | ETA | turnos');
}

// ══════════════════════════════════════════════════════════════════════════════
// INSTRUCCIONES PARA getSheetDrivers() EN wilBot.js
// ══════════════════════════════════════════════════════════════════════════════
//
// En wilBot.js, dentro de getSheetDrivers(), agrega el campo fotoUrl (col F)
// y llama a features.guardarFotoDomiUrl() para cada domi cargado:
//
//   _sheetCache = (res.data.values || []).slice(1).filter(r => r[1]).map(r => ({
//     telegramId: (r[0] || '').toString().trim(),
//     nombre:     (r[1] || '').toString().trim(),
//     telefono:   (r[4] || '').toString().trim(),
//     fotoUrl:    (r[5] || '').toString().trim(),   // ← NUEVA columna F
//   }));
//
//   // Cargar fotos en el módulo features
//   const features = require('./features');        // ajusta la ruta
//   _sheetCache.forEach(d => {
//     if (d.fotoUrl) features.guardarFotoDomiUrl(d.nombre, d.fotoUrl);
//   });
//
// ESTRUCTURA COLUMNA F (hoja Domiciliarios):
//   • Ruta relativa al proyecto:  assets/juan.jpg
//   • URL directa https:          https://example.com/foto.jpg
//   • Vacío:                      sin foto → el bot usa texto plano
//
// PARA LA NOTIFICACIÓN AL CLIENTE al tomar pedido, en wilBot.js reemplaza
// el bloque "Notificar al cliente: domi asignado" dentro de bot.action(/^tomar_/)
// y bot.action(/^asignar_/) por una llamada a features.notificarClientePedidoTomado():
//
//   if (p.clienteId) {
//     const telDomi = drivers[uid]?.telefono || '';
//     await features.notificarClientePedidoTomado(bot, p.clienteId, p, domiciliario.nombre, telDomi, p.horaTomo);
//   }
//
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════
module.exports = {
  // Pedidos programados
  agendarPedido,
  iniciarCronProgramados,
  getPedidosProgramadosCliente,
  cancelarPedidoProgramado,
  pedidosProgramados,

  // Historial
  buildHistorialCliente,
  botonesHistorial,

  // Aliados dinámicos
  getAliados,
  buildMenuPedido,
  resolverNegocio,
  invalidarCacheAliados,

  // Foto domiciliario
  guardarFotoDomi,
  guardarFotoDomiUrl,
  autoDetectarFotoAssets,
  resolverFotoDomi,
  generarTarjetaDomi,
  notificarClientePedidoTomado,
  enviarTarjetaPerfil,

  // Encuesta mejorada
  enviarEncuestaPostEntrega,
  registrarEncuesta,

  // ETA
  activarETA,
  actualizarETA,
  desactivarETA,
  haversineMetros,

  // Turnos
  estaEnTurno,
  setTurno,
  keyboardTurno,
  registrarTurnos,
  turnos,

  // Integración completa
  integrar,
};