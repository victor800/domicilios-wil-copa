// test-monitor.js
require('dotenv').config(); // carga tu .env local

const { sendReport, sendTelegram, stats } = require('./domicilios-wil/services/monitor');

console.log('=== Variables de entorno ===');
console.log('MONITOR_TOKEN:', process.env.MONITOR_TOKEN ? '✅ definido' : '❌ falta');
console.log('MONITOR_CHAT: ', process.env.MONITOR_CHAT  ? '✅ definido' : '❌ falta');
console.log('HEALTH_SECRET:', process.env.HEALTH_SECRET ? '✅ definido' : '❌ falta');
console.log('GOOGLE_CREDS: ', process.env.GOOGLE_CREDENTIALS ? '✅ definido' : '⚠️ no configurado (opcional)');

console.log('\n=== Enviando reporte de prueba ===');
sendReport();
console.log('✅ sendReport() ejecutado — revisa tu Telegram');