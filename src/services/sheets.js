// ══════════════════════════════════════════════════════════════════════════════
// sheets.js — Google Sheets backend para Domicilios WIL
//
// Hoja coordenadas: A=BARRIO B=TARIFA C=PAQ_PEQUEÑO D=PAQ_MEDIANO
//                   E=PAQ_GRANDE F=DIRECCION G=ZONA H=LAT I=LNG
//
// Hoja Pedidos: A–S igual que antes + T=LAT_CLIENTE  U=LNG_CLIENTE
// ══════════════════════════════════════════════════════════════════════════════
const { google } = require('googleapis');
const moment     = require('moment-timezone');

const auth = new google.auth.GoogleAuth({
  keyFile: './credentials.json',
  scopes:  ['https://www.googleapis.com/auth/spreadsheets']
});

const SID = () => process.env.GOOGLE_SHEETS_ID;
let _listo = false;

async function getSheets() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

const pn = v => {
  if (!v && v !== 0) return 0;
  const raw = v.toString().trim();
  if (!isNaN(raw) && raw !== '') return parseFloat(raw) || 0;
  const s = raw.replace(/\$/g,'').replace(/\s/g,'').replace(/\./g,'').replace(/,/g,'.');
  return parseFloat(s) || 0;
};

const fmt = n => {
  if (!n && n !== 0) return '0';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};

const HEADERS_PEDIDOS = [
  'ID_PEDIDO','NOMBRE_CLIENTE','TELEFONO','METODO_PAGO','ESTADO',
  'IMAGEN_TRANSFERENCIA','PRODUCTOS','MARCA','CANTIDAD','V/U','V/TOTAL',
  'DIRECCION','HORA','FECHA','TOTAL','NOMBRE_DOMICILIARIO',
  'HORA_TOMO_PEDIDO','HORA_ENTREGO','CALIFICACION',
  'LAT_CLIENTE','LNG_CLIENTE'   // T, U — ubicación GPS en tiempo real del cliente
];

const HEADERS_COORDENADAS    = ['BARRIO','TARIFA','PAQ_PEQUEÑO','PAQ_MEDIANO','PAQ_GRANDE','DIRECCION','ZONA','LAT','LNG'];
const HEADERS_POSTULACIONES  = ['FECHA_POSTULACION','NOMBRE_COMPLETO','CEDULA','TELEFONO','LINK_LICENCIA','LINK_TECNOMECANICA','LINK_SEGURO','TELEGRAM_ID','ESTADO'];
const HEADERS_ADMINS         = ['ID_TELEGRAM','NOMBRE','CLAVE','ACTIVO'];

const ESTRUCTURA = {
  Pedidos:              HEADERS_PEDIDOS,
  Domiciliarios:        ['ID_TELEGRAM','NOMBRE','CLAVE','ACTIVO'],
  CATALOGO_WIL:         ['CATEGORIA','PRODUCTO','PRECIO','DISPONIBLE'],
  coordenadas:          HEADERS_COORDENADAS,
  domiciliarios_nuevos: HEADERS_POSTULACIONES,
  Admins:               HEADERS_ADMINS,
};

async function inicializar() {
  if (_listo) return;
  try {
    const sheets  = await getSheets();
    const meta    = await sheets.spreadsheets.get({ spreadsheetId: SID() });
    const existen = new Set(meta.data.sheets.map(h => h.properties.title));
    const nuevas  = Object.keys(ESTRUCTURA).filter(n => !existen.has(n));
    if (nuevas.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SID(),
        resource: { requests: nuevas.map(title => ({ addSheet: { properties: { title } } })) }
      });
    }
    for (const [hoja, headers] of Object.entries(ESTRUCTURA)) {
      const chk = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `${hoja}!A1` });
      if (!chk.data.values?.[0]?.[0]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SID(), range: `${hoja}!A1`,
          valueInputOption: 'USER_ENTERED', resource: { values: [headers] }
        });
      }
    }
    const catChk = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'CATALOGO_WIL!A2:A3' });
    if (!catChk.data.values?.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SID(), range: 'CATALOGO_WIL!A:D',
        valueInputOption: 'USER_ENTERED', resource: { values: [
          ['🥛 Mercado','Leche Colanta 1L','$3.200','SI'],
          ['🥛 Mercado','Arroz Diana 500g','$3.500','SI'],
        ]}
      });
    }
    _listo = true;
  } catch(e) {
    _listo = false;
    console.error('❌ ERROR inicializar Sheets:', e.message);
    throw e;
  }
}

async function getCategorias() {
  await inicializar();
  const sheets = await getSheets();
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'CATALOGO_WIL!A:D' });
  const rows   = (res.data.values||[]).slice(1).filter(r => r[0] && (r[3]||'').toUpperCase() !== 'NO');
  return [...new Set(rows.map(r => r[0]))];
}

async function getProductosPorCategoria(categoria) {
  await inicializar();
  const sheets = await getSheets();
  const res    = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'CATALOGO_WIL!A:D' });
  const rows   = (res.data.values||[]).slice(1);
  return rows.filter(r => r[0] === categoria && (r[3]||'').toUpperCase() !== 'NO')
             .map(r => ({ categoria: r[0], producto: r[1], precio: pn(r[2]) }));
}

async function buscarProductos(termino, tienda) {
  await inicializar();
  const sheets = await getSheets();
  const hoja   = tienda === 'CENTRAL' ? 'STOCK_DROGUERIA_CENTRAL' : 'STOCK_DROGUERIA_EXPERTOS';
  try {
    const res  = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `${hoja}!H:M` });
    const rows = res.data.values || [];
    const q    = termino.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const out  = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r?.[0]) continue;
      const desc = r[0].toString().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      if (!desc.includes(q)) continue;
      const precioUnidad   = pn(r[4]);
      const precioUnitario = pn(r[5]);
      const precioMostrar  = precioUnitario > 0 ? precioUnitario : (precioUnidad > 0 ? precioUnidad : 0);
      if (precioMostrar === 0) continue;
      out.push({
        descripcion: r[0]||'', laboratorio: r[1]||'', unidad: r[3]||'',
        precioUnidad, precioUnitario: precioMostrar,
        tienePrecioVarios: precioUnitario > 0 && precioUnidad > 0 && precioUnitario !== precioUnidad
      });
      if (out.length >= 6) break;
    }
    return out;
  } catch(e) {
    console.error('buscarProductos:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COORDENADAS
// ══════════════════════════════════════════════════════════════════════════════
const norm = s => (s||'')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();

function _parsearFila(fila, numFila) {
  const pt = v => {
    const n = parseInt((v||'').toString().replace(/[^0-9]/g,''));
    return isNaN(n) || n === 0 ? null : n;
  };
  const pf = v => {
    const n = parseFloat((v||'').toString().replace(',','.'));
    return isNaN(n) ? null : n;
  };
  return {
    barrio:    (fila[0]||'').toString().trim(),
    tarifa:    pt(fila[1]),
    paqPeq:   pt(fila[2]),
    paqMed:   pt(fila[3]),
    paqGran:  pt(fila[4]),
    direccion: (fila[5]||'').toString().trim(),
    nota:      (fila[5]||'').toString().trim(),
    zona:      (fila[6]||'').toString().trim(),
    lat:       pf(fila[7]),
    lng:       pf(fila[8]),
    fila:      numFila
  };
}

async function buscarBarrioEnSheet(texto) {
  try {
    const sheets = await getSheets();
    const res    = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'coordenadas!A:I' });
    const filas  = res.data.values || [];
    if (filas.length < 2) return null;

    const query = norm(texto);

    const MUNICIPIOS_EXTERNOS = [
      'bello','medellin','envigado','itagui','sabaneta',
      'la estrella','caldas','girardota','barbosa','rionegro','guarne'
    ];
    const municipioEnQuery = MUNICIPIOS_EXTERNOS.find(m => query.includes(norm(m)));

    let mejorMatch = null, mejorScore = 0;

    for (let i = 1; i < filas.length; i++) {
      const fila   = filas[i];
      const barrio = (fila[0]||'').toString().trim();
      if (!barrio) continue;

      if (municipioEnQuery) {
        const dirFila  = norm(fila[5]||'');
        const zonaFila = norm(fila[6]||'');
        if (!dirFila.includes(municipioEnQuery) && !zonaFila.includes(municipioEnQuery)) continue;
      }

      const bn = norm(barrio);
      let score = 0;

      if (bn === query) {
        score = 100;
      } else if (query.includes(bn) && bn.length >= 4) {
        score = 90;
      } else if (bn.includes(query) && query.length >= 4) {
        score = 75;
      } else {
        const palabrasBarrio = bn.split(' ').filter(p => p.length >= 4);
        const palabrasQuery  = query.split(' ').filter(p => p.length >= 4);
        const coinciden = palabrasBarrio.filter(pb =>
          palabrasQuery.some(pq => pq === pb || pq.includes(pb) || pb.includes(pq))
        );
        if (coinciden.length > 0) {
          score = Math.round(40 + (coinciden.length / Math.max(palabrasBarrio.length, 1)) * 40);
        }
      }

      if (score > mejorScore) {
        mejorScore = score;
        mejorMatch = _parsearFila(fila, i+1);
      }
    }

    if (mejorMatch && mejorScore >= 50 && (mejorMatch.tarifa !== null || mejorMatch.direccion)) {
      console.log(`📋 Sheet match: "${mejorMatch.barrio}" score=${mejorScore}`);
      return mejorMatch;
    }
    return null;
  } catch(e) {
    console.error('buscarBarrioEnSheet ERROR:', e.message);
    return null;
  }
}

const buscarBarrioCopacabana = buscarBarrioEnSheet;

async function guardarBarrioEnSheet(datos) {
  try {
    const sheets = await getSheets();
    const existe = await buscarBarrioEnSheet(datos.barrio);
    if (existe) {
      const upd = [];
      if (datos.paqPeq  && !existe.paqPeq)  upd.push({ range: `coordenadas!C${existe.fila}`, values: [[datos.paqPeq]]  });
      if (datos.paqMed  && !existe.paqMed)  upd.push({ range: `coordenadas!D${existe.fila}`, values: [[datos.paqMed]]  });
      if (datos.paqGran && !existe.paqGran) upd.push({ range: `coordenadas!E${existe.fila}`, values: [[datos.paqGran]] });
      const dirNueva = datos.direccion || datos.nota || '';
      if (dirNueva && !existe.direccion) upd.push({ range: `coordenadas!F${existe.fila}`, values: [[dirNueva]] });
      if (datos.zona && !existe.zona)    upd.push({ range: `coordenadas!G${existe.fila}`, values: [[datos.zona]]    });
      if (datos.lat && datos.lng) {
        upd.push({ range: `coordenadas!H${existe.fila}`, values: [[datos.lat]] });
        upd.push({ range: `coordenadas!I${existe.fila}`, values: [[datos.lng]] });
        console.log(`💾 Cache coords: "${existe.barrio}" → ${datos.lat}, ${datos.lng}`);
      }
      if (upd.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: SID(),
          resource: { valueInputOption: 'RAW', data: upd }
        });
      }
      return;
    }
    const direccion = datos.direccion || datos.nota || '';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SID(), range: 'coordenadas!A:I',
      valueInputOption: 'RAW',
      resource: { values: [[
        datos.barrio  || '',
        datos.tarifa  || '',
        datos.paqPeq  || '',
        datos.paqMed  || '',
        datos.paqGran || '',
        direccion,
        datos.zona    || '',
        datos.lat     || '',
        datos.lng     || ''
      ]] }
    });
    console.log(`💾 Nuevo barrio en sheet: "${datos.barrio}" lat=${datos.lat||'—'} lng=${datos.lng||'—'}`);
  } catch(e) {
    console.error('guardarBarrioEnSheet ERROR:', e.message);
  }
}

async function getTodosBarriosSheet() {
  try {
    const sheets = await getSheets();
    const res    = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'coordenadas!A:G' });
    const filas  = (res.data.values||[]).slice(1);
    return filas.filter(f => f[0]).map((f,i) => _parsearFila(f, i+2));
  } catch(e) {
    console.error('getTodosBarriosSheet ERROR:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// NUEVA — guardar lat/lng del cliente en el pedido (cols T y U)
// Se llama cuando el cliente comparte ubicación en tiempo real
// ══════════════════════════════════════════════════════════════════════════════
async function actualizarUbicacionPedido(pedidoId, lat, lng) {
  try {
    const sheets = await getSheets();
    const fila   = await buscarFila(sheets, pedidoId);
    if (!fila) { console.error(`actualizarUbicacionPedido: pedido ${pedidoId} no encontrado`); return false; }
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SID(),
      resource: { valueInputOption: 'RAW', data: [
        { range: `Pedidos!T${fila}`, values: [[lat]] },
        { range: `Pedidos!U${fila}`, values: [[lng]] },
      ]}
    });
    console.log(`📍 Ubicación cliente guardada: pedido ${pedidoId} → ${lat}, ${lng}`);
    return true;
  } catch(e) {
    console.error('actualizarUbicacionPedido ERROR:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// POSTULACIONES
// ══════════════════════════════════════════════════════════════════════════════
async function registrarPostulante({ nombre, cedula, telefono, fotoLicencia, fotoTecnomecanica, fotoSeguro, telegramId, botToken }) {
  await inicializar();
  const sheets = await getSheets();
  const fecha  = moment().tz('America/Bogota').format('DD/MM/YYYY hh:mm A');
  const https  = require('https');

  async function getFileUrl(fileId) {
    try {
      const data = await new Promise((resolve, reject) => {
        https.get(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, res => {
          let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      if (data.ok) return `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
    } catch(_) {}
    return fileId;
  }

  const [urlLicencia, urlTecno, urlSeguro] = await Promise.all([
    getFileUrl(fotoLicencia), getFileUrl(fotoTecnomecanica), getFileUrl(fotoSeguro)
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SID(), range: 'domiciliarios_nuevos!A:I',
    valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
    resource: { values: [[fecha, nombre||'', cedula, telefono, urlLicencia, urlTecno, urlSeguro, String(telegramId), 'PENDIENTE']] }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// PEDIDOS
// ══════════════════════════════════════════════════════════════════════════════
async function registrarPedido(p) {
  await inicializar();
  const sheets = await getSheets();
  const ahora  = moment().tz('America/Bogota');
  const id     = `WIL${Date.now()}`;
  const filas  = p.carrito.map((item, i) => [
    i===0 ? id                         : '',
    i===0 ? p.nombre                   : '',
    i===0 ? p.telefono                 : '',
    i===0 ? p.metodoPago               : '',
    i===0 ? 'PENDIENTE'                : '',
    i===0 ? (p.imagenFileId||'')       : '',
    item.descripcion,
    i===0 ? p.negocioNombre            : '',
    item.cantidad,
    item.precioUnitario,
    item.subtotal,
    i===0 ? p.direccion                : '',
    i===0 ? ahora.format('hh:mm A')    : '',
    i===0 ? ahora.format('DD/MM/YYYY') : '',
    i===0 ? p.totalFinal               : '',
    '', '', '',
    '',   // S — Calificación
    '',   // T — LAT_CLIENTE (se llena después con actualizarUbicacionPedido)
    '',   // U — LNG_CLIENTE
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SID(), range: 'Pedidos!A:U',
    valueInputOption: 'USER_ENTERED', resource: { values: filas }
  });
  return id;
}

async function guardarCalificacion(pedidoId, estrellas) {
  try {
    const sheets = await getSheets();
    const fila   = await buscarFila(sheets, pedidoId);
    if (!fila) return false;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SID(), range: `Pedidos!S${fila}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[`${'⭐'.repeat(estrellas)} (${estrellas}/5)`]] }
    });
    return true;
  } catch(e) {
    console.error('guardarCalificacion:', e.message);
    return false;
  }
}

async function getPedidos(estado = 'ALL') {
  await inicializar();
  const sheets = await getSheets();
  let res;
  try { res = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'Pedidos!A:U' }); }
  catch(e) { console.error('getPedidos error:', e.message); return []; }
  const rows = (res.data.values||[]).slice(1);
  return rows.filter(r => {
    if (!r[0]) return false;
    if (estado === 'ALL') return true;
    return (r[4]||'').toString().trim().toUpperCase() === estado.trim().toUpperCase();
  }).map(r => ({
    id:              (r[0] ||'').toString().trim(),
    cliente:         (r[1] ||'').toString().trim(),
    telefono:        (r[2] ||'').toString().trim(),
    metodoPago:      (r[3] ||'').toString().trim(),
    estado:          (r[4] ||'').toString().trim().toUpperCase(),
    productos:       (r[6] ||'').toString().trim(),
    negocio:         (r[7] ||'').toString().trim(),
    direccion:       (r[11]||'').toString().trim(),
    barrio:          (r[11]||'').toString().trim(),
    hora:            (r[12]||'').toString().trim(),
    fecha:           (r[13]||'').toString().trim(),
    total:           pn(r[14]),
    precioDomicilio: 0,
    domiciliario:    (r[15]||'').toString().trim(),
    horaTomo:        (r[16]||'').toString().trim(),
    horaEntrego:     (r[17]||'').toString().trim(),
    calificacion:    (r[18]||'').toString().trim(),
    latCliente:      pn(r[19]) || null,
    lngCliente:      pn(r[20]) || null,
  }));
}

async function contarPedidosPorEstado() {
  await inicializar();
  const sheets = await getSheets();
  let res;
  try { res = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'Pedidos!A:N' }); }
  catch(e) { console.error('contarPedidosPorEstado error:', e.message); throw e; }
  const rows = (res.data.values||[]).slice(1);
  const hoy  = moment().tz('America/Bogota').format('DD/MM/YYYY');
  let pendientes = 0, enProceso = 0, finalizados = 0;
  for (const r of rows) {
    if (!r[0]) continue;
    const e = (r[4]||'').toString().trim().toUpperCase();
    const f = (r[13]||'').toString().trim();
    if (e === 'PENDIENTE')               pendientes++;
    if (e === 'EN_PROCESO')              enProceso++;
    if (e === 'FINALIZADO' && f === hoy) finalizados++;
  }
  return { pendientes, enProceso, finalizados };
}

async function pendientesSinAtender(mins = 10) {
  const hoy   = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const ahora = moment().tz('America/Bogota');
  const ps    = await getPedidos('PENDIENTE');
  return ps.filter(p => {
    if (p.fecha !== hoy || !p.hora) return false;
    const t = moment.tz(`${hoy} ${p.hora}`, 'DD/MM/YYYY hh:mm A', 'America/Bogota');
    return ahora.diff(t, 'minutes') >= mins;
  });
}

async function buscarFila(sheets, id) {
  const r   = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'Pedidos!A:A' });
  const idx = (r.data.values||[]).findIndex(f => (f[0]||'').toString().trim() === id.toString().trim());
  return idx === -1 ? null : idx + 1;
}

async function asignarDomiciliario(id, nombre) {
  const sheets = await getSheets();
  const fila   = await buscarFila(sheets, id);
  if (!fila) return null;
  const hora = moment().tz('America/Bogota').format('hh:mm A');
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SID(),
    resource: { valueInputOption: 'USER_ENTERED', data: [
      { range: `Pedidos!E${fila}`, values: [['EN_PROCESO']] },
      { range: `Pedidos!P${fila}`, values: [[nombre]] },
      { range: `Pedidos!Q${fila}`, values: [[hora]] }
    ]}
  });
  return hora;
}

async function marcarEntregado(id) {
  const sheets = await getSheets();
  const fila   = await buscarFila(sheets, id);
  if (!fila) return null;
  const hora = moment().tz('America/Bogota').format('hh:mm A');
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SID(),
    resource: { valueInputOption: 'USER_ENTERED', data: [
      { range: `Pedidos!E${fila}`, values: [['FINALIZADO']] },
      { range: `Pedidos!R${fila}`, values: [[hora]] }
    ]}
  });
  return hora;
}

async function actualizarTotalPedido(id, totalFinal) {
  const sheets = await getSheets();
  const fila   = await buscarFila(sheets, id);
  if (!fila) return false;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(), range: `Pedidos!O${fila}`,
    valueInputOption: 'USER_ENTERED', resource: { values: [[totalFinal]] }
  });
  return true;
}

async function cancelarPedido(id) {
  const sheets = await getSheets();
  const fila   = await buscarFila(sheets, id);
  if (!fila) return false;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(), range: `Pedidos!E${fila}`,
    valueInputOption: 'USER_ENTERED', resource: { values: [['CANCELADO']] }
  });
  return true;
}

async function verificarClave(clave) {
  await inicializar();
  const sheets = await getSheets();
  try {
    const res  = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'Domiciliarios!A:D' });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i]?.[2]||'').toString().trim() === clave.trim()) {
        return { valida: true, nombre: rows[i][1]||'Domiciliario', fila: i+1 };
      }
    }
    return { valida: false };
  } catch(e) {
    console.error('verificarClave:', e.message);
    return { valida: false };
  }
}

async function guardarTelegramDriver(fila, telegramId) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(), range: `Domiciliarios!A${fila}`,
    valueInputOption: 'USER_ENTERED', resource: { values: [[telegramId.toString()]] }
  });
}

async function resumenDia() {
  const hoy  = moment().tz('America/Bogota').format('DD/MM/YYYY');
  const todo = await getPedidos('ALL');
  const hoyP = todo.filter(p => p.fecha === hoy);
  return {
    hoy,
    total:       hoyP.length,
    pendientes:  hoyP.filter(p => p.estado === 'PENDIENTE').length,
    enProceso:   hoyP.filter(p => p.estado === 'EN_PROCESO').length,
    finalizados: hoyP.filter(p => p.estado === 'FINALIZADO').length,
    cancelados:  hoyP.filter(p => p.estado === 'CANCELADO').length,
    ventas:      hoyP.filter(p => p.estado === 'FINALIZADO').reduce((s,p) => s+(p.total||0), 0)
  };
}

module.exports = {
  inicializar, fmt, pn,
  getCategorias, getProductosPorCategoria, buscarProductos,
  registrarPedido, getPedidos, contarPedidosPorEstado, pendientesSinAtender,
  asignarDomiciliario, marcarEntregado, actualizarTotalPedido, cancelarPedido,
  actualizarUbicacionPedido,   // ← NUEVA
  verificarClave, guardarTelegramDriver, resumenDia,
  buscarBarrioEnSheet, buscarBarrioCopacabana, guardarBarrioEnSheet, getTodosBarriosSheet,
  registrarPostulante, guardarCalificacion,
};