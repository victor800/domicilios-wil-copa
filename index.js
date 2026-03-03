require('dotenv').config();
const { inicializar }   = require('./src/services/sheets');
const { wilBot, iniciarCron } = require('./src/bot/wilBot');

async function main() {
  console.log('\n🛵 ================================');
  console.log('🛵   DOMICILIOS WIL — INICIANDO   ');
  console.log('🛵 ================================\n');

  // Inicializar Sheets (crea hojas si no existen)
  console.log('📋 Verificando Google Sheets...');
  await inicializar().catch(e => {
    console.error('⚠️  Sheets:', e.message);
    console.error('   Verifica credentials.json y GOOGLE_SHEETS_ID\n');
  });

  // Lanzar bot único
  if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'pon_tu_token_aqui') {
    console.error('❌ Falta BOT_TOKEN en el archivo .env');
    process.exit(1);
  }

  await wilBot.launch();
  console.log('✅ Bot WIL: ACTIVO');

  // Recordatorios automáticos
  iniciarCron();

  console.log('\n🛵 ================================');
  console.log('   Bot corriendo 🚀');
  console.log('🛵 ================================\n');
}

main();

process.once('SIGINT',  () => wilBot.stop('SIGINT'));
process.once('SIGTERM', () => wilBot.stop('SIGTERM'));