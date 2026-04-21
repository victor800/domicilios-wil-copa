// api/extraer-productos.js
// POST /api/extraer-productos
// Body: { texto }
// Solo para pedidos WIL general (no farmacias)
// Extrae productos de texto libre con Groq IA

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Parser local de respaldo (sin IA)
function parsearLocal(texto) {
  return texto
    .split(/,|\sy\s|\s\+\s/)
    .map(s => s.trim()).filter(Boolean)
    .map(parte => {
      const m = parte.match(/^(\d+)\s+(.+)$/i);
      return m
        ? { descripcion: m[2].trim(), cantidad: parseInt(m[1]), precioUnitario: 0, subtotal: 0 }
        : { descripcion: parte, cantidad: 1, precioUnitario: 0, subtotal: 0 };
    });
}

async function extraerConGroq(texto) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const prompt = `Extrae los productos de este pedido y responde SOLO con JSON válido, sin texto adicional, sin markdown.
Formato: [{"descripcion":"nombre del producto","cantidad":1}]
Pedido: "${texto}"`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.1,
      }),
    });

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const items = JSON.parse(clean);

    if (Array.isArray(items) && items.length > 0) {
      return items.map(i => ({
        descripcion:    String(i.descripcion || i.nombre || '').trim(),
        cantidad:       parseInt(i.cantidad) || 1,
        precioUnitario: 0,
        subtotal:       0,
      })).filter(i => i.descripcion);
    }
  } catch (e) {
    console.warn('Groq error:', e.message);
  }
  return null;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ error: 'Falta texto' });

  // Intentar con IA
  const iaItems = await extraerConGroq(texto);
  if (iaItems?.length) {
    return res.status(200).json({ ok: true, productos: iaItems, fuente: 'ia' });
  }

  // Fallback: parser local
  const localItems = parsearLocal(texto);
  return res.status(200).json({ ok: true, productos: localItems, fuente: 'local' });
};