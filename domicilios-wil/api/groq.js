// api/groq.js (Este archivo SÍ puede leer process.env)
export default async function handler(req, res) {
  const { prompt } = req.body;
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_KEY}`, // Aquí sí funciona
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json();
  res.status(200).json(data);
}