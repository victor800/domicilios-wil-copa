// ============================================================
//  MONITOR DE SALUD - DOMICILIOS WIL
//  Archivo: services/monitor.js
//  Uso: require('./services/monitor') en tu server/index.js
// ============================================================

const https = require("https");

// ─── CONFIG ─────────────────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.MONITOR_TOKEN;
const TELEGRAM_CHAT   = process.env.MONITOR_CHAT;
const APP_NAME        = process.env.APP_NAME || "DomiciliosWil";
const REPORT_INTERVAL = 60 * 60 * 1000;            // Reporte cada 1 hora
const ALERT_COOLDOWN  = 30 * 1000;                 // Espera 30s entre alertas iguales

// ─── RUTAS SENSIBLES A VIGILAR ───────────────────────────────
const SENSITIVE_ROUTES = [
  "/panel-administrador",
  "/login-administrador",
  "/instalar.html",
  "/pedido-farmacia.html",
  "/pedido-wil.html",
  "/domi-login",
  "/api/admin",
  "/api/usuarios",
  "/api/pedidos",
  "/.env",
  "/wp-admin",           // bots WordPress — intrusos comunes
  "/phpMyAdmin",
  "/.git",
];

// ─── ESTADO INTERNO ──────────────────────────────────────────
const stats = {
  startTime      : Date.now(),
  totalRequests  : 0,
  apkDownloads   : 0,
  suspiciousHits : 0,
  errors4xx      : 0,
  errors5xx      : 0,
  uniqueIPs      : new Set(),
  blockedIPs     : new Set(),
  lastAlerts     : {},          // cooldown por tipo
  ipHitMap       : {},          // ip -> { count, firstSeen, routes[] }
  routeHitMap    : {},          // ruta -> count
};

// ─── TELEGRAM SENDER ─────────────────────────────────────────
function sendTelegram(message, priority = "normal") {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) {
    console.error("[Monitor] ❌ Faltan MONITOR_TOKEN o MONITOR_CHAT en .env");
    return;
  }
  const prefix = priority === "high" ? "🚨🚨🚨" : priority === "medium" ? "⚠️" : "ℹ️";
  const text   = `${prefix} *${APP_NAME}*\n\n${message}\n\n_${new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" })}_`;

  const body = JSON.stringify({
    chat_id    : TELEGRAM_CHAT,
    text,
    parse_mode : "Markdown",
  });

  const options = {
    hostname : "api.telegram.org",
    path     : `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method   : "POST",
    headers  : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) console.error(`[Monitor] Telegram error: ${res.statusCode}`);
  });
  req.on("error", (e) => console.error("[Monitor] Telegram send failed:", e.message));
  req.write(body);
  req.end();
}

// ─── COOLDOWN HELPER ─────────────────────────────────────────
function canAlert(key) {
  const now  = Date.now();
  const last = stats.lastAlerts[key] || 0;
  if (now - last > ALERT_COOLDOWN) {
    stats.lastAlerts[key] = now;
    return true;
  }
  return false;
}

// ─── ANALIZAR CADA REQUEST ───────────────────────────────────
function analyzeRequest(req, res) {
  const ip        = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const route     = req.url?.split("?")[0].toLowerCase() || "/";
  const userAgent = req.headers["user-agent"] || "";
  const method    = req.method || "GET";

  stats.totalRequests++;
  stats.uniqueIPs.add(ip);

  // Registrar hits por IP
  if (!stats.ipHitMap[ip]) stats.ipHitMap[ip] = { count: 0, firstSeen: Date.now(), routes: [] };
  stats.ipHitMap[ip].count++;
  if (!stats.ipHitMap[ip].routes.includes(route)) stats.ipHitMap[ip].routes.push(route);

  // Registrar hits por ruta
  stats.routeHitMap[route] = (stats.routeHitMap[route] || 0) + 1;

  // ── Descarga de APK ──────────────────────────────────────
  if (route.includes("app-release.apk")) {
    stats.apkDownloads++;
    if (canAlert("apk")) {
      sendTelegram(
        `📥 *Nueva descarga de APK*\n` +
        `• IP: \`${ip}\`\n` +
        `• Total descargas: *${stats.apkDownloads}*\n` +
        `• Agente: ${userAgent.substring(0, 80)}`
      );
    }
  }

  // ── Ruta sensible ────────────────────────────────────────
  const isSensitive = SENSITIVE_ROUTES.some((r) => route.includes(r.toLowerCase()));
  if (isSensitive) {
    stats.suspiciousHits++;
    if (canAlert(`sensitive_${ip}`)) {
      sendTelegram(
        `🔐 *Acceso a ruta sensible*\n` +
        `• Ruta: \`${route}\`\n` +
        `• IP: \`${ip}\`\n` +
        `• Método: ${method}\n` +
        `• Agente: ${userAgent.substring(0, 80)}`,
        "medium"
      );
    }
  }

  // ── Bots / Scanners conocidos ────────────────────────────
  const botPatterns = ["sqlmap", "nikto", "masscan", "nmap", "zgrab", "dirbuster", "python-requests/2", "curl/"];
  const isBot = botPatterns.some((b) => userAgent.toLowerCase().includes(b));
  if (isBot && canAlert(`bot_${ip}`)) {
    stats.suspiciousHits++;
    sendTelegram(
      `🤖 *Scanner / Bot detectado*\n` +
      `• IP: \`${ip}\`\n` +
      `• Agente: \`${userAgent.substring(0, 120)}\`\n` +
      `• Ruta: \`${route}\``,
      "high"
    );
  }

  // ── Fuerza bruta (misma IP, muchos hits rápido) ──────────
  const ipData = stats.ipHitMap[ip];
  const elapsed = (Date.now() - ipData.firstSeen) / 1000;  // segundos
  if (ipData.count > 50 && elapsed < 60 && canAlert(`brute_${ip}`)) {
    stats.suspiciousHits++;
    sendTelegram(
      `💥 *Posible fuerza bruta / flood*\n` +
      `• IP: \`${ip}\`\n` +
      `• Peticiones: *${ipData.count}* en *${Math.round(elapsed)}s*\n` +
      `• Rutas visitadas: ${ipData.routes.slice(0, 5).join(", ")}`,
      "high"
    );
  }

  // ── Métodos inusuales ────────────────────────────────────
  if (["DELETE", "PUT", "PATCH"].includes(method) && canAlert(`method_${ip}_${method}`)) {
    sendTelegram(
      `🛠️ *Método inusual recibido*\n` +
      `• Método: \`${method}\`\n` +
      `• Ruta: \`${route}\`\n` +
      `• IP: \`${ip}\``,
      "medium"
    );
  }

  // ── Capturar código de respuesta (via evento finish) ─────
  res.on("finish", () => {
    const code = res.statusCode;
    if (code >= 400 && code < 500) {
      stats.errors4xx++;
      if (code === 401 || code === 403) {
        if (canAlert(`auth_${ip}`)) {
          sendTelegram(
            `🔒 *Acceso denegado (${code})*\n` +
            `• Ruta: \`${route}\`\n` +
            `• IP: \`${ip}\`\n` +
            `• Intentos de esta IP: *${ipData.count}*`,
            "medium"
          );
        }
      }
    }
    if (code >= 500) {
      stats.errors5xx++;
      if (canAlert(`server_error_${route}`)) {
        sendTelegram(
          `💀 *Error del servidor (${code})*\n` +
          `• Ruta: \`${route}\`\n` +
          `• IP: \`${ip}\``,
          "high"
        );
      }
    }
  });
}

// ─── MIDDLEWARE PARA EXPRESS ──────────────────────────────────
function monitorMiddleware(req, res, next) {
  analyzeRequest(req, res);
  next();
}

// ─── REPORTE PERIÓDICO ────────────────────────────────────────
function sendReport() {
  const uptime  = Math.round((Date.now() - stats.startTime) / 1000 / 60);
  const topIPs  = Object.entries(stats.ipHitMap)
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
    `📡 Requests totales: *${stats.totalRequests}*\n` +
    `👥 IPs únicas: *${stats.uniqueIPs.size}*\n` +
    `📥 Descargas APK: *${stats.apkDownloads}*\n` +
    `🚨 Hits sospechosos: *${stats.suspiciousHits}*\n` +
    `⚠️ Errores 4xx: *${stats.errors4xx}*\n` +
    `💀 Errores 5xx: *${stats.errors5xx}*\n\n` +
    `🔝 *Top IPs:*\n${topIPs || "—"}\n\n` +
    `🔝 *Rutas más visitadas:*\n${topRoutes || "—"}`
  );
}

// ─── ARRANQUE ─────────────────────────────────────────────────
function startMonitor() {
  console.log("[Monitor] ✅ Monitoreo activo");
  sendTelegram(`🟢 *Servidor iniciado*\nMonitoreo activo para *${APP_NAME}*`, "normal");
  setInterval(sendReport, REPORT_INTERVAL);

  // Capturar crashes no manejados
  process.on("uncaughtException", (err) => {
    sendTelegram(`💥 *Error crítico (uncaughtException)*\n\`\`\`\n${err.message}\n\`\`\``, "high");
    console.error("[Monitor] uncaughtException:", err);
  });

  process.on("unhandledRejection", (reason) => {
    sendTelegram(`⛔ *Promise rechazada sin manejar*\n\`\`\`\n${String(reason).substring(0, 200)}\n\`\`\``, "high");
  });

  process.on("SIGTERM", () => {
    sendTelegram(`🔴 *Servidor detenido (SIGTERM)*`, "high");
  });
}

// TEST — bórralo después de probar
setTimeout(() => {
  console.log('[Monitor] Token:', TELEGRAM_TOKEN ? '✅ OK' : '❌ Vacío');
  console.log('[Monitor] Chat:', TELEGRAM_CHAT  ? '✅ OK' : '❌ Vacío');
  sendTelegram('🧪 Prueba de monitor — si ves esto funciona ✅');
}, 5000);

// ─── EXPORTS ──────────────────────────────────────────────────
module.exports = { monitorMiddleware, startMonitor, sendTelegram, stats };