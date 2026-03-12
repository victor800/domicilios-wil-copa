// services/leerFactura.js
// Lee el TOTAL de una factura/ticket usando Groq Vision (Llama 4 Scout)
const axios = require('axios');

/**
 * Extrae el mayor número plausible como monto colombiano de un texto libre.
 * Acepta: 87500 / 87.500 / $87.500 / 87,500
 */
function extraerMonto(texto) {
  if (!texto) return null;
  const candidatos = [];

  // Patrón 1: número con puntos de miles colombianos  →  87.500
  const p1 = /\b(\d{1,3}(?:\.\d{3})+)\b/g;
  let m;
  while ((m = p1.exec(texto)) !== null) {
    const n = parseInt(m[1].replace(/\./g, ''), 10);
    if (n >= 1000 && n <= 9_999_999) candidatos.push(n);
  }

  // Patrón 2: número plano sin formato  →  87500
  const p2 = /\b(\d{4,7})\b/g;
  while ((m = p2.exec(texto)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1000 && n <= 9_999_999) candidatos.push(n);
  }

  // Patrón 3: coma como separador de miles  →  87,500
  const p3 = /\b(\d{1,3}(?:,\d{3})+)\b/g;
  while ((m = p3.exec(texto)) !== null) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (n >= 1000 && n <= 9_999_999) candidatos.push(n);
  }

  if (!candidatos.length) return null;
  return Math.max(...candidatos);
}

/**
 * Descarga foto de Telegram y usa Groq Vision para extraer el total.
 * @param {string} fileId   - file_id de Telegram
 * @param {string} botToken - token del bot
 * @returns {{ ok: boolean, total: number|null, raw: string, confianza: string, error: string|null }}
 */
async function leerTotalFactura(fileId, botToken) {
  console.log(`\n📸 leerTotalFactura → fileId: ${fileId}`);
  try {
    // ── 1. Obtener ruta del archivo en Telegram ───────────────────────────
    const infoRes = await axios.get(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
      { timeout: 10000 }
    );
    const filePath = infoRes.data?.result?.file_path;
    if (!filePath) {
      console.error('   ❌ getFile: no file_path');
      return { ok: false, total: null, raw: '', confianza: 'nula', error: 'No se pudo obtener la ruta del archivo' };
    }
    console.log(`   ✅ file_path: ${filePath}`);

    // ── 2. Descargar imagen ───────────────────────────────────────────────
    const imgRes = await axios.get(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`,
      { responseType: 'arraybuffer', timeout: 15000 }
    );
    const base64   = Buffer.from(imgRes.data).toString('base64');
    const mimeType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    console.log(`   ✅ Imagen descargada: ${mimeType}, ${Math.round(base64.length * 0.75 / 1024)} KB`);

    // ── 3. Llamar a Groq Vision ───────────────────────────────────────────
    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens:  150,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' }
            },
            {
              type: 'text',
              text:
                'Eres un lector de facturas y comprobantes de pago colombianos.\n' +
                'Tu tarea: encontrar el valor TOTAL que se pagó.\n\n' +
                'Busca palabras clave: TOTAL, VALOR TOTAL, A PAGAR, MONTO, PAGASTE, NETO.\n' +
                'En Colombia los miles van con punto: $24.500 significa veinticuatro mil quinientos.\n' +
                'Si hay varios valores toma el TOTAL al final (suele ser el mayor).\n\n' +
                'RESPONDE SOLO en este formato de dos líneas:\n' +
                'TOTAL: [número entero sin puntos, comas ni símbolo $]\n' +
                'CONFIANZA: [alta|baja|nula]\n\n' +
                'Ejemplos de respuesta correcta:\n' +
                'TOTAL: 87500\n' +
                'CONFIANZA: alta\n\n' +
                'Si no encuentras total:\n' +
                'TOTAL: 0\n' +
                'CONFIANZA: nula'
            }
          ]
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type':  'application/json'
        },
        timeout: 30000
      }
    );

    const raw = (groqRes.data.choices?.[0]?.message?.content || '').trim();
    console.log(`   🤖 Groq respuesta:\n${raw}`);

    // ── 4. Parsear respuesta estructurada ─────────────────────────────────
    const lineaTotal     = raw.match(/^TOTAL:\s*(.+)$/mi);
    const lineaConfianza = raw.match(/^CONFIANZA:\s*(.+)$/mi);
    const confianza      = (lineaConfianza?.[1] || '').trim().toLowerCase();

    let total = null;

    if (lineaTotal) {
      const soloNum = lineaTotal[1].replace(/[^\d]/g, '');
      const n = parseInt(soloNum, 10);
      if (!isNaN(n) && n >= 100 && n <= 9_999_999) total = n;
    }

    // Fallback: regex sobre toda la respuesta si el campo TOTAL falló o fue 0
    if (!total || total === 0) {
      console.log('   ⚠️  TOTAL: no parseó — intentando regex sobre respuesta');
      total = extraerMonto(raw);
    }

    console.log(`   💰 Total final: ${total !== null ? total : 'NO ENCONTRADO'} | confianza: ${confianza}`);

    if (!total || total === 0) {
      return { ok: false, total: null, raw, confianza: confianza || 'nula', error: 'No pude identificar el total en la imagen' };
    }

    return { ok: true, total, raw, confianza: confianza || 'baja', error: null };

  } catch (e) {
    console.error('leerTotalFactura error:', e.message);
    return { ok: false, total: null, raw: '', confianza: 'nula', error: `Error IA: ${e.message}` };
  }
}

module.exports = { leerTotalFactura };