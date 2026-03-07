// services/leerFactura.js
// Lee el TOTAL de una factura/ticket usando Groq Vision (Llama 4 Scout)
const axios = require('axios');

/**
 * Descarga foto de Telegram y usa Groq Vision para extraer el total.
 * @param {string} fileId   - file_id de Telegram
 * @param {string} botToken - token del bot
 * @returns {{ ok: boolean, total: number|null, raw: string, error: string|null }}
 */
async function leerTotalFactura(fileId, botToken) {
  try {
    // 1. Obtener ruta del archivo en Telegram
    const infoRes = await axios.get(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
      { timeout: 10000 }
    );
    const filePath = infoRes.data?.result?.file_path;
    if (!filePath) return { ok: false, total: null, raw: '', error: 'No se pudo obtener la ruta del archivo' };

    // 2. Descargar imagen
    const imgRes = await axios.get(
      `https://api.telegram.org/file/bot${botToken}/${filePath}`,
      { responseType: 'arraybuffer', timeout: 15000 }
    );
    const base64   = Buffer.from(imgRes.data).toString('base64');
    const mimeType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

    // 3. Llamar a Groq Vision
    const groqRes = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model:       'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens:  100,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` }
            },
            {
              type: 'text',
              text:
                'Eres un lector de facturas de tienda.\n' +
                'Analiza este ticket o factura de compra.\n' +
                'Busca el valor TOTAL final (puede decir: TOTAL, Total a pagar, Gran Total, Valor Total, NETO, SUBTOTAL si no hay otro).\n' +
                'Responde UNICAMENTE con el numero entero, sin puntos de miles, sin comas, sin signo de moneda.\n' +
                'Solo el numero. Ejemplos:\n' +
                '- Si dice $87.500 → responde: 87500\n' +
                '- Si dice 123,000 → responde: 123000\n' +
                '- Si dice 45.200,00 → responde: 45200\n' +
                'Si hay varios valores toma el TOTAL al final de la factura.\n' +
                'Si no encuentras ningun total responde: 0'
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

    const raw    = (groqRes.data.choices?.[0]?.message?.content || '0').trim();
    const numero = parseInt(raw.replace(/[^0-9]/g, ''), 10);

    if (isNaN(numero) || numero <= 0) {
      return { ok: false, total: null, raw, error: 'No pude identificar el total en la imagen' };
    }

    return { ok: true, total: numero, raw, error: null };

  } catch(e) {
    console.error('leerTotalFactura error:', e.message);
    return { ok: false, total: null, raw: '', error: `Error IA: ${e.message}` };
  }
}

module.exports = { leerTotalFactura };