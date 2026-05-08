const { sendTelegram, stats } = require('../domicilios-wil/services/monitor');

module.exports = (req, res) => {
  sendTelegram(
    `📊 *Reporte de salud*\n\n` +
    `📡 Requests: *${stats.totalRequests}*\n` +
    `👥 IPs únicas: *${stats.uniqueIPs.size}*\n` +
    `🚨 Hits sospechosos: *${stats.suspiciousHits}*\n` +
    `⚠️ Errores 4xx: *${stats.errors4xx}*\n` +
    `💀 Errores 5xx: *${stats.errors5xx}*\n` +
    `📥 Descargas APK: *${stats.apkDownloads}*`
  );

  res.json({ ok: true });
};
