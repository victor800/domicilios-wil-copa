
const { google } = require('googleapis');
const moment = require('moment-timezone');

const auth = new google.auth.GoogleAuth({
  keyFile: './credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const SID = () => process.env.GOOGLE_SHEETS_ID;
let _listo = false;

async function getSheets() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSEO DE PRECIOS COLOMBIANOS
// $9.000 → 9000 | $14.500 → 14500 | 1.200.000 → 1200000
// ─────────────────────────────────────────────────────────────────────────────
const pn = v => {
  if (!v && v !== 0) return 0;
  const s = v.toString().trim()
    .replace(/\$/g, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(/,/g, '.');
  return parseFloat(s) || 0;
};

const fmt = n => {
  if (!n && n !== 0) return '0';
  return Math.round(n).toLocaleString('es-CO');
};

// ─────────────────────────────────────────────────────────────────────────────
// ESTRUCTURA DE LA HOJA PEDIDOS (columnas A→R)
// A=ID_PEDIDO        B=NOMBRE_CLIENTE   C=TELEFONO      D=METODO_PAGO
// E=ESTADO           F=IMAGEN           G=PRODUCTOS     H=MARCA
// I=CANTIDAD         J=V/U              K=V/TOTAL       L=DIRECCION
// M=HORA             N=FECHA            O=TOTAL         P=NOMBRE_DOMICILIARIO
// Q=HORA_TOMO_PEDIDO R=HORA_ENTREGO
//
// Estados válidos: PENDIENTE | EN_PROCESO | FINALIZADO | CANCELADO
// ─────────────────────────────────────────────────────────────────────────────
const HEADERS_PEDIDOS = [
  'ID_PEDIDO','NOMBRE_CLIENTE','TELEFONO','METODO_PAGO','ESTADO',
  'IMAGEN_TRANSFERENCIA','PRODUCTOS','MARCA','CANTIDAD','V/U','V/TOTAL',
  'DIRECCION','HORA','FECHA','TOTAL','NOMBRE_DOMICILIARIO',
  'HORA_TOMO_PEDIDO','HORA_ENTREGO'
];

const ESTRUCTURA = {
  Pedidos:       HEADERS_PEDIDOS,
  Domiciliarios: ['ID_TELEGRAM','NOMBRE','CLAVE','ACTIVO'],
  CATALOGO_WIL:  ['CATEGORIA','PRODUCTO','PRECIO','DISPONIBLE'],
};

// ─────────────────────────────────────────────────────────────────────────────
// INICIALIZAR — crea hojas si no existen, pone encabezados
// ─────────────────────────────────────────────────────────────────────────────
async function inicializar() {
  if (_listo) return;
  try {
    const sheets  = await getSheets();
    const meta    = await sheets.spreadsheets.get({ spreadsheetId: SID() });
    const existen = new Set(meta.data.sheets.map(h => h.properties.title));

    const nuevas = Object.keys(ESTRUCTURA).filter(n => !existen.has(n));
    if (nuevas.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SID(),
        resource: { requests: nuevas.map(title => ({ addSheet: { properties: { title } } })) }
      });
      console.log(`📋 Hojas creadas: ${nuevas.join(', ')}`);
    }

    for (const [hoja, headers] of Object.entries(ESTRUCTURA)) {
      const chk = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `${hoja}!A1` });
      if (!chk.data.values?.[0]?.[0]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SID(), range: `${hoja}!A1`,
          valueInputOption: 'USER_ENTERED', resource: { values: [headers] }
        });
        const sheetId = await getSheetId(sheets, hoja);
        if (sheetId !== null) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SID(),
            resource: { requests: [{ repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: {
                backgroundColor: { red: 0.13, green: 0.55, blue: 0.13 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
              }},
              fields: 'userEnteredFormat(backgroundColor,textFormat)'
            }}]}
          });
        }
        console.log(`✅ Encabezados en: ${hoja}`);
      }
    }

    // Catálogo WIL de ejemplo si está vacío
    const catChk = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'CATALOGO_WIL!A2:A3' });
    if (!catChk.data.values?.length) {
      const ejemplos = [
        ['🥛 Mercado y despensa','Leche Colanta 1L','$3.200','SI'],
        ['🥛 Mercado y despensa','Arroz Diana 500g','$3.500','SI'],
        ['🥛 Mercado y despensa','Aceite 1L','$9.800','SI'],
        ['🥛 Mercado y despensa','Huevos x12','$14.000','SI'],
        ['🍺 Licores','Águila 330ml','$3.500','SI'],
        ['🍺 Licores','Club Colombia 330ml','$4.200','SI'],
        ['🧴 Aseo y droguería','Jabón Dersa','$2.800','SI'],
        ['🧴 Aseo y droguería','Papel higiénico x4','$8.500','SI'],
        ['🧴 Aseo y droguería','Acetaminofén 500mg x10','$3.500','SI'],
        ['🥦 Frutas y verduras','Tomate x500g','$3.000','SI'],
        ['🥦 Frutas y verduras','Papa x1kg','$4.000','SI'],
        ['🍔 Comidas rápidas','Hamburguesa sencilla','$12.000','SI'],
        ['🍔 Comidas rápidas','Perro caliente','$8.000','SI'],
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SID(), range: 'CATALOGO_WIL!A:D',
        valueInputOption: 'USER_ENTERED', resource: { values: ejemplos }
      });
      console.log('✅ Catálogo WIL de ejemplo creado');
    }

    _listo = true;
    console.log('✅ Sheets inicializado correctamente');
  } catch(e) {
    _listo = false; // permitir reintentar si falló
    console.error('❌ ERROR inicializar Sheets:', e.message);
    throw e;
  }
}

async function getSheetId(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SID() });
  const h = meta.data.sheets.find(s => s.properties.title === title);
  return h ? h.properties.sheetId : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CATÁLOGO WIL
// ─────────────────────────────────────────────────────────────────────────────
async function getCategorias() {
  await inicializar();
  const sheets = await getSheets();
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'CATALOGO_WIL!A:D' });
  const rows = (res.data.values || []).slice(1).filter(r => r[0] && (r[3] || '').toUpperCase() !== 'NO');
  return [...new Set(rows.map(r => r[0]))];
}

async function getProductosPorCategoria(categoria) {
  await inicializar();
  const sheets = await getSheets();
  const res  = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'CATALOGO_WIL!A:D' });
  const rows = (res.data.values || []).slice(1);
  return rows
    .filter(r => r[0] === categoria && (r[3] || '').toUpperCase() !== 'NO')
    .map(r => ({ categoria: r[0], producto: r[1], precio: pn(r[2]) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// FARMACIAS — búsqueda en stock
// ─────────────────────────────────────────────────────────────────────────────
async function buscarProductos(termino, tienda) {
  await inicializar();
  const sheets = await getSheets();
  const hoja   = tienda === 'CENTRAL' ? 'STOCK_DROGUERIA_CENTRAL' : 'STOCK_DROGUERIA_EXPERTOS';
  try {
    const res  = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `${hoja}!H:M` });
    const rows = res.data.values || [];
    const q    = termino.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const out  = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r?.[0]) continue;
      const desc = r[0].toString().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (!desc.includes(q)) continue;
      const precioUnidad   = pn(r[4]);
      const precioUnitario = pn(r[5]);
      const precioMostrar  = precioUnitario > 0 ? precioUnitario : (precioUnidad > 0 ? precioUnidad : 0);
      if (precioMostrar === 0) continue;
      out.push({
        descripcion: r[0] || '', laboratorio: r[1] || '', unidad: r[3] || '',
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

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRAR PEDIDO — guarda filas en hoja Pedidos
// ─────────────────────────────────────────────────────────────────────────────
async function registrarPedido(p) {
  await inicializar();
  const sheets = await getSheets();
  const ahora  = moment().tz('America/Bogota');
  const id     = `WIL${Date.now()}`;

  const filas = p.carrito.map((item, i) => [
    i === 0 ? id                          : '',
    i === 0 ? p.nombre                    : '',
    i === 0 ? p.telefono                  : '',
    i === 0 ? p.metodoPago                : '',
    i === 0 ? 'PENDIENTE'                 : '',
    i === 0 ? (p.imagenFileId || '')      : '',
    item.descripcion,
    i === 0 ? p.negocioNombre             : '',
    item.cantidad,
    item.precioUnitario,
    item.subtotal,
    i === 0 ? p.direccion                 : '',
    i === 0 ? ahora.format('hh:mm A')    : '',
    i === 0 ? ahora.format('DD/MM/YYYY') : '',
    i === 0 ? p.totalFinal                : '',
    '', '', ''
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SID(), range: 'Pedidos!A:R',
    valueInputOption: 'USER_ENTERED', resource: { values: filas }
  });

  console.log(`✅ Pedido registrado: ID=${id} cliente=${p.nombre} total=${p.totalFinal}`);
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEER PEDIDOS
// Lee la hoja y filtra por estado (PENDIENTE, EN_PROCESO, FINALIZADO, CANCELADO, ALL)
// La comparación es SIEMPRE case-insensitive con trim para tolerar variaciones
// ─────────────────────────────────────────────────────────────────────────────
async function getPedidos(estado = 'ALL') {
  await inicializar();
  const sheets = await getSheets();

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: SID(),
      range: 'Pedidos!A:R'
    });
  } catch(e) {
    console.error('❌ getPedidos error leyendo hoja:', e.message);
    return [];
  }

  const rows = (res.data.values || []).slice(1);

  // LOG diagnóstico para detectar problemas de estado
  const filasCID = rows.filter(r => r[0]);
  if (filasCID.length > 0) {
    const estadosVistos = [...new Set(filasCID.map(r => `"${(r[4] || '').toString().trim()}"`))];
    console.log(`📋 getPedidos("${estado}"): ${filasCID.length} filas con ID. Estados en hoja: [${estadosVistos.join(', ')}]`);
  }

  return rows
    .filter(r => {
      if (!r[0]) return false;
      if (estado === 'ALL') return true;
      const estadoFila = (r[4] || '').toString().trim().toUpperCase();
      return estadoFila === estado.trim().toUpperCase();
    })
    .map(r => ({
      id:              (r[0]  || '').toString().trim(),
      cliente:         (r[1]  || '').toString().trim(),
      telefono:        (r[2]  || '').toString().trim(),
      metodoPago:      (r[3]  || '').toString().trim(),
      estado:          (r[4]  || '').toString().trim().toUpperCase(),
      productos:       (r[6]  || '').toString().trim(),
      negocio:         (r[7]  || '').toString().trim(),
      direccion:       (r[11] || '').toString().trim(),
      barrio:          (r[11] || '').toString().trim(),
      hora:            (r[12] || '').toString().trim(),
      fecha:           (r[13] || '').toString().trim(),
      total:           pn(r[14]),
      precioDomicilio: 0,
      domiciliario:    (r[15] || '').toString().trim(),
      horaTomo:        (r[16] || '').toString().trim(),
      horaEntrego:     (r[17] || '').toString().trim(),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTADORES DIRECTOS DESDE SHEETS
// Lee SOLO columnas A, E y N para máxima velocidad
// Pendientes y EnProceso: sin filtro de fecha (pueden ser de días anteriores)
// Finalizados: solo los de HOY
// ─────────────────────────────────────────────────────────────────────────────
async function contarPedidosPorEstado() {
  await inicializar();
  const sheets = await getSheets();

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: SID(),
      range: 'Pedidos!A:N'
    });
  } catch(e) {
    console.error('❌ contarPedidosPorEstado error:', e.message);
    throw e;
  }

  const rows = (res.data.values || []).slice(1);
  const hoy  = moment().tz('America/Bogota').format('DD/MM/YYYY');

  let pendientes  = 0;
  let enProceso   = 0;
  let finalizados = 0;

  for (const r of rows) {
    if (!r[0]) continue;
    const e = (r[4] || '').toString().trim().toUpperCase();
    const f = (r[13] || '').toString().trim();
    if (e === 'PENDIENTE')                    pendientes++;
    if (e === 'EN_PROCESO')                   enProceso++;
    if (e === 'FINALIZADO' && f === hoy)      finalizados++;
  }

  console.log(`📊 Contadores → PENDIENTE:${pendientes} EN_PROCESO:${enProceso} FINALIZADO(hoy):${finalizados}`);
  return { pendientes, enProceso, finalizados };
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDIENTES SIN ATENDER (para recordatorio automático)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// BUSCAR FILA POR ID EN COLUMNA A
// ─────────────────────────────────────────────────────────────────────────────
async function buscarFila(sheets, id) {
  const r   = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'Pedidos!A:A' });
  const idx = (r.data.values || []).findIndex(f => (f[0] || '').toString().trim() === id.toString().trim());
  return idx === -1 ? null : idx + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASIGNAR DOMICILIARIO → escribe EN_PROCESO en col E, nombre en P, hora en Q
// ─────────────────────────────────────────────────────────────────────────────
async function asignarDomiciliario(id, nombre) {
  const sheets = await getSheets();
  const fila   = await buscarFila(sheets, id);
  if (!fila) {
    console.error(`❌ asignarDomiciliario: no encontré fila para "${id}"`);
    return null;
  }
  const hora = moment().tz('America/Bogota').format('hh:mm A');
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SID(),
    resource: { valueInputOption: 'USER_ENTERED', data: [
      { range: `Pedidos!E${fila}`, values: [['EN_PROCESO']] },
      { range: `Pedidos!P${fila}`, values: [[nombre]] },
      { range: `Pedidos!Q${fila}`, values: [[hora]] }
    ]}
  });
  console.log(`✅ asignarDomiciliario: id=${id} fila=${fila} domi="${nombre}" hora=${hora}`);
  return hora;
}

// ─────────────────────────────────────────────────────────────────────────────
// MARCAR ENTREGADO → escribe FINALIZADO en col E, hora en R
// ─────────────────────────────────────────────────────────────────────────────
async function marcarEntregado(id) {
  const sheets = await getSheets();
  const fila   = await buscarFila(sheets, id);
  if (!fila) {
    console.error(`❌ marcarEntregado: no encontré fila para "${id}"`);
    return null;
  }
  const hora = moment().tz('America/Bogota').format('hh:mm A');
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SID(),
    resource: { valueInputOption: 'USER_ENTERED', data: [
      { range: `Pedidos!E${fila}`, values: [['FINALIZADO']] },
      { range: `Pedidos!R${fila}`, values: [[hora]] }
    ]}
  });
  console.log(`✅ marcarEntregado: id=${id} fila=${fila} hora=${hora}`);
  return hora;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOMICILIARIOS
// ─────────────────────────────────────────────────────────────────────────────
async function verificarClave(clave) {
  await inicializar();
  const sheets = await getSheets();
  try {
    const res  = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: 'Domiciliarios!A:D' });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i]?.[2] || '').toString().trim() === clave.trim()) {
        return { valida: true, nombre: rows[i][1] || 'Domiciliario', fila: i + 1 };
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

// ─────────────────────────────────────────────────────────────────────────────
// RESUMEN DEL DÍA
// ─────────────────────────────────────────────────────────────────────────────
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
    ventas:      hoyP.filter(p => p.estado === 'FINALIZADO').reduce((s, p) => s + (p.total || 0), 0)
  };
}

module.exports = {
  inicializar, fmt, pn,
  getCategorias, getProductosPorCategoria,
  buscarProductos,
  registrarPedido, getPedidos, contarPedidosPorEstado, pendientesSinAtender,
  asignarDomiciliario, marcarEntregado,
  verificarClave, guardarTelegramDriver, resumenDia
};