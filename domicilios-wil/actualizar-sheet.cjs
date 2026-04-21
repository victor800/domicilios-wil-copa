/**
 * ══════════════════════════════════════════════════════════════════
 *  WIL — Llenar columna F (Imagen) en Google Sheet
 * ══════════════════════════════════════════════════════════════════
 *  Correr DESPUÉS de renombrar-imagenes.cjs
 *  Usa las variables GOOGLE_SERVICE_ACCOUNT_EMAIL y GOOGLE_PRIVATE_KEY del .env
 *
 *  node actualizar-sheet.cjs
 * ══════════════════════════════════════════════════════════════════
 */

const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');

// ── Cargar .env manualmente (sin dotenv) ────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx < 0) return;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (k) process.env[k] = v;
  });
}

// ── CONFIG ───────────────────────────────────────────────────────
const SHEET_ID = '1-pX8D71WTt9e8SYPHt_gVxBRvbjBUyDqb5XWRRPGUUU';
const TABS     = ['STOCK_DROGUERIA_CENTRAL', 'STOCK_DROGUERIA_EXPERTOS'];
const COL_DESC = 0;  // columna A = Descripción
const COL_IMG  = 5;  // columna F = Imagen (índice 5)
const CARPETA  = path.join(__dirname, 'public', 'imagenes-app');
// ────────────────────────────────────────────────────────────────

function nrm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = a[i-1] === b[j-1]
        ? d[i-1][j-1]
        : 1 + Math.min(d[i-1][j], d[i][j-1], d[i-1][j-1]);
  return d[m][n];
}

function score(desc, imgNombre) {
  const d  = nrm(desc);
  const im = nrm(imgNombre.replace(/[-_]/g, ' ').replace(/\.\w+$/, ''));
  if (!d || !im) return 0;
  if (d === im) return 100;
  if (d.includes(im) || im.includes(d)) return 92;
  const wordsDesc = d.split(' ').filter(w => w.length > 2);
  const wordsImg  = im.split(' ').filter(w => w.length > 2);
  if (!wordsDesc.length || !wordsImg.length) return 0;
  const hits = wordsDesc.filter(w => wordsImg.some(wi => wi.includes(w) || w.includes(wi)));
  const pct  = hits.length / Math.max(wordsDesc.length, wordsImg.length);
  if (pct >= 0.6) return Math.round(pct * 85);
  const sd     = wordsDesc.slice(0, 3).join(' ');
  const sim_im = wordsImg.slice(0, 3).join(' ');
  const sim = 1 - lev(sd, sim_im) / Math.max(sd.length, sim_im.length, 1);
  if (sim > 0.65) return Math.round(sim * 70);
  return 0;
}

function mejorMatch(desc, listaImagenes) {
  let mejor = null, mejorScore = 0;
  for (const img of listaImagenes) {
    const s = score(desc, img);
    if (s > mejorScore) { mejorScore = s; mejor = img; }
  }
  return mejorScore >= 50 ? { archivo: mejor, score: mejorScore } : null;
}

async function main() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    console.error(`
❌  Faltan variables de entorno:
    GOOGLE_SERVICE_ACCOUNT_EMAIL  → ${clientEmail ? '✅' : '❌ falta'}
    GOOGLE_PRIVATE_KEY   → ${privateKey  ? '✅' : '❌ falta'}

Verifica que tu archivo .env tenga esas dos variables.
`);
    process.exit(1);
  }

  if (!fs.existsSync(CARPETA)) {
    console.error(`❌  Carpeta no encontrada: ${CARPETA}`);
    process.exit(1);
  }

  const EXTENSIONES     = ['.jpg', '.jpeg', '.png', '.webp'];
  const imagenes        = fs.readdirSync(CARPETA).filter(f => EXTENSIONES.includes(path.extname(f).toLowerCase()));
  const imagenesValidas = imagenes.filter(f => !f.startsWith('sin-texto_'));

  console.log(`\n📁  ${imagenes.length} imágenes en carpeta`);
  console.log(`✅  ${imagenesValidas.length} con nombre útil para match\n`);

  if (!imagenesValidas.length) {
    console.error('❌  No hay imágenes renombradas. Corre primero renombrar-imagenes.cjs');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key:  privateKey,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  let totalActualizados = 0;
  let totalSinMatch     = 0;

  for (const tab of TABS) {
    console.log(`\n📊  Procesando pestaña: ${tab}`);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A:F`,
    });

    const filas = res.data.values || [];
    if (filas.length < 2) { console.log(`   ⚠️  Pestaña vacía`); continue; }

    const updates = [];

    for (let i = 1; i < filas.length; i++) {
      const fila      = filas[i];
      const desc      = (fila[COL_DESC] || '').trim();
      const imgActual = (fila[COL_IMG]  || '').trim();
      if (!desc)     continue;
      if (imgActual) continue;
      const match = mejorMatch(desc, imagenesValidas);
      if (match) {
        updates.push({ row: i + 1, nombre: match.archivo, score: match.score, desc });
        process.stdout.write(`   ✅ [${i+1}] "${desc}" → ${match.archivo} (${match.score}%)\n`);
        totalActualizados++;
      } else {
        process.stdout.write(`   ⚪ [${i+1}] "${desc}" → sin match\n`);
        totalSinMatch++;
      }
    }

    if (!updates.length) { console.log(`   ℹ️  Nada que actualizar`); continue; }

    const LOTE = 100;
    for (let i = 0; i < updates.length; i += LOTE) {
      const lote = updates.slice(i, i + LOTE);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: lote.map(u => ({ range: `${tab}!F${u.row}`, values: [[u.nombre]] })),
        },
      });
      console.log(`   💾 Guardado lote: filas ${lote[0].row}–${lote[lote.length-1].row}`);
    }
  }

  console.log(`
══════════════════════════════════════════
  ✅  Productos actualizados: ${totalActualizados}
  ⚪  Sin imagen encontrada:  ${totalSinMatch}
══════════════════════════════════════════

Columna F lista. En farmacias.html reemplaza el ícono por:

  var imgSrc = it.imagen ? '/imagenes-app/' + it.imagen : null;
  imgSrc
    ? '<img src="'+imgSrc+'" style="width:100%;height:100%;object-fit:contain;padding:6px">'
    : '<span class="sym" style="font-size:42px;color:var(--blue)">'+icon+'</span>'
`);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});