const https = require('https');

module.exports = (req, res) => {
  const token = process.env.MONITOR_TOKEN;
  const chat  = process.env.MONITOR_CHAT;

  console.log('TOKEN:', token ? '✅' : '❌');
  console.log('CHAT:', chat ? '✅' : '❌');

  const text = '📊 Prueba de salud desde Vercel ✅';
  const body = JSON.stringify({ chat_id: chat, text, parse_mode: 'Markdown' });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };

  const req2 = https.request(options, (r) => {
    let data = '';
    r.on('data', d => data += d);
    r.on('end', () => {
      console.log('Telegram response:', data);
      res.json({ ok: true, telegram: data });
    });
  });
  req2.on('error', e => res.json({ ok: false, error: e.message }));
  req2.write(body);
  req2.end();
};
