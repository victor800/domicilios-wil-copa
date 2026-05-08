const https  = require("https");
const { google } = require("googleapis");
const moment = require("moment-timezone");
const fs     = require("fs");

// ─── CONFIG ──────────────────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.MONITOR_TOKEN;
const TELEGRAM_CHAT   = process.env.MONITOR_CHAT;
const APP_NAME        = process.env.APP_NAME || "DomiciliosWil";
const REPORT_INTERVAL = 60 * 60 * 1000;
const ALERT_COOLDOWN  = 30 * 1000;

// ─── SHEETS HABILITADO ────────────────────────────────────────
// Solo intenta usar Sheets si las credenciales están configuradas
const SHEETS_ENABLED = !!(process.env.GOOGLE_CREDENTIALS || fs.existsSync('./credentials.json'));

// ─── RUTAS SENSIBLES ─────────────────────────────────────────
const SENSITIVE_ROUTES = [
  "/panel-administrador", "/login-administrador", "/instalar.html",
  "/pedido-farmacia.html", "/pedido-wil.html", "/domi-login",
  "/api/admin", "/api/usuarios", "/api/pedidos",
  "/.env", "/wp-admin", "/phpmyadmin", "/.git",
];

// ─── RUTAS EXCLUIDAS DEL MONITOREO ───────────────────────────
const EXCLUDED_ROUTES = ["/api/health", "/favicon.ico"];

// ─── ESTADO INTERNO ──────────────────────────────────────────
const stats = {
  startTime: Date.now(), totalRequests: 0, apkDownloads: 0,
  suspiciousHits: 0, errors4xx: 0, errors5xx: 0,
  uniqueIPs: new Set(), blockedIPs: new Set(),
  lastAlerts: {}, ipHitMap: {}, routeHitMap: {},
};

// ─── GOOGLE SHEETS AUTH ──────────────────────────────────────
async function getSheetsClient() {
  if (!SHEETS_ENABLED) throw new Error('Sheets no configurado');

  let auth;
  if (process.env.GOOGLE_CREDENTIALS) {
    let creds;
    try {
      // Limpia saltos de línea literales que Vercel puede introducir,
      // pero preserva los \n dentro del private_key (ya escapados en JSON)
      const raw = process.env.GOOGLE_CREDENTIALS
        .replace(/\r?\n\s*/g, ' ')  // newlines literales → espacio
        .trim();
      creds = JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_CREDENTIALS no es un JSON válido — pégalo minificado en Vercel');
    }
    auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: './credentials.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ─── GUARDAR EVENTO EN SHEETS ────────────────────────────────
async function registrarEvento(ip, ruta, tipo, metodo, userAgent, prioridad) {
  if (!SHEETS_ENABLED) return; // Salir silenciosamente si no hay Sheets
  try {
    const sheets = await getSheetsClient();
    const ahora  = moment().tz('America/Bogota');
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Monitor!A:H',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          ahora.format('DD/MM/YYYY'),
          ahora.format('hh:mm:ss A'),
          ip, ruta, tipo, metodo,
          userAgent.substring(0, 100),
          prioridad,
        ]],
      },
    });
  } catch (e) {
    console.error('[Monitor] Error guardando en Sheets:', e.message);
  }
}

// ─── TELEGRAM ────────────────────────────────────────────────
function sendTelegram(message, priority = "normal") {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  const prefix = priority === "high" ? "🚨🚨🚨" : priority === "medium" ? "⚠️" : "ℹ️";
  const text   = `${prefix} *${APP_NAME}*\n\n${message}\n\n_${moment().tz('America/Bogota').format('DD/MM/YYYY hh:mm A')}_`;
  const body   = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: "Markdown" });
  const req    = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.on('error', () => {}); // Ignorar errores de red silenciosamente
  req.write(body);
  req.end();
}

// ─── COOLDOWN ────────────────────────────────────────────────
function canAlert(key) {
  const now  = Date.now();
  const last = stats.lastAlerts[key] || 0;
  if (now - last > ALERT_COOLDOWN) {
    stats.lastAlerts[key] = now;
    return true;
  }
  return false;
}

// ─── ANALIZAR REQUEST ────────────────────────────────────────
function analyzeRequest(req, res) {
  const ip        = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
                    || req.socket?.remoteAddress
                    || "unknown";
  const route     = req.url?.split("?")[0].toLowerCase() || "/";
  const userAgent = req.headers["user-agent"] || "";
  const method    = req.method || "GET";

  // No monitorear rutas internas
  if (EXCLUDED_ROUTES.includes(route)) return;

  stats.totalRequests++;
  stats.uniqueIPs.add(ip);

  if (!stats.ipHitMap[ip]) {
    stats.ipHitMap[ip] = { count: 0, firstSeen: Date.now(), routes: [] };
  }
  stats.ipHitMap[ip].count++;
  if (!stats.ipHitMap[ip].routes.includes(route)) {
    stats.ipHitMap[ip].routes.push(route);
  }
  stats.routeHitMap[route] = (stats.routeHitMap[route] || 0) + 1;

  // ── APK Download ──────────────────────────────────────────
  if (route.includes("app-release.apk")) {
    stats.apkDownloads++;
    if (canAlert("apk")) {
      registrarEvento(ip, route, 'DESCARGA_APK', method, userAgent, 'normal');
      sendTelegram(`📥 *Nueva descarga de APK*\n• IP: \`${ip}\`\n• Total: *${stats.apkDownloads}*`);
    }
  }

  // ── Rutas sensibles ───────────────────────────────────────
  const isSensitive = SENSITIVE_ROUTES.some(r => route.includes(r.toLowerCase()));
  if (isSensitive) {
    stats.suspiciousHits++;
    if (canAlert(`sensitive_${ip}`)) {
      registrarEvento(ip, route, 'RUTA_SENSIBLE', method, userAgent, 'medium');
      sendTelegram(
        `🔐 *Acceso a ruta sensible*\n• Ruta: \`${route}\`\n• IP: \`${ip}\`\n• Método: ${method}`,
        "medium"
      );
    }
  }

  // ── Bots / Scanners ───────────────────────────────────────
  // NOTA: "curl/" removido — era demasiado amplio y bloqueaba pruebas legítimas
  const botPatterns = ["sqlmap", "nikto", "masscan", "nmap", "zgrab", "dirbuster", "python-requests/2"];
  const isBot = botPatterns.some(b => userAgent.toLowerCase().includes(b));
  if (isBot && canAlert(`bot_${ip}`)) {
    stats.suspiciousHits++;
    registrarEvento(ip, route, 'SCANNER_BOT', method, userAgent, 'high');
    sendTelegram(
      `🤖 *Scanner / Bot detectado*\n• IP: \`${ip}\`\n• Agente: \`${userAgent.substring(0, 100)}\``,
      "high"
    );
  }

  // ── Fuerza bruta ──────────────────────────────────────────
  const ipData  = stats.ipHitMap[ip];
  const elapsed = (Date.now() - ipData.firstSeen) / 1000;
  if (ipData.count > 50 && elapsed < 60 && canAlert(`brute_${ip}`)) {
    stats.suspiciousHits++;
    registrarEvento(ip, route, 'FUERZA_BRUTA', method, userAgent, 'high');
    sendTelegram(
      `💥 *Posible fuerza bruta*\n• IP: \`${ip}\`\n• Hits: *${ipData.count}* en *${Math.round(elapsed)}s*`,
      "high"
    );
  }

  // ── Métodos inusuales ─────────────────────────────────────
  if (["DELETE", "PUT", "PATCH"].includes(method) && canAlert(`method_${ip}_${method}`)) {
    registrarEvento(ip, route, 'METODO_INUSUAL', method, userAgent, 'medium');
    sendTelegram(
      `🛠️ *Método inusual*\n• Método: \`${method}\`\n• Ruta: \`${route}\`\n• IP: \`${ip}\``,
      "medium"
    );
  }

  // ── Errores HTTP ──────────────────────────────────────────
  res.on("finish", () => {
    const code = res.statusCode;
    if (code >= 400 && code < 500) {
      stats.errors4xx++;
      if ((code === 401 || code === 403) && canAlert(`auth_${ip}`)) {
        registrarEvento(ip, route, `ERROR_${code}`, method, userAgent, 'medium');
        sendTelegram(`🔒 *Acceso denegado (${code})*\n• Ruta: \`${route}\`\n• IP: \`${ip}\``, "medium");
      }
    }
    if (code >= 500) {
      stats.errors5xx++;
      if (canAlert(`server_error_${route}`)) {
        registrarEvento(ip, route, `ERROR_${code}`, method, userAgent, 'high');
        sendTelegram(
          `💀 *Error del servidor (${code})*\n• Ruta: \`${route}\`\n• IP: \`${ip}\``,
          "high"
        );
      }
    }
  });
}

// ─── MIDDLEWARE ───────────────────────────────────────────────
function monitorMiddleware(req, res, next) {
  try {
    analyzeRequest(req, res);
  } catch (e) {
    console.error('[Monitor] Error en analyzeRequest:', e.message);
  }
  next();
}

// ─── REPORTE PERIÓDICO ────────────────────────────────────────
function sendReport() {
  const uptime    = Math.round((Date.now() - stats.startTime) / 1000 / 60);
  const topIPs    = Object.entries(stats.ipHitMap)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([ip, d]) => `\`${ip}\` → ${d.count} hits`)
    .join("\n");
  const topRoutes = Object.entries(stats.routeHitMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([r, c]) => `\`${r}\` → ${c}`)
    .join("\n");

  sendTelegram(
    `📊 *Reporte de salud*\n\n` +
    `⏱ Uptime: *${uptime} min*\n` +
    `📡 Requests: *${stats.totalRequests}*\n` +
    `👥 IPs únicas: *${stats.uniqueIPs.size}*\n` +
    `📥 APK descargas: *${stats.apkDownloads}*\n` +
    `🚨 Hits sospechosos: *${stats.suspiciousHits}*\n` +
    `⚠️ Errores 4xx: *${stats.errors4xx}*\n` +
    `💀 Errores 5xx: *${stats.errors5xx}*\n\n` +
    `🔝 *Top IPs:*\n${topIPs || "—"}\n\n` +
    `🔝 *Rutas más visitadas:*\n${topRoutes || "—"}`
  );
}

// ─── ARRANQUE ─────────────────────────────────────────────────
function startMonitor() {
  console.log(`[Monitor] ✅ Monitoreo activo | Sheets: ${SHEETS_ENABLED ? 'ON' : 'OFF (sin credenciales)'}`);
  sendTelegram(`🟢 *Servidor iniciado*\nMonitoreo activo para *${APP_NAME}*`);
  setInterval(sendReport, REPORT_INTERVAL);

  process.on("uncaughtException", err => {
    console.error('[Monitor] uncaughtException:', err);
    sendTelegram(`💥 *Error crítico*\n\`\`\`\n${err.message}\n\`\`\``, "high");
  });
  process.on("unhandledRejection", reason => {
    sendTelegram(`⛔ *Promise rechazada*\n\`\`\`\n${String(reason).substring(0, 200)}\n\`\`\``, "high");
  });
  process.on("SIGTERM", () => sendTelegram(`🔴 *Servidor detenido (SIGTERM)*`, "high"));
}

module.exports = { monitorMiddleware, startMonitor, sendTelegram, stats };