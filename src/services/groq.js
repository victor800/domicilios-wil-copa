
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// Extrae productos y cantidades de texto libre en español colombiano
// Retorna: [{ cantidad: 2, descripcion: "aceite 3L" }, ...]
// ─────────────────────────────────────────────────────────────────────────────
async function extraerProductosIA(texto) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: `Eres un asistente de una tienda de domicilios en Colombia. 
Tu única tarea es extraer productos y cantidades de mensajes de clientes.

REGLAS:
- Responde SOLO con JSON válido, sin explicaciones ni texto extra
- Si no hay cantidad explícita, usa 1
- Normaliza números escritos: "dos"→2, "tres"→3, "un"→1, "una"→1, etc.
- Ignora palabras como: tráigame, mándeme, necesito, quiero, por favor, favor
- Si el mensaje es muy vago como "lo de siempre" o "el mercado", retorna lista vacía
- El campo "descripcion" debe ser el nombre del producto limpio

FORMATO DE RESPUESTA (solo esto, nada más):
{"productos": [{"cantidad": 2, "descripcion": "aceite 3L"}, {"cantidad": 1, "descripcion": "arroz Diana 500g"}]}`
        },
        {
          role: 'user',
          content: texto
        }
      ]
    });

    const respuesta = completion.choices[0]?.message?.content || '{"productos":[]}';

    // Limpiar posibles backticks o markdown
    const limpio = respuesta.replace(/```json|```/g, '').trim();
    const data   = JSON.parse(limpio);

    if (!Array.isArray(data.productos)) return [];

    return data.productos
      .filter(p => p.descripcion && p.descripcion.trim().length > 1)
      .map(p => ({
        cantidad:       parseInt(p.cantidad) || 1,
        descripcion:    p.descripcion.trim(),
        precioUnitario: 0,
        subtotal:       0
      }));

  } catch(e) {
    console.error('Groq error:', e.message);
    // Fallback: guardar texto completo como un ítem
    return [{ cantidad: 1, descripcion: texto, precioUnitario: 0, subtotal: 0 }];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecta si el mensaje tiene intención de hacer un pedido
// ─────────────────────────────────────────────────────────────────────────────
async function detectarIntencion(texto) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0,
      max_tokens: 10,
      messages: [
        {
          role: 'system',
          content: `Detecta si el mensaje es una intención de hacer un pedido a domicilio.
Responde SOLO con: SI o NO`
        },
        {
          role: 'user',
          content: texto
        }
      ]
    });

    const r = (completion.choices[0]?.message?.content || 'NO').trim().toUpperCase();
    return r.includes('SI') || r.includes('SÍ');
  } catch(e) {
    return false;
  }
}

module.exports = { extraerProductosIA, detectarIntencion };