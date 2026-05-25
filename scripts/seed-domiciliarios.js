// scripts/seed-domiciliarios.js
// Ejecutar UNA SOLA VEZ: node seed-domiciliarios.js
// Requiere: npm install mongoose bcryptjs dotenv

import mongoose from 'mongoose'
import bcrypt   from 'bcryptjs'
import dotenv   from 'dotenv'
dotenv.config()

const URI    = process.env.MONGODB_URI
const DB     = process.env.DB_NAME || 'test'

if (!URI) { console.error('❌  MONGODB_URI no definida'); process.exit(1) }

// ── Schema mínimo (sin hooks, hasheamos manualmente abajo) ──────────────────
const DomSchema = new mongoose.Schema({
  idWil:    { type: String, required: true, unique: true, uppercase: true, trim: true },
  nombre:   { type: String, required: true },
  password: { type: String, required: true },
  rol:      { type: String, default: 'domiciliario' },
  tel:      { type: String, default: '' },
  foto:     { type: String, default: '' },
  activo:   { type: Boolean, default: true },
  ultimoAcceso: { type: Date },
}, { timestamps: true })

const Domiciliario = mongoose.model('Domiciliario', DomSchema, 'domiciliarios')

// ── Datos ───────────────────────────────────────────────────────────────────
const DOMICILIARIOS = [
  { idWil:'WIL-001', nombre:'Robin Orlan Mesa',          clave:'EJC37E', tel:'3215993214',  foto:'Robinson.jpeg'       },
  { idWil:'WIL-002', nombre:'Duvan Rodriguez',           clave:'LWI77C', tel:'3217759125',  foto:''                    },
  { idWil:'WIL-003', nombre:'Jhonatan Montoya',          clave:'TNH17F', tel:'3015781912',  foto:''                    },
  { idWil:'WIL-004', nombre:'Juan Felipe David',         clave:'HZO81H', tel:'3004826253',  foto:''                    },
  { idWil:'WIL-005', nombre:'Andrés Quintero',           clave:'PVK52F', tel:'3226607273',  foto:'Andres.jpeg'         },
  { idWil:'WIL-006', nombre:'Lina Maria Calle',          clave:'RIK50F', tel:'3246878776',  foto:''                    },
  { idWil:'WIL-007', nombre:'Stefania Giraldo Restrepo', clave:'HZO04H', tel:'3005374673',  foto:''                    },
  { idWil:'WIL-008', nombre:'Eduardo Tova',              clave:'JUX74G', tel:'3135997342',  foto:'Eduardo.jpeg'        },
  { idWil:'WIL-009', nombre:'Andrés Felipe Meneses',     clave:'VEH36H', tel:'3113044101',  foto:'AndrésMeneses.jpeg'  },
  { idWil:'WIL-010', nombre:'Jhon Blanco',               clave:'XNT85C', tel:'3226754892',  foto:'Jhon.jpeg'           },
  { idWil:'WIL-011', nombre:'Guillermo Henao',           clave:'JVS04G', tel:'3207491937',  foto:''                    },
  { idWil:'WIL-012', nombre:'Duban Ramirez',             clave:'YVY88F', tel:'3027675448',  foto:''                    },
  { idWil:'WIL-013', nombre:'Carlos Humberto Mejia',     clave:'DRX18E', tel:'3153137324',  foto:''                    },
  { idWil:'WIL-014', nombre:'Santiago Alzate',           clave:'PVK95F', tel:'3202370772',  foto:'Santiago.jpeg'       },
  { idWil:'WIL-015', nombre:'Marvin Sanchez',            clave:'SFU98C', tel:'3217511471',  foto:''                    },
  { idWil:'WIL-016', nombre:'Will',                      clave:'LWV51C', tel:'3012198994',  foto:''                    },
  { idWil:'RHM',     nombre:'Hernan Munera',             clave:'2021',   tel:'3163090049',  foto:'Hernan.jpeg'         },
  { idWil:'WIL-018', nombre:'Sebastián Ortega',          clave:'WWJ43F', tel:'3155155826',  foto:''                    },
  { idWil:'WIL-019', nombre:'Paola Echeverri',           clave:'PVU17F', tel:'3217875174',  foto:''                    },
  { idWil:'WIL-020', nombre:'Andrés Rodríguez',          clave:'TPW76G', tel:'3145196986',  foto:'Andres.jpeg'         },
  { idWil:'WIL-021', nombre:'Luis Camilo Vanegas',       clave:'CEV16I', tel:'3205945736',  foto:''                    },
  { idWil:'WIL-022', nombre:'Eduard Arias',              clave:'XPX85H', tel:'3226536002',  foto:''                    },
  { idWil:'WIL-023', nombre:'Robinson Echeverri',        clave:'RAJ75F', tel:'3027127790',  foto:''                    },
  { idWil:'WIL-024', nombre:'Giovanny Suárez',           clave:'LVT67C', tel:'3242301700',  foto:''                    },
  { idWil:'WIL-025', nombre:'Luis Rodríguez',            clave:'XPC67H', tel:'3136488719',  foto:'Luis.jpeg'           },
  { idWil:'WIL-026', nombre:'Julián Usuga',              clave:'YWB88F', tel:'3006457064',  foto:'Julian.jpeg'         },
  { idWil:'WIL-027', nombre:'Emmanuel Gomez',            clave:'1234',   tel:'',            foto:'Emmanuel.jpeg'       },
]

// ── Seed ────────────────────────────────────────────────────────────────────
async function seed() {
  await mongoose.connect(URI, { dbName: DB, bufferCommands: false })
  console.log(`✅  Conectado → ${DB}`)

  let creados = 0, omitidos = 0

  for (const d of DOMICILIARIOS) {
    const existe = await Domiciliario.findOne({ idWil: d.idWil.toUpperCase() })
    if (existe) {
      console.log(`⚠️   Ya existe: ${d.idWil} — omitido`)
      omitidos++
      continue
    }

    const hash = await bcrypt.hash(d.clave, 12)
    await Domiciliario.create({
      idWil:    d.idWil,
      nombre:   d.nombre,
      password: hash,
      tel:      d.tel,
      foto:     d.foto,
      activo:   true,
    })
    console.log(`✔   Creado: ${d.idWil} — ${d.nombre}`)
    creados++
  }

  console.log(`\n🎉  Seed completo → ${creados} creados, ${omitidos} omitidos`)
  await mongoose.disconnect()
  process.exit(0)
}

seed().catch(err => {
  console.error('❌  Error:', err.message)
  process.exit(1)
})