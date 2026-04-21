// ═══════════════════════════════════════════════════════════════════════════
// api/wil.mjs — Domicilios WIL  ·  Vercel Serverless
// ═══════════════════════════════════════════════════════════════════════════

import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT }               from 'google-auth-library';

// ── Credenciales Google ──────────────────────────────────────────────────────
const SHEET_ID         = process.env.GOOGLE_SHEET_ID;
const SA_EMAIL         = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SA_KEY           = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const FARMACIA_SHEET_ID = process.env.FARMACIA_SHEET_ID || SHEET_ID;

async function getSheet(nombre, sheetId) {
  const auth = new JWT({
    email: SA_EMAIL, key: SA_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(sheetId || SHEET_ID, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[nombre];
  if (!sheet) throw new Error(`Hoja "${nombre}" no encontrada`);
  return sheet;
}

function ahora() {
  const now   = new Date();
  const hora  = now.toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit', hour12:true });
  const fecha = now.toLocaleDateString('es-CO',  { day:'2-digit', month:'2-digit', year:'numeric' });
  return { hora, fecha, ts: now.getTime() };
}

function generarID() {
  return String(Math.floor(Math.random() * 900) + 100);
}

let _msgCounter = Date.now();
function nextMsgId() { return ++_msgCounter; }

const ESTADOS = {
  'Pendiente':  { emoji:'⏳', color:'#f59e0b', label:'⏳ Pendiente'  },
  'Confirmado': { emoji:'✅', color:'#3b82f6', label:'✅ Confirmado' },
  'En camino':  { emoji:'🛵', color:'#8b5cf6', label:'🛵 En camino'  },
  'Entregado':  { emoji:'🎉', color:'#2a9d5c', label:'🎉 Entregado'  },
  'Cancelado':  { emoji:'❌', color:'#ef4444', label:'❌ Cancelado'  },
};

// ════════════════════════════════════════════════════════════════════════════
// 0. SHEET STOCK — leer inventario de farmacias
// ════════════════════════════════════════════════════════════════════════════
async function sheetStock(query) {
  const { tab } = query;
  const tabsValidas = ['STOCK_DROGUERIA_CENTRAL', 'STOCK_DROGUERIA_EXPERTOS'];
  if (!tab || !tabsValidas.includes(tab.trim()))
    return { status: 400, data: { ok: false, error: `Tab inválido. Usar: ${tabsValidas.join(' | ')}` } };

  const sheet = await getSheet(tab.trim(), FARMACIA_SHEET_ID);
  await sheet.loadCells('A:F');
  const rowCount = sheet.rowCount;
  const productos = [];

  for (let r = 1; r < rowCount; r++) {
    const desc = sheet.getCell(r, 0).value;
    if (!desc || String(desc).trim().length < 2) continue;
    productos.push({
      desc:   String(desc).trim(),
      lab:    String(sheet.getCell(r, 1).value || '').trim(),
      unidad: String(sheet.getCell(r, 2).value || '').trim(),
      precio: Number(String(sheet.getCell(r, 3).value || 0).replace(/[^\d.]/g, '')) || 0,
      pUnit:  Number(String(sheet.getCell(r, 4).value || 0).replace(/[^\d.]/g, '')) || 0,
      imagen: String(sheet.getCell(r, 5).value || '').trim(),
    });
  }

  return { status: 200, data: { ok: true, tab: tab.trim(), total: productos.length, productos } };
}

// ════════════════════════════════════════════════════════════════════════════
// 0b. PEDIDO FARMACIA — guardar pedido desde farmacias y pedido-wil
//     Acepta  rows[][]  (array de arrays, columnas A→S)
//     sede: 'central' | 'expertos' | 'wil-libre'  → siempre cae en Pedidos
// ════════════════════════════════════════════════════════════════════════════
async function pedidoFarmacia(body) {
  const { rows, id, sede } = body;

  if (!rows || !rows.length || !id)
    return { status: 400, data: { ok: false, error: 'rows e id son requeridos' } };

  // Hojas específicas de farmacia
  const tabNames = {
    central:  'PEDIDOS_DROGUERIA_CENTRAL',
    expertos: 'PEDIDOS_DROGUERIA_EXPERTOS',
  };

  let sheet;
  const tabEspecifico = tabNames[sede];

  if (tabEspecifico) {
    try {
      sheet = await getSheet(tabEspecifico, FARMACIA_SHEET_ID);
    } catch (e) {
      // Hoja específica no existe → caer en hoja general
      sheet = await getSheet('Pedidos');
    }
  } else {
    // sede = 'wil-libre' u otro → siempre hoja general de Pedidos
    sheet = await getSheet('Pedidos');
  }

  for (const row of rows) {
    await sheet.addRow(row);
  }

  return { status: 200, data: { ok: true, id } };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. PEDIDO WEB (legacy — mantener compatibilidad)
// ════════════════════════════════════════════════════════════════════════════
async function pedidoWeb(body) {
  const {
    nombre, telefono, direccion, referencia, coords, barrio,
    tipo, productos, presupuesto, metodoPago, precioDomicilio,
    zonaDestino, rowDirecto,
  } = body;

  if (!nombre || !telefono || !direccion || !metodoPago)
    return { status: 400, data: { ok: false, error: 'Faltan campos requeridos' } };

  const id = rowDirecto?.ID_PEDIDO || generarID();
  const { hora, fecha } = ahora();

  if (rowDirecto) {
    rowDirecto.ID_PEDIDO        = rowDirecto.ID_PEDIDO || id;
    rowDirecto.HORA             = rowDirecto.HORA      || hora;
    rowDirecto.FECHA            = rowDirecto.FECHA     || fecha;
    rowDirecto.NOMBRE_DOMI      = '';
    rowDirecto.HORA_TOMO_PEDIDO = '';
    rowDirecto.HORA_ENTREGO     = '';
    rowDirecto.CALIFICACION     = '';
    const sheet = await getSheet('Pedidos');
    await sheet.addRow(rowDirecto);
    return { status: 200, data: { ok: true, id: rowDirecto.ID_PEDIDO, hora, fecha } };
  }

  let productosStr = '', marcaStr = '', cantidadStr = '', vuStr = '', vtotalStr = '';
  let totalProductos = 0;

  if (productos?.length) {
    productosStr   = productos.map(p => (p.nombre||p.descripcion||'') + ' x' + (p.qty||p.cantidad||1)).join(' | ');
    marcaStr       = productos.map(p => p.marca||'-').join(' | ');
    cantidadStr    = productos.map(p => p.qty||p.cantidad||1).join(' | ');
    vuStr          = productos.map(p => p.precioUnit||0).join(' | ');
    vtotalStr      = productos.map(p => p.subtotal||0).join(' | ');
    totalProductos = productos.reduce((a, p) => a + Number(p.subtotal||0), 0);
  } else if (presupuesto) {
    productosStr = 'Pedido libre';
    marcaStr     = '-';
    cantidadStr  = '-';
    vuStr        = '-';
    vtotalStr    = 'Presupuesto: $' + Number(presupuesto).toLocaleString('es-CO');
  }

  const domicilio  = Number(precioDomicilio || 0);
  const totalFinal = totalProductos > 0 ? totalProductos + domicilio : domicilio;

  let dirCompleta = direccion;
  if (referencia)  dirCompleta += ` (Ref: ${referencia})`;
  if (barrio)      dirCompleta += ` — ${barrio}`;
  if (coords?.lat) dirCompleta += ` [${coords.lat.toFixed(5)},${coords.lng.toFixed(5)}]`;
  if (zonaDestino) dirCompleta += ` → Zona: ${zonaDestino}`;

  const sheet = await getSheet('Pedidos');
  await sheet.addRow({
    ID_PEDIDO:            id,
    NOMBRE_CLI:           nombre,
    TELEFONO:             telefono,
    METODO_PAGO:          metodoPago,
    ESTADO:               'Pendiente',
    IMAGEN_TRANSFERENCIA: '',
    PRODUCTOS:            productosStr,
    MARCA:                marcaStr,
    CANTIDAD:             cantidadStr,
    'V/U':                vuStr,
    'V/TOTAL':            vtotalStr,
    DIRECCION:            dirCompleta,
    HORA:                 hora,
    FECHA:                fecha,
    TOTAL:                totalFinal > 0
                            ? '$' + totalFinal.toLocaleString('es-CO') + ' COP'
                            : 'Por confirmar',
    NOMBRE_DOMI:          '',
    HORA_TOMO_PEDIDO:     '',
    HORA_ENTREGO:         '',
    CALIFICACION:         '',
  });

  return { status: 200, data: { ok: true, id, hora, fecha } };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. RASTREAR
// ════════════════════════════════════════════════════════════════════════════
async function rastrear(query) {
  const id = query.id;
  if (!id) return { status: 400, data: { ok: false, error: 'ID requerido' } };

  const sheet = await getSheet('Pedidos');
  const rows  = await sheet.getRows();
  const row   = rows.find(r => r.get('ID_PEDIDO')?.trim() === id.trim());
  if (!row) return { status: 404, data: { ok: false, error: 'Pedido no encontrado' } };

  const estado     = row.get('ESTADO') || 'Pendiente';
  const estadoInfo = ESTADOS[estado]   || ESTADOS['Pendiente'];

  let fotoDomi=null, telefonoDomi=null, domiLat=null, domiLng=null, idDomi=null;
  const nombreDomiRaw = row.get('NOMBRE_DOMI') || '';
  if (nombreDomiRaw) {
    try {
      const sheetDomis = await getSheet('Domiciliarios');
      const domis = await sheetDomis.getRows();
      const idMatch  = nombreDomiRaw.match(/\(([^)]+)\)/);
      const idBuscar = idMatch ? idMatch[1].trim() : '';
      const domiRow  = domis.find(d =>
        idBuscar
          ? d.get('ID_DOMI')?.trim() === idBuscar
          : d.get('NOMBRE')?.trim().toLowerCase() === nombreDomiRaw.split('(')[0].trim().toLowerCase()
      );
      if (domiRow) {
        fotoDomi     = domiRow.get('FOTO')?.trim()     || null;
        telefonoDomi = domiRow.get('TELEFONO')?.trim() || null;
        idDomi       = domiRow.get('ID_DOMI')?.trim()  || idBuscar || null;
        const locDomi = _domiLocations.get(String(idDomi));
        if (locDomi && Date.now() - locDomi.ts < LOCATION_TTL_MS) {
          domiLat = locDomi.lat;
          domiLng = locDomi.lng;
        }
      }
    } catch(e) {}
  }

  const COPA_LAT = 6.34911, COPA_LNG = -75.50619;
  let distanciaKm = null, tiempoMin = null;
  const origenLat = domiLat || COPA_LAT;
  const origenLng = domiLng || COPA_LNG;
  const dirRaw    = row.get('DIRECCION') || '';
  const coordsMatch = dirRaw.match(/\[(-?\d+\.\d+),\s*(-?\d+\.\d+)\]/);

  if (coordsMatch) {
    const destLat = parseFloat(coordsMatch[1]);
    const destLng = parseFloat(coordsMatch[2]);
    try {
      const osrmUrl  = `https://router.project-osrm.org/route/v1/driving/${origenLng},${origenLat};${destLng},${destLat}?overview=false`;
      const osrmRes  = await fetch(osrmUrl, { headers: { 'User-Agent': 'DomiciliosWIL/1.0' } });
      const osrmData = await osrmRes.json();
      if (osrmData.routes?.[0]) {
        distanciaKm = (osrmData.routes[0].distance / 1000).toFixed(1);
        tiempoMin   = Math.ceil(osrmData.routes[0].duration / 60);
      }
    } catch(e) {}
  }

  return {
    status: 200,
    data: { ok: true, pedido: {
      id:             row.get('ID_PEDIDO'),
      estado,
      estadoEmoji:    estadoInfo.emoji,
      estadoColor:    estadoInfo.color,
      estadoLabel:    estadoInfo.label,
      cliente:        row.get('NOMBRE_CLI'),
      telefono:       row.get('TELEFONO'),
      direccion:      row.get('DIRECCION'),
      productos:      row.get('PRODUCTOS'),
      total:          row.get('TOTAL'),
      metodoPago:     row.get('METODO_PAGO'),
      fecha:          row.get('FECHA'),
      hora:           row.get('HORA'),
      domiciliario:   nombreDomiRaw || null,
      telefonoDomi,
      fotoDomi,
      idDomi,
      domiLat,
      domiLng,
      distanciaKm,
      tiempoMin,
      origenLat:      COPA_LAT,
      origenLng:      COPA_LNG,
      horaTomoPedido: row.get('HORA_TOMO_PEDIDO') || null,
      horaEntrego:    row.get('HORA_ENTREGO')     || null,
      calificacion:   row.get('CALIFICACION')     || null,
    }},
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. PEDIDOS PENDIENTES
// ════════════════════════════════════════════════════════════════════════════
async function pedidosPendientes() {
  const sheet = await getSheet('Pedidos');
  const rows  = await sheet.getRows();

  const mapa = new Map();

  for (const r of rows) {
    const id     = r.get('ID_PEDIDO')?.trim();
    const estado = r.get('ESTADO')?.trim();
    if (!id) continue;

    const estadosActivos = ['Pendiente','Confirmado','En proceso','En camino'];
    if (!estadosActivos.includes(estado)) continue;

    if (!mapa.has(id)) {
      mapa.set(id, {
        id,
        cliente: (r.get('NOMBRE_CLI') || r.get('NOMBRE_CLi') || r.get('nombre_cli') || r.get('NombreCli') || '').trim() || '—',
        telefono:      (r.get('TELEFONO')         || '').trim(),
        metodoPago:    (r.get('METODO_PAGO')      || '').trim(),
        estado,
        total:         (r.get('TOTAL')            || '').trim(),
        direccion:     (r.get('DIRECCION')        || '').trim(),
        hora:          (r.get('HORA')             || '').trim(),
        fecha:         (r.get('FECHA')            || '').trim(),
        nombreDomi:    (r.get('NOMBRE_DOMI')      || '').trim(),
        horaEnProceso: (r.get('HORA_EN_PROCESO')  || '').trim(),
        horaEnCamino:  (r.get('HORA_EN_CAMINO')   || '').trim(),
        horaEntrego:   (r.get('HORA_ENTREGO')     || '').trim(),
        _lineas: [],
      });
    }

    const p     = mapa.get(id);
    const prod  = (r.get('PRODUCTOS') || '').trim();
    const marca = (r.get('MARCA')     || '').trim();
    const cant  = (r.get('CANTIDAD')  || '1').trim();
    const vu    = (r.get('V/U')       || '').trim();
    const vt    = (r.get('V/TOTAL')   || '').trim();

    if (prod && prod !== 'Pedido libre' && prod !== 'Domicilio (default)' && prod !== '') {
      p._lineas.push({ prod, marca, cant, vu, vt });
    }
  }

  const pendientes = [];
  for (const [, p] of mapa) {
    let productosStr = 'Pedido libre';
    let marcaStr = '-', cantidadStr = '-';

    if (p._lineas.length > 0) {
      const tienePrecio = p._lineas.some(l => l.vt && l.vt !== '');
      if (tienePrecio) {
        productosStr = p._lineas.map(l => {
          const vtNum = parseFloat(String(l.vt).replace(/[^\d.]/g, '')) || 0;
          const vuNum = parseFloat(String(l.vu).replace(/[^\d.]/g, '')) || 0;
          let s = `${l.prod} x${l.cant || 1} = $${vtNum.toLocaleString('es-CO')}`;
          if (vuNum > vtNum && vuNum > 0)
            s += ` (antes $${vuNum.toLocaleString('es-CO')})`;
          return s;
        }).join(' | ');
      } else {
        productosStr = p._lineas.map(l => l.prod).join(' | ');
        marcaStr     = p._lineas.map(l => l.marca || '-').join(' | ');
        cantidadStr  = p._lineas.map(l => l.cant  || '1').join(' | ');
      }
    }

    const idMatch  = p.nombreDomi.match(/\(([^)]+)\)/);
    const idDomi   = idMatch ? idMatch[1].trim() : '';
    const nomSolo  = p.nombreDomi.replace(/\s*\([^)]+\)/, '').trim();

    pendientes.push({
      id:            p.id,
      cliente:       p.cliente,
      telefono:      p.telefono,
      metodoPago:    p.metodoPago,
      estado:        p.estado,
      productos:     productosStr,
      marca:         marcaStr,
      cantidad:      cantidadStr,
      total:         p.total,
      direccion:     p.direccion,
      hora:          p.hora,
      fecha:         p.fecha,
      nombreDomi:    nomSolo,
      idDomi,
      horaAceptado:  p.hora,
      horaEnProceso: p.horaEnProceso,
      horaEnCamino:  p.horaEnCamino,
      horaEntrego:   p.horaEntrego,
      tipo: p._lineas.some(l => l.marca && l.marca !== '-') ? 'farmacia' : 'libre',
    });
  }

  return { status: 200, data: { ok: true, pedidos: pendientes } };
}
// ════════════════════════════════════════════════════════════════════════════
// 4. TOMAR PEDIDO
// ════════════════════════════════════════════════════════════════════════════
async function tomarPedido(body) {
  const { idPedido, idDomi, nombreDomi } = body;
  if (!idPedido || !nombreDomi)
    return { status: 400, data: { ok: false, error: 'idPedido y nombreDomi requeridos' } };

  const sheet = await getSheet('Pedidos');
  const rows  = await sheet.getRows();
  const row   = rows.find(r => r.get('ID_PEDIDO')?.trim() === idPedido.trim());
  if (!row)
    return { status: 404, data: { ok: false, error: 'Pedido no encontrado' } };
  if (row.get('ESTADO')?.trim() !== 'Pendiente')
    return { status: 409, data: { ok: false, error: 'Ya fue tomado por otro domiciliario' } };

  const { hora } = ahora();
  row.set('ESTADO',           'Confirmado');
  row.set('NOMBRE_DOMI',      `${nombreDomi} (${idDomi || ''})`);
  row.set('HORA_TOMO_PEDIDO', hora);
  await row.save();

  return { status: 200, data: { ok: true, mensaje: 'Pedido tomado con éxito' } };
}

// En tu Apps Script — función que agrupa filas por ID de pedido
function agruparPedidos(filas) {
  var pedMap = {};
  var pedOrder = [];
  var lastId = null;

  filas.forEach(function(row) {
    // Columnas: A=0 ID, B=1 cliente, C=2 tel, D=3 metodo, E=4 estado,
    // F=5 imagen, G=6 producto, H=7 marca, I=8 cantidad,
    // J=9 vu, K=10 vtotal, L=11 direccion, M=12 hora,
    // N=13 fecha, O=14 total, P=15 domi, Q=16 horaEnProceso,
    // R=17 horaEnCamino, S=18 horaEntrego, T=19 calificacion

    var id = (row[0] || '').toString().trim();
    var producto = (row[6] || '').toString().trim();

    // Si hay ID nuevo, crear entrada
    if (id && !pedMap[id]) {
      pedMap[id] = {
        id:          id,
        cliente:     (row[1]  || '').toString().trim(),
        telefono:    (row[2]  || '').toString().trim(),
        metodoPago:  (row[3]  || '').toString().trim(),
        estado:      (row[4]  || '').toString().trim(),
        imagen:      (row[5]  || '').toString().trim(),
        direccion:   (row[11] || '').toString().trim(),
        hora:        (row[12] || '').toString().trim(),
        fecha:       (row[13] || '').toString().trim(),
        total:       (row[14] || '').toString().trim(),
        idDomi:      (row[15] || '').toString().trim(),
        horaEnProceso: (row[16] || '').toString().trim(),
        horaAceptado:  (row[17] || '').toString().trim(),  // R = hora en camino
        horaEntrego:   (row[18] || '').toString().trim(),
        calificacion:  (row[19] || '').toString().trim(),
        _prods: []
      };
      pedOrder.push(id);
      lastId = id;
    } else if (!id && lastId) {
      id = lastId; // fila de continuación — mismo pedido
    }

    var ped = pedMap[id];
    if (!ped) return;

    // Agregar producto si no es "Domicilio (default)" y tiene nombre
    var nomProd = producto.replace(/\|cat$/i, '').trim();
    if (nomProd && !/^domicilio/i.test(nomProd)) {
      var vu     = parseFloat((row[9]  || '0').toString().replace(/[^0-9.]/g, '')) || 0;
      var vtotal = parseFloat((row[10] || '0').toString().replace(/[^0-9.]/g, '')) || 0;
      var qty    = parseInt((row[8]   || '1').toString()) || 1;
      ped._prods.push({
        nom:    nomProd,
        marca:  (row[7] || '').toString().trim(),
        qty:    qty,
        vu:     vu,
        vtotal: vtotal
      });
    }

    // Si es fila de domicilio, guardar costo aparte
    if (/^domicilio/i.test(nomProd)) {
      var vtotalDomi = parseFloat((row[10] || '0').toString().replace(/[^0-9.]/g, '')) || 0;
      ped.domicilio = vtotalDomi > 0 ? vtotalDomi.toString() : ped.domicilio || '';
    }
  });

  // Convertir _prods a strings para compatibilidad con parsearProductos()
  // Y también dejar _prods para el nuevo renderizado
  return pedOrder.map(function(id) {
    var p = pedMap[id];
    p.productos  = p._prods.map(function(x){ return x.nom; }).join('|');
    p.cantidad   = p._prods.map(function(x){ return x.qty; }).join('|');
    p.precios    = p._prods.map(function(x){ return x.vu > 0 ? x.vu : (x.vtotal / (x.qty||1)); }).join('|');
    return p;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 5. DOMI LOGIN
// ════════════════════════════════════════════════════════════════════════════
async function domiLogin(body) {
  const { id, clave } = body;
  if (!id || !clave)
    return { status: 400, data: { ok: false, error: 'ID y clave requeridos' } };

  const sheet = await getSheet('Domiciliarios');
  const rows  = await sheet.getRows();
  const domi  = rows.find(r =>
    r.get('ID_DOMI')?.trim().toUpperCase() === id.trim().toUpperCase() &&
    r.get('CLAVE')?.trim() === clave.trim()
  );
  if (!domi)
    return { status: 401, data: { ok: false, error: 'ID o clave incorrectos' } };

  const activo = domi.get('ACTIVO')?.trim().toUpperCase();
  if (activo === 'NO' || activo === 'FALSE' || activo === '0')
    return { status: 403, data: { ok: false, error: 'Cuenta inactiva. Contacta a WIL.' } };

  return {
    status: 200,
    data: { ok: true, domi: {
      id:       domi.get('ID_DOMI')?.trim(),
      nombre:   domi.get('NOMBRE')?.trim(),
      telefono: domi.get('TELEFONO')?.trim(),
      foto:     domi.get('FOTO')?.trim() || null,
    }},
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 6. CAMBIAR ESTADO
// ════════════════════════════════════════════════════════════════════════════
async function cambiarEstado(body) {
  const { idPedido, estado, idDomi, hora } = body;
  const validos = ['Confirmado', 'En proceso', 'En camino', 'Entregado', 'Cancelado'];
  if (!idPedido || !validos.includes(estado))
    return { status: 400, data: { ok: false, error: 'estado inválido' } };

  const sheet = await getSheet('Pedidos');
  const rows  = await sheet.getRows();
  const row   = rows.find(r => r.get('ID_PEDIDO')?.trim() === idPedido.trim());
  if (!row) return { status: 404, data: { ok: false, error: 'Pedido no encontrado' } };

  const { hora: horaAhora } = ahora();
  const h = hora || horaAhora;
  row.set('ESTADO', estado);
  if (estado === 'En proceso')  row.set('HORA_EN_PROCESO', h);
  if (estado === 'En camino')   row.set('HORA_EN_CAMINO',  h);
  if (estado === 'Entregado')   row.set('HORA_ENTREGO',    h);
  await row.save();
  return { status: 200, data: { ok: true } };
}

async function pedidoActivo(query) {
  const { domiId } = query;
  if (!domiId) return { status: 400, data: { ok: false, error: 'domiId requerido' } };

  const sheet = await getSheet('Pedidos');
  const rows  = await sheet.getRows();

  // Busca el pedido más reciente no entregado asignado a este domiciliario
  const activos = ['Confirmado', 'En proceso', 'En camino'];
  const row = rows.slice().reverse().find(r => {
    const estado      = r.get('ESTADO')?.trim();
    const nombreDomi  = r.get('NOMBRE_DOMI') || '';
    // El ID del domi está entre paréntesis: "Nombre (WIL-001)"
    const idMatch = nombreDomi.match(/\(([^)]+)\)/);
    const idEnRow = idMatch ? idMatch[1].trim().toUpperCase() : '';
    return activos.includes(estado) && idEnRow === domiId.trim().toUpperCase();
  });

  if (!row) return { status: 200, data: { ok: false } };

  return { status: 200, data: { ok: true, pedido: {
    id:           row.get('ID_PEDIDO')?.trim(),
    cliente:      row.get('NOMBRE_CLI')?.trim(),
    telefono:     row.get('TELEFONO')?.trim(),
    metodoPago:   row.get('METODO_PAGO')?.trim(),
    estado:       row.get('ESTADO')?.trim(),
    productos:    row.get('PRODUCTOS')?.trim(),
    marca:        row.get('MARCA')?.trim(),
    cantidad:     row.get('CANTIDAD')?.trim(),
    total:        row.get('TOTAL')?.trim(),
    direccion:    row.get('DIRECCION')?.trim(),
    hora:         row.get('HORA')?.trim(),
    fecha:        row.get('FECHA')?.trim(),
    tipo: (!row.get('MARCA') || row.get('MARCA')?.trim() === '-') ? 'libre' : 'farmacia',
    horaAceptado:  row.get('HORA_TOMO_PEDIDO')?.trim() || null,
    horaEnProceso: row.get('HORA_EN_PROCESO')?.trim()  || null,
    horaEnCamino:  row.get('HORA_EN_CAMINO')?.trim()   || null,
    horaEntregado: row.get('HORA_ENTREGO')?.trim()     || null,
  }}};
}

// ════════════════════════════════════════════════════════════════════════════
// 7. CALIFICAR
// ════════════════════════════════════════════════════════════════════════════
async function calificar(body) {
  const { id, calificacion } = body;
  if (!id || !calificacion)
    return { status: 400, data: { ok: false, error: 'id y calificacion requeridos' } };

  const sheet = await getSheet('Pedidos');
  const rows  = await sheet.getRows();
  const row   = rows.find(r =>
    r.get('ID_PEDIDO')?.trim().toUpperCase() === id.trim().toUpperCase()
  );
  if (!row)
    return { status: 404, data: { ok: false, error: 'Pedido no encontrado' } };

  row.set('CALIFICACION', String(calificacion));
  await row.save();
  return { status: 200, data: { ok: true } };
}

// ════════════════════════════════════════════════════════════════════════════
// 8. CHAT — domi → cliente
// ════════════════════════════════════════════════════════════════════════════
async function chatMensaje(body) {
  const { idPedido, idDomi, mensaje, hora } = body;
  if (!idPedido || !mensaje)
    return { status: 400, data: { ok: false, error: 'idPedido y mensaje requeridos' } };

  const sheet = await getSheet('Chat');
  const { hora: horaAhora, fecha } = ahora();
  const msgId = nextMsgId();

  await sheet.addRow({
    MSG_ID: String(msgId), ID_PEDIDO: idPedido, LADO: 'domi',
    TEXTO: mensaje, HORA: hora || horaAhora, FECHA: fecha,
    LEIDO: 'NO', TIPO_ARCHIVO: 'texto', URL_ARCHIVO: '', ID_DOMI: idDomi || '',
  });
  return { status: 200, data: { ok: true, msgId } };
}

async function historialDomi(query) {
  const { domiId } = query;
  if (!domiId) return { status: 400, data: { ok: false, error: 'domiId requerido' } };

  const sheet = await getSheet('Pedidos');
  const rows  = await sheet.getRows();

  const mapa = new Map();
  for (const r of rows) {
    const id         = r.get('ID_PEDIDO')?.trim();
    const estado     = r.get('ESTADO')?.trim();
    const nombreDomi = r.get('NOMBRE_DOMI') || '';
    const idMatch    = nombreDomi.match(/\(([^)]+)\)/);
    const idEnRow    = idMatch ? idMatch[1].trim().toUpperCase() : '';
    if (!id || idEnRow !== domiId.trim().toUpperCase()) continue;
    if (estado !== 'Entregado') continue;

    if (!mapa.has(id)) {
      mapa.set(id, {
        id,
        cliente:    (r.get('NOMBRE_CLI')  || '').trim(),
        telefono:   (r.get('TELEFONO')    || '').trim(),
        total:      (r.get('TOTAL')       || '').trim(),
        metodoPago: (r.get('METODO_PAGO') || '').trim(),
        direccion:  (r.get('DIRECCION')   || '').trim(),
        hora:       (r.get('HORA_ENTREGO')|| r.get('HORA') || '').trim(),
        fecha:      (r.get('FECHA')       || '').trim(),
        estado,
        calificacion: (r.get('CALIFICACION') || '').trim(),
        _lineas: [],
      });
    }
    const prod = (r.get('PRODUCTOS') || '').trim();
    if (prod && prod !== 'Pedido libre')
      mapa.get(id)._lineas.push({ prod, vt: (r.get('V/TOTAL')||'').trim() });
  }

  const historial = [...mapa.values()].map(p => ({
    ...p,
    productos: p._lineas.map(l => l.prod).join(' | '),
  }));

  return { status: 200, data: { ok: true, historial } };
}

// ════════════════════════════════════════════════════════════════════════════
// 9. CHAT — cliente → domi
// ════════════════════════════════════════════════════════════════════════════
async function chatMensajeCliente(body) {
  const { idPedido, mensaje, hora, cliente, telefono } = body;
  if (!idPedido || !mensaje)
    return { status: 400, data: { ok: false, error: 'idPedido y mensaje requeridos' } };

  const sheet = await getSheet('Chat');
  const { hora: horaAhora, fecha } = ahora();
  const msgId = nextMsgId();

  await sheet.addRow({
    MSG_ID: String(msgId), ID_PEDIDO: idPedido, LADO: 'cliente',
    TEXTO: mensaje, HORA: hora || horaAhora, FECHA: fecha,
    LEIDO: 'NO', TIPO_ARCHIVO: 'texto', URL_ARCHIVO: '',
    NOMBRE_CLI: cliente || '', TELEFONO_CLI: telefono || '',
  });
  return { status: 200, data: { ok: true, msgId } };
}

// ════════════════════════════════════════════════════════════════════════════
// 10. CHAT — POLLING
// ════════════════════════════════════════════════════════════════════════════
async function chatPoll(query) {
  const { idPedido, lastId, lado } = query;
  if (!idPedido)
    return { status: 400, data: { ok: false, error: 'idPedido requerido' } };

  const lastIdNum  = Number(lastId) || 0;
  const ladoBuscar = lado === 'cliente' ? 'domi' : 'cliente';

  const sheet = await getSheet('Chat');
  const rows  = await sheet.getRows();

  const nuevos = rows
    .filter(r =>
      r.get('ID_PEDIDO')?.trim() === idPedido.trim() &&
      r.get('LADO')?.trim()      === ladoBuscar &&
      Number(r.get('MSG_ID'))    >  lastIdNum
    )
    .map(r => ({
      id:          Number(r.get('MSG_ID')),
      tipo:        'in',
      texto:       r.get('TEXTO')        || '',
      hora:        r.get('HORA')         || '',
      leido:       r.get('LEIDO')?.trim().toUpperCase() === 'SI',
      tipoArchivo: r.get('TIPO_ARCHIVO') || 'texto',
      urlArchivo:  r.get('URL_ARCHIVO')  || '',
    }));

  if (nuevos.length) {
    const msgIds = nuevos.map(m => m.id);
    (async () => {
      try {
        const allRows = await sheet.getRows();
        for (const r of allRows) {
          if (
            r.get('ID_PEDIDO')?.trim() === idPedido.trim() &&
            r.get('LADO')?.trim()      === ladoBuscar &&
            msgIds.includes(Number(r.get('MSG_ID'))) &&
            r.get('LEIDO')?.trim().toUpperCase() !== 'SI'
          ) { r.set('LEIDO', 'SI'); await r.save(); }
        }
      } catch(e) {}
    })();
  }

  const leidosDelOtroLado = rows.some(r =>
    r.get('ID_PEDIDO')?.trim() === idPedido.trim() &&
    r.get('LADO')?.trim()      === (lado === 'cliente' ? 'cliente' : 'domi') &&
    r.get('LEIDO')?.trim().toUpperCase() === 'SI' &&
    Number(r.get('MSG_ID'))    > lastIdNum - 50
  );

  const cincoMinAtras  = Date.now() - 5 * 60 * 1000;
  const otroLadoActivo = rows.some(r =>
    r.get('ID_PEDIDO')?.trim() === idPedido.trim() &&
    r.get('LADO')?.trim()      === ladoBuscar &&
    Number(r.get('MSG_ID'))    > cincoMinAtras / 1000
  );

  return {
    status: 200,
    data: {
      ok: true, mensajes: nuevos, leidos: leidosDelOtroLado,
      domiOnline:    lado === 'cliente' ? otroLadoActivo : undefined,
      clienteOnline: lado === 'domi'    ? otroLadoActivo : undefined,
      domiTyping:    false,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 11. CHAT — IMAGEN
// ════════════════════════════════════════════════════════════════════════════
async function chatImagen(body) {
  const { idPedido, hora, lado, imageBase64, cliente, telefono, idDomi } = body;
  if (!idPedido)
    return { status: 400, data: { ok: false, error: 'idPedido requerido' } };

  let urlFinal = '';
  if (imageBase64) {
    try {
      const cloudinaryPkg = await import('cloudinary');
      const cloudinary = cloudinaryPkg.v2;
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key:    process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
      const uploadResult = await cloudinary.uploader.upload(imageBase64, {
        folder: 'wil-chat', resource_type: 'auto',
      });
      urlFinal = uploadResult.secure_url;
    } catch(e) {
      return { status: 500, data: { ok: false, error: 'Error subiendo imagen: ' + e.message } };
    }
  }

  const sheet = await getSheet('Chat');
  const { hora: horaAhora, fecha } = ahora();
  const msgId = nextMsgId();

  await sheet.addRow({
    MSG_ID: String(msgId), ID_PEDIDO: idPedido, LADO: lado || 'domi',
    TEXTO: '📷 Imagen', HORA: hora || horaAhora, FECHA: fecha,
    LEIDO: 'NO', TIPO_ARCHIVO: 'imagen', URL_ARCHIVO: urlFinal,
    NOMBRE_CLI: cliente || '', TELEFONO_CLI: telefono || '', ID_DOMI: idDomi || '',
  });
  return { status: 200, data: { ok: true, msgId, url: urlFinal } };
}

// ════════════════════════════════════════════════════════════════════════════
// 12. CHAT — AUDIO
// ════════════════════════════════════════════════════════════════════════════
async function chatAudio(body) {
  const { idPedido, hora, lado, audioUrl, idDomi, cliente, telefono } = body;
  if (!idPedido)
    return { status: 400, data: { ok: false, error: 'idPedido requerido' } };

  const sheet = await getSheet('Chat');
  const { hora: horaAhora, fecha } = ahora();
  const msgId = nextMsgId();

  await sheet.addRow({
    MSG_ID: String(msgId), ID_PEDIDO: idPedido, LADO: lado || 'domi',
    TEXTO: '🎤 Audio', HORA: hora || horaAhora, FECHA: fecha,
    LEIDO: 'NO', TIPO_ARCHIVO: 'audio', URL_ARCHIVO: audioUrl || '',
    NOMBRE_CLI: cliente || '', TELEFONO_CLI: telefono || '', ID_DOMI: idDomi || '',
  });
  return { status: 200, data: { ok: true, msgId } };
}

// ════════════════════════════════════════════════════════════════════════════
// 13. UBICACIÓN EN TIEMPO REAL
// ════════════════════════════════════════════════════════════════════════════
const _domiLocations  = new Map();
const LOCATION_TTL_MS = 45_000;

async function domiLocation(body) {
  const { domiId, nombre, lat, lng } = body;
  if (!domiId || lat == null || lng == null)
    return { status: 400, data: { ok: false, error: 'domiId, lat y lng son requeridos' } };

  _domiLocations.set(String(domiId), {
    id:     String(domiId),
    nombre: nombre || `Domi ${domiId}`,
    lat:    Number(lat),
    lng:    Number(lng),
    ts:     Date.now(),
  });
  return { status: 200, data: { ok: true } };
}

// ════════════════════════════════════════════════════════════════════════════
// 14. DOMI-LOCATION-GET
// ════════════════════════════════════════════════════════════════════════════
async function domiLocationGet(query) {
  const { domiId } = query;
  if (!domiId)
    return { status: 400, data: { ok: false, error: 'domiId requerido' } };

  const loc = _domiLocations.get(String(domiId));
  if (!loc || Date.now() - loc.ts > LOCATION_TTL_MS)
    return { status: 200, data: { ok: false, error: 'Sin ubicación reciente' } };

  return { status: 200, data: { ok: true, lat: loc.lat, lng: loc.lng, ts: loc.ts } };
}

async function domisLive() {
  const ahoraMs = Date.now();
  const domis = [];
  for (const [, d] of _domiLocations) {
    if (ahoraMs - d.ts < LOCATION_TTL_MS)
      domis.push({ id: d.id, nombre: d.nombre, lat: d.lat, lng: d.lng, ts: d.ts });
  }
  return { status: 200, data: { ok: true, domis } };
}

// ════════════════════════════════════════════════════════════════════════════
// 15. TARIFA BARRIO
// ════════════════════════════════════════════════════════════════════════════
async function tarifaBarrio(query) {
  const { barrio } = query;
  if (!barrio)
    return { status: 400, data: { ok: false, error: 'barrio requerido' } };

  try {
    const sheet = await getSheet('Coordenadas');
    const rows  = await sheet.getRows();
    const nrm = s => (s||'').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9\s]/g,'').trim();
    const bNrm  = nrm(barrio);
    const found = rows.find(r => {
      const b = nrm(r.get('BARRIO')||r.get('barrio')||'');
      return b && bNrm.includes(b);
    });
    if (found) {
      const tarifa = Number(String(found.get('TARIFA')||found.get('tarifa')||'0').replace(/[^\d]/g,''));
      return { status: 200, data: { ok: true, tarifa, barrio: found.get('BARRIO')||found.get('barrio') } };
    }
    return { status: 200, data: { ok: true, tarifa: 8000, barrio: 'Copacabana (default)' } };
  } catch(e) {
    return { status: 200, data: { ok: true, tarifa: 8000, barrio: 'default' } };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  let result;

  try {
    if      (action === 'sheet-stock'          && req.method === 'GET')  result = await sheetStock(req.query);
    else if (action === 'rastrear'             && req.method === 'GET')  result = await rastrear(req.query);
    else if (action === 'pedidos-pendientes'   && req.method === 'GET')  result = await pedidosPendientes();
    else if (action === 'chat-poll'            && req.method === 'GET')  result = await chatPoll(req.query);
    else if (action === 'domis-live'           && req.method === 'GET')  result = await domisLive();
    else if (action === 'domi-location-get'    && req.method === 'GET')  result = await domiLocationGet(req.query);
    else if (action === 'historial-domi' && req.method === 'GET') result = await historialDomi(req.query);
    else if (action === 'tarifa-barrio'        && req.method === 'GET')  result = await tarifaBarrio(req.query);
    else if (action === 'pedido-web'           && req.method === 'POST') result = await pedidoWeb(req.body);
    else if (action === 'pedido-farmacia'      && req.method === 'POST') result = await pedidoFarmacia(req.body);
    else if (action === 'tomar-pedido'         && req.method === 'POST') result = await tomarPedido(req.body);
    else if (action === 'domi-login'           && req.method === 'POST') result = await domiLogin(req.body);
    else if (action === 'cambiar-estado'       && req.method === 'POST') result = await cambiarEstado(req.body);
    else if (action === 'calificar'            && req.method === 'POST') result = await calificar(req.body);
    else if (action === 'chat-mensaje'         && req.method === 'POST') result = await chatMensaje(req.body);
    else if (action === 'chat-mensaje-cliente' && req.method === 'POST') result = await chatMensajeCliente(req.body);
    else if (action === 'chat-imagen'          && req.method === 'POST') result = await chatImagen(req.body);
    else if (action === 'chat-audio'           && req.method === 'POST') result = await chatAudio(req.body);
    else if (action === 'domi-location'        && req.method === 'POST') result = await domiLocation(req.body);
    else result = { status: 404, data: { ok: false, error: `Acción "${action}" no encontrada` } };
  } catch(e) {
    console.error('[wil.mjs]', e);
    result = { status: 500, data: { ok: false, error: e.message } };
  }

  return res.status(result.status).json(result.data);
}