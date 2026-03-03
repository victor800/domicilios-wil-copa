

const TARIFAS = {
  5000:  ['ASUNCION','FÁTIMA','MIRADOR AZUL','AZULITA PARTE BAJA','CRISTO REY ABAJO DE LA PISCINA','HORIZONTES','MIRAFLORES','MISERICORDIA HASTA PRINCESS','MOJÓN','OBRERO','PEDREGAL PARTE BAJA','PEDRERA','SAN FRANCISCO','SHANGAY','SIMÓN BOLÍVAR','TOBÓN QUINTERO','VEGAS PARTE BAJA','MONTE VERDE','REMANSO','DE LA ASUNCIÓN A LA ASUNCIÓN','YARUMITO PARTE BAJA','CANOAS HASTA LA TIENDA DEL CUSCO','PIEDRAS BLANCAS','PORVENIR','RECREO','DE LA PEDRERA A LA PEDRERA'],
  6000:  ['CALORCOL','AZULITA PARTE ALTA','VILLAS DE COPACABANA','TABLAZO','CANOAS DESPUÉS DE LA TIENDA DEL CUSCO','CRISTO REY DE LA PISCINA HACIA ARRIBA','PEDREGAL PARTE ALTA','COLINAS DEL PEDREGAL','VEGAS INTERIORES IGLESIA MANANTIALES','YARUMITO DESPUÉS DEL EMPEDRADO','YARUMITO INTERIOR CANCHA NUEVA','VEGAS PARTE ALTA','EDIFICIOS AMARILLOS','MONTESION','JARDÍN DE LA MARGARITA','RESERVAS DE SAN JUAN 1','POSADA DEL VIENTO','ROSA DE LOS VIENTOS','VICENZA','RESERVAS DE SAN JUAN 2'],
  7000:  ['BARRIO MARIA','PORTERIA PARCELACIÓN EL PARAISO','TORRE DEL BOSQUE','EDIFICIO POBLADO NORTE','SAN JUAN CAMPESTRE'],
  8000:  ['VIA MACHADO','CANTERAS','VILLANUEVA PARTE BAJA Y ALTA','VILLA ROCA','SAN JUAN'],
  10000: ['GUASIMALITO','MACHADO'],
  11000: ['UNIDADES DE MACHADO','ARBOLEDA DEL CAMPO'],
  13000: ['FONTIDUEÑO'],
  14000: ['NAVARRA','NIQUIA PARTE BAJA','UNIDADES DE NAVARRA'],
  17000: ['PARQUE DE GIRARDOTA','TOLEDO CAMPESTRE'],
  18000: ['PARQUE DE BELLO'],
  19000: ['FABRICATO'],
  20000: ['UNIDADES DE MADERA']
};

function obtenerPrecio(texto) {
  const t = (texto||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  for (const [precio, barrios] of Object.entries(TARIFAS)) {
    for (const b of barrios) {
      const bn = b.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      if (t.includes(bn)) return parseInt(precio);
    }
  }
  return null;
}

function tarifasTexto() {
  const sorted = Object.keys(TARIFAS).map(Number).sort((a,b)=>a-b);
  let txt = `💲 *TARIFAS DOMICILIOS WIL 2026*\n📍 Copacabana, Antioquia\n\n`;
  for (const p of sorted) {
    const lista = TARIFAS[p];
    txt += `💰 *$${p.toLocaleString('es-CO')}:*\n`;
    txt += lista.slice(0,4).map(b=>`  • ${b}`).join('\n');
    if (lista.length > 4) txt += `\n  _...y ${lista.length-4} más_`;
    txt += '\n\n';
    if (txt.length > 3500) { txt += '_Ver más zonas consultando con nosotros_\n'; break; }
  }
  txt += `⚠️ _Zonas no listadas se cotizan directamente_`;
  return txt;
}

module.exports = { obtenerPrecio, tarifasTexto };