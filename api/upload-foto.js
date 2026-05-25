import Busboy from 'busboy'

// Vercel necesita que deshabilites el body parser por defecto para subida de archivos
export const config = {
  api: { bodyParser: false },
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Método no permitido' })

  return new Promise((resolve) => {
    const busboy = Busboy({
      headers: req.headers,
      limits:  { fileSize: 5 * 1024 * 1024 }, // 5 MB máx
    })

    let fileBuffer = null
    let mimeType   = 'image/jpeg'

    busboy.on('file', (_field, file, info) => {
      mimeType = info.mimeType || 'image/jpeg'
      const chunks = []
      file.on('data',  (chunk) => chunks.push(chunk))
      file.on('end',   ()      => { fileBuffer = Buffer.concat(chunks) })
      file.on('limit', ()      => {
        res.status(413).json({ ok: false, error: 'Imagen demasiado grande (máx 5 MB)' })
        resolve()
      })
    })

    busboy.on('finish', () => {
      if (!fileBuffer) {
        res.status(400).json({ ok: false, error: 'No se recibió ningún archivo' })
        return resolve()
      }

      // Guardamos como data-URL para no depender de almacenamiento externo
      const base64  = fileBuffer.toString('base64')
      const dataUrl = `data:${mimeType};base64,${base64}`

      res.status(200).json({ ok: true, url: dataUrl })
      resolve()
    })

    busboy.on('error', (err) => {
      console.error('[upload-foto]', err.message)
      res.status(500).json({ ok: false, error: err.message })
      resolve()
    })

    req.pipe(busboy)
  })
}