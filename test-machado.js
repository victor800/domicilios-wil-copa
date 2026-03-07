require('dotenv').config();
const { obtenerTarifaRapida } = require('./bots/wilBot');

async function test() {
  const resultado = await obtenerTarifaRapida('Machado');
  console.log('RESULTADO:', JSON.stringify(resultado, null, 2));
  console.log('MENSAJE:', resultado.mensaje);
}

test();