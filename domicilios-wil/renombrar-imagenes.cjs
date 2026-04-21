/**
 * ══════════════════════════════════════════════════════════════════
 *  WIL — Renombrador automático de imágenes con OCR
 * ══════════════════════════════════════════════════════════════════
 *  INSTRUCCIONES:
 *  1. Pon este archivo en la raíz de tu proyecto (junto a package.json)
 *  2. Corre:  npm install tesseract.js sharp
 *  3. Pon las imágenes descargadas de Drive en:  icons/imagenes-app/
 *  4. Corre:  node renombrar-imagenes.js
 *  5. Las imágenes quedan renombradas en la misma carpeta
 * ══════════════════════════════════════════════════════════════════
 */

const { createWorker } = require('tesseract.js');
const sharp             = require('sharp');
const fs                = require('fs');
const path              = require('path');

// ── CONFIG ──────────────────────────────────────────────────────
const CARPETA_INPUT  = path.join(__dirname, 'public', 'imagenes-app');
const CARPETA_OUTPUT = path.join(__dirname, 'public', 'imagenes-app'); // misma carpeta
const LOG_FILE       = path.join(__dirname, 'renombrado-log.json');   // guarda resultados
const EXTENSIONES    = ['.jpg', '.jpeg', '.png', '.webp'];
// ────────────────────────────────────────────────────────────────

/**
 * Normaliza texto: minúsculas, sin tildes, sin chars raros
 * Se usa para generar el nombre del archivo
 */
function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita tildes
    .replace(/[^\w\s-]/g, ' ')         // quita símbolos raros
    .replace(/\s+/g, '-')              // espacios → guiones
    .replace(/-+/g, '-')               // guiones dobles → uno
    .replace(/^-|-$/g, '')             // quita guiones al inicio/fin
    .substring(0, 80);                 // máx 80 caracteres
}

/**
 * De todo el texto OCR, extrae las palabras más relevantes
 * Prioriza líneas con nombres de marca/producto
 */
function extraerNombreProducto(textoOCR) {
  if (!textoOCR || textoOCR.trim().length < 2) return null;

  const lineas = textoOCR
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 2);       // descarta líneas muy cortas

  if (!lineas.length) return null;

  // Tomar las primeras 3 líneas con contenido (suelen ser la marca/nombre)
  const candidatas = lineas.slice(0, 3).join(' ');
  const nombre = normalizar(candidatas);
  return nombre.length > 3 ? nombre : null;
}

/**
 * Pre-procesa la imagen para mejorar el OCR:
 * escala a 1200px de ancho, convierte a escala de grises
 */
async function preprocesar(rutaImg) {
  const tmpRuta = rutaImg + '_tmp_ocr.png';
  await sharp(rutaImg)
    .resize({ width: 1200, withoutEnlargement: true })
    .grayscale()
    .toFile(tmpRuta);
  return tmpRuta;
}

/**
 * Genera nombre de archivo único — si ya existe agrega sufijo _2, _3…
 */
function nombreUnico(carpeta, nombreBase, ext) {
  let candidato = path.join(carpeta, nombreBase + ext);
  let contador  = 2;
  while (fs.existsSync(candidato)) {
    candidato = path.join(carpeta, `${nombreBase}_${contador}${ext}`);
    contador++;
  }
  return candidato;
}

// ── MAIN ────────────────────────────────────────────────────────
async function main() {
  // Verificar carpeta
  if (!fs.existsSync(CARPETA_INPUT)) {
    console.error(`\n❌  Carpeta no encontrada: ${CARPETA_INPUT}`);
    console.error(`   Crea la carpeta y pon las imágenes ahí primero.\n`);
    process.exit(1);
  }

  // Listar imágenes
  const archivos = fs.readdirSync(CARPETA_INPUT).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return EXTENSIONES.includes(ext);
  });

  if (!archivos.length) {
    console.error(`\n❌  No hay imágenes en ${CARPETA_INPUT}\n`);
    process.exit(1);
  }

  console.log(`\n🔍  Encontradas ${archivos.length} imágenes en ${CARPETA_INPUT}`);
  console.log(`⏳  Iniciando OCR... (esto puede tardar varios minutos)\n`);

  // Iniciar worker de Tesseract con español + inglés
  const worker = await createWorker('spa+eng');

  const log        = [];  // registro completo
  let   renombrados = 0;
  let   sinTexto    = 0;
  let   errores     = 0;

  for (let i = 0; i < archivos.length; i++) {
    const archivo   = archivos[i];
    const ext       = path.extname(archivo).toLowerCase();
    const rutaOrig  = path.join(CARPETA_INPUT, archivo);

    process.stdout.write(`[${i + 1}/${archivos.length}] ${archivo} → `);

    let tmpRuta = null;
    try {
      // Pre-procesar para mejor OCR
      tmpRuta = await preprocesar(rutaOrig);

      // Correr OCR
      const { data: { text } } = await worker.recognize(tmpRuta);

      // Extraer nombre del producto
      const nombreProducto = extraerNombreProducto(text);

      if (!nombreProducto) {
        // No se detectó texto útil — dejar con nombre original pero con prefijo
        const nuevoNombre = path.join(CARPETA_OUTPUT, `sin-texto_${archivo}`);
        fs.renameSync(rutaOrig, nuevoNombre);
        console.log(`⚠️  sin texto útil → sin-texto_${archivo}`);
        sinTexto++;
        log.push({ original: archivo, nuevo: `sin-texto_${archivo}`, textoOCR: text.trim(), estado: 'sin_texto' });
      } else {
        // Renombrar con el nombre detectado
        const rutaNueva  = nombreUnico(CARPETA_OUTPUT, nombreProducto, ext);
        const nuevoNombre = path.basename(rutaNueva);
        fs.renameSync(rutaOrig, rutaNueva);
        console.log(`✅  ${nuevoNombre}`);
        renombrados++;
        log.push({ original: archivo, nuevo: nuevoNombre, textoOCR: text.trim().substring(0, 150), estado: 'ok' });
      }
    } catch (err) {
      console.log(`❌  ERROR: ${err.message}`);
      errores++;
      log.push({ original: archivo, nuevo: null, error: err.message, estado: 'error' });
    } finally {
      // Limpiar imagen temporal
      if (tmpRuta && fs.existsSync(tmpRuta)) {
        try { fs.unlinkSync(tmpRuta); } catch (_) {}
      }
    }
  }

  await worker.terminate();

  // Guardar log
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');

  console.log(`
══════════════════════════════════════════
  ✅  Renombrados con texto:  ${renombrados}
  ⚠️   Sin texto detectable:  ${sinTexto}
  ❌  Errores:                ${errores}
  📋  Log guardado en:        renombrado-log.json
══════════════════════════════════════════

Próximo paso:
  node actualizar-sheet.js
para llenar la columna F del Google Sheet automáticamente.
`);
}

main().catch(err => {
  console.error('\n❌ Error fatal:', err.message);
  process.exit(1);
});