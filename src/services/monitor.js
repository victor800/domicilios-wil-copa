// services/monitor.js

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

// Estado compartido en memoria (por instancia de servidor)
export const stats = {
  totalRequests: 0,
  uniqueIPs: new Set(),
  suspiciousHits: 0,
  errors4xx: 0,
  errors5xx: 0,
  apkDownloads: 0,
}

/**
 * Envía un mensaje a Telegram vía Bot API
 * @param {string} text  Texto con formato Markdown
 */
export async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[Monitor] TELEGRAM_TOKEN o TELEGRAM_CHAT_ID no configurados')
    return
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Telegram API error ${res.status}: ${body}`)
  }
}