"use strict";

// ── Dependencies (run: npm i bcryptjs jsonwebtoken cookie-parser) ─────────────
const { Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits } = require("discord.js");
const express      = require("express");
const path         = require("path");
const { v4: uuidv4 } = require("uuid");
const bcrypt       = require("bcryptjs");
const jwt          = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const fs           = require("fs");
const crypto       = require("crypto");

// ── Logging ───────────────────────────────────────────────────────────────────
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS    = { debug: 0, info: 1, warn: 2, error: 3 };
const lvl       = LEVELS[LOG_LEVEL] ?? 1;
function log(ns, level, ...args) {
  if ((LEVELS[level] ?? 1) < lvl) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${ts}  ${level.toUpperCase().padEnd(5)}  ${ns}`, ...args);
}
const logger  = (ns) => ({
  info:  (...a) => log(ns, "info",  ...a),
  warn:  (...a) => log(ns, "warn",  ...a),
  error: (...a) => log(ns, "error", ...a),
  debug: (...a) => log(ns, "debug", ...a),
});
const mainLog = logger("dashboard");
const botLog  = logger("dashboard.bot");
const authLog = logger("dashboard.auth");

// ── Config ────────────────────────────────────────────────────────────────────
const WEB_PORT      = parseInt(process.env.PORT  || "8080", 10);
const WEBHOOK_URL   = process.env.LOG_WEBHOOK_URL || "";
const SHUTDOWN_KEY  = "nukeyay";
const DASHBOARD_URL = process.env.DASHBOARD_URL  || `http://localhost:${WEB_PORT}`;

// JWT secret: set JWT_SECRET env var — if missing, a random one is generated
// (sessions won't survive server restarts without a fixed secret!)
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const s = crypto.randomBytes(48).toString("hex");
  mainLog.warn("⚠️  JWT_SECRET not set — generated random secret. Sessions will die on restart. Set JWT_SECRET env var!");
  return s;
})();

// ── Discord Channel Storage ───────────────────────────────────────────────────
// Uses a dedicated bot + channel to save/restore account data automatically.
const STORAGE_TOKEN   = "MTUwMzI2MDI5MzMyNzg4MDI2Mg.G6wdWa.vqW94q3L4XCKpcUQbepZEVhKhlh6t0X_77mB1I";
const STORAGE_CHANNEL = "1521645327277625364";
const SAVE_TAG        = "📁DASHSAVE";

async function storageReq(method, urlPath, body) {
  try {
    const res = await fetch(`https://discord.com/api/v10${urlPath}`, {
      method,
      headers: { Authorization: `Bot ${STORAGE_TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: null, error: e.message };
  }
}

// "Email" replacement: no SMTP is configured, so deliver these notifications
// (password reset links, password-changed confirmations) as embeds into the
// same storage channel the bot already uses. Strips the HTML down to plain
// text/links since Discord messages aren't HTML.
async function sendMail(to, subject, html) {
  const text = String(html)
    .replace(/<a href="([^"]+)"[^>]*>.*?<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  try {
    const { status } = await storageReq("POST", `/channels/${STORAGE_CHANNEL}/messages`, {
      embeds: [{
        title: `📧 ${subject}`,
        description: `**To:** ${to}\n\n${text.slice(0, 3800)}`,
        color: 0x5865F2,
        timestamp: new Date().toISOString(),
      }],
    });
    if (status >= 200 && status < 300) {
      mainLog.info(`✉️  "${subject}" for ${to} → delivered to Discord channel (no SMTP configured)`);
    } else {
      mainLog.warn(`✉️  "${subject}" for ${to} → Discord delivery failed (status ${status})`);
    }
  } catch (e) {
    mainLog.error("sendMail (discord) failed:", e.message);
  }
}

// Save full usersDB to Discord channel (chunked if needed)
async function discordSave() {
  try {
    const payload   = JSON.stringify(usersDB);
    const maxChunk  = 1800;
    const chunks    = [];
    for (let i = 0; i < payload.length; i += maxChunk)
      chunks.push(payload.slice(i, i + maxChunk));

    const saveId = Date.now().toString(36);
    for (let i = 0; i < chunks.length; i++) {
      await storageReq("POST", `/channels/${STORAGE_CHANNEL}/messages`, {
        content: `${SAVE_TAG} id:${saveId} ${i+1}/${chunks.length}\n\`\`\`json\n${chunks[i]}\n\`\`\``,
      });
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 600)); // avoid rate limit
    }
    mainLog.info(`💾 Saved to Discord channel (${chunks.length} msg${chunks.length > 1 ? "s" : ""})`);
  } catch (e) {
    mainLog.warn("Discord save failed:", e.message);
  }
}

// Load latest complete save from Discord channel
async function discordLoad() {
  try {
    const { status, data } = await storageReq("GET", `/channels/${STORAGE_CHANNEL}/messages?limit=100`);
    if (status !== 200 || !Array.isArray(data)) return null;

    // Group messages by saveId
    const saves = {};
    for (const msg of data) {
      if (!msg.content?.includes(SAVE_TAG)) continue;
      const idM   = msg.content.match(/id:([a-z0-9]+)/);
      const partM = msg.content.match(/(\d+)\/(\d+)/);
      if (!idM || !partM) continue;
      const sid = idM[1], part = +partM[1], total = +partM[2];
      const jsonM = msg.content.match(/```json\n([\s\S]+?)\n```/);
      if (!jsonM) continue;
      if (!saves[sid]) saves[sid] = { total, parts: {} };
      saves[sid].parts[part] = jsonM[1];
    }

    // Pick latest complete save
    const complete = Object.entries(saves)
      .filter(([, s]) => Object.keys(s.parts).length === s.total)
      .sort(([a], [b]) => parseInt(b, 36) - parseInt(a, 36));

    if (!complete.length) return null;
    const [, best] = complete[0];
    const joined = Object.keys(best.parts)
      .sort((a, b) => +a - +b)
      .map(k => best.parts[k]).join("");
    return JSON.parse(joined);
  } catch (e) {
    mainLog.warn("Discord load failed:", e.message);
    return null;
  }
}

// ── User Database ─────────────────────────────────────────────────────────────
// Primary storage: users.json next to this file.
// Backup/fallback: Discord channel (auto-save on every change, auto-restore on first boot).
// Schema: { [email]: { id, email, username, password, passwordHash, createdAt, sessions: {...} } }
const USERS_FILE = path.join(__dirname, "users.json");
let usersDB = {};

function loadUsersFromFile() {
  try {
    usersDB = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    mainLog.info(`👤 Loaded ${Object.keys(usersDB).length} account(s) from users.json`);
    return true;
  } catch {
    return false;
  }
}

function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(usersDB, null, 2)); }
  catch (e) { mainLog.error("Failed to save users.json:", e.message); }
  discordSave().catch(() => {}); // async backup — fire and forget
}

// ── Device / IP Helpers ───────────────────────────────────────────────────────
function getIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : (req.socket?.remoteAddress || req.ip || "0.0.0.0");
}

function parseUA(ua = "") {
  let browser = "Unknown Browser", os = "Unknown OS", deviceType = "desktop";
  if (/mobile|android|iphone/i.test(ua))       deviceType = "mobile";
  else if (/tablet|ipad/i.test(ua))             deviceType = "tablet";

  if      (/Edg\//i.test(ua))       browser = "Edge";
  else if (/OPR\//i.test(ua))       browser = "Opera";
  else if (/Brave/i.test(ua))       browser = "Brave";
  else if (/Firefox\//i.test(ua))   browser = "Firefox";
  else if (/Chrome\//i.test(ua))    browser = "Chrome";
  else if (/Safari\//i.test(ua))    browser = "Safari";

  if      (/Windows NT/i.test(ua))  os = "Windows";
  else if (/Android/i.test(ua))     os = "Android";
  else if (/iPhone|iPad/i.test(ua)) os = "iOS";
  else if (/Mac OS X/i.test(ua))    os = "macOS";
  else if (/Linux/i.test(ua))       os = "Linux";

  return { browser, os, deviceType, name: `${browser} on ${os}` };
}

// ── Password Reset Tokens ─────────────────────────────────────────────────────
const resetTokens = new Map(); // token → { email, expiry }
function pruneResets() {
  const now = Date.now();
  for (const [k, v] of resetTokens) if (now > v.expiry) resetTokens.delete(k);
}

// Prune every 15 minutes
setInterval(pruneResets, 15 * 60 * 1000);

// ── Auth Middleware ───────────────────────────────────────────────────────────
function getJWT(req) {
  return req.cookies?.dashboard_session ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

function requireAuth(req, res, next) {
  // Setup mode: no accounts registered yet — allow everything through
  if (Object.keys(usersDB).length === 0) { req.dashUser = null; return next(); }

  const token = getJWT(req);
  if (!token) return res.status(401).json({ error: "Login required" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = usersDB[decoded.email];
    if (!user) return res.status(401).json({ error: "Account not found" });

    const session = user.sessions?.[decoded.sessionId];
    if (!session) return res.status(401).json({ error: "Session expired — please sign in again" });

    // Check token expiry stored on session
    if (session.expiresAt && Date.now() > new Date(session.expiresAt).getTime()) {
      delete user.sessions[decoded.sessionId];
      saveUsers();
      return res.status(401).json({ error: "Session expired — please sign in again" });
    }

    // Update last-seen and IP
    session.lastSeen = new Date().toISOString();
    session.ip       = getIP(req);
    saveUsers();

    req.dashUser    = user;
    req.dashSession = session;
    req.dashSid     = decoded.sessionId;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ error: "Session expired — please sign in again" });
    return res.status(401).json({ error: "Invalid session" });
  }
}

// ── Existing State ─────────────────────────────────────────────────────────────
let NUKE_ACTIVE = false;
const botRegistry      = new Map();
const sseConnections   = new Map();
const dmSseConnections = new Map();
const extraBots        = new Map();

// ── Existing Helpers ──────────────────────────────────────────────────────────
function tokenHint(t) {
  return t.length > 16 ? `${t.slice(0, 10)}…${t.slice(-6)}` : "***";
}
function reqToken(req) {
  return (req.headers["x-bot-token"] || "").trim();
}

async function webhookLog(username, userId, action, detail = "") {
  if (!WEBHOOK_URL) return;
  const embed = {
    title: action, color: 0xC0392B,
    fields: [
      { name: "User",    value: String(username), inline: true },
      { name: "User ID", value: String(userId),   inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
  if (detail) embed.description = detail;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (e) { mainLog.warn("Webhook failed:", e.message); }
}

async function discordRest(method, urlPath, token, body) {
  const res = await fetch(`https://discord.com/api/v10${urlPath}`, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}

async function discordRestSend(token, channelId, content, replyToId = null) {
  const payload = { content };
  if (replyToId) payload.message_reference = { message_id: String(replyToId) };
  const { status, data } = await discordRest("POST", `/channels/${channelId}/messages`, token, payload);
  if (status === 200 || status === 201) return { success: true, message_id: String(data.id) };
  return { error: data?.message || "Error" };
}

async function validateBotToken(token) {
  const { status, data } = await discordRest("GET", "/users/@me", token);
  return status === 200 ? data.username : null;
}

// ── Bot Factory ───────────────────────────────────────────────────────────────
const INTENTS = [
  GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildModeration, GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
];

function getOrCreateBot(token) {
  if (botRegistry.has(token)) return botRegistry.get(token);
  botLog.info("Spinning up bot for token", tokenHint(token));
  const client = new Client({ intents: INTENTS });

  const readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      botLog.warn("Bot ready-timeout for token", tokenHint(token));
      botRegistry.delete(token);
      reject(new Error("timeout"));
    }, 15_000);

    client.once(Events.ClientReady, async (c) => {
      clearTimeout(timeout);
      botLog.info("Logged in as", c.user.tag);
      webhookLog(c.user.tag, c.user.id, "🟢 Bot Connected", `Token \`${tokenHint(token)}\` is now online.`).catch(() => {});
      resolve(client);
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    if (NUKE_ACTIVE) return;
    const channelId   = message.channelId;
    const botUser     = client.user;
    const mentionsBot = message.mentions.has(botUser);
    let isReplyToBot  = false, refData = null;

    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (ref) {
          isReplyToBot = ref.author.id === botUser.id;
          refData = { id: ref.id, author: ref.member?.displayName || ref.author.username, content: (ref.content || "").slice(0, 100) };
        }
      } catch {}
    }

    const payload = JSON.stringify({
      id: message.id, author: message.member?.displayName || message.author.username,
      author_id: message.author.id, content: message.content,
      timestamp: message.createdAt.toISOString(), is_bot: message.author.bot,
      is_reply_to_bot: isReplyToBot, mentions_bot: mentionsBot,
      notify: isReplyToBot || mentionsBot, reference: refData,
      can_delete: message.author.id === botUser.id, channel_id: channelId,
    });

    for (const res of (sseConnections.get(channelId) || []))
      try { res.write(`data: ${payload}\n\n`); } catch {}

    if (message.channel.type === ChannelType.DM) {
      const uid = message.author.id;
      const dmPayload = JSON.stringify({
        id: message.id, author: message.author.username, author_id: uid,
        content: message.content, timestamp: message.createdAt.toISOString(),
        is_bot: message.author.bot, channel_id: channelId,
        can_delete: message.author.id === botUser.id,
      });
      for (const res of (dmSseConnections.get(uid) || []))
        try { res.write(`data: ${dmPayload}\n\n`); } catch {}
    }

    webhookLog(
      message.member?.displayName || message.author.username, message.author.id, "💬 Message Received",
      `**Channel:** <#${channelId}>\n**Content:** ${(message.content || "").slice(0, 200) || "*[no text]*"}`
        + (isReplyToBot ? " *(reply to bot)*" : "") + (mentionsBot ? " *(mentions bot)*" : ""),
    ).catch(() => {});
  });

  client.login(token).catch((err) => {
    botLog.error("Login failed for token", tokenHint(token), err.message);
    botRegistry.delete(token);
  });

  const entry = { client, readyPromise };
  botRegistry.set(token, entry);
  return entry;
}

async function getBot(token) {
  if (NUKE_ACTIVE || !token) return null;
  try {
    const { client, readyPromise } = getOrCreateBot(token);
    await readyPromise;
    return client;
  } catch { return null; }
}

async function nukeAll() {
  NUKE_ACTIVE = true;
  mainLog.warn("🚨 NUKE triggered");
  const shutdown = JSON.stringify({ type: "shutdown" });
  for (const resList of sseConnections.values())
    for (const res of resList) try { res.write(`data: ${shutdown}\n\n`); res.end(); } catch {}
  sseConnections.clear();
  for (const resList of dmSseConnections.values())
    for (const res of resList) try { res.write(`data: ${shutdown}\n\n`); res.end(); } catch {}
  dmSseConnections.clear();
  for (const { client } of botRegistry.values()) try { await client.destroy(); } catch {}
  botRegistry.clear();
  extraBots.clear();
  mainLog.warn("🚨 NUKE complete");
  webhookLog("System", 0, "🚨 NUKE Executed", "All bot sessions, tokens, and SSE connections were wiped.").catch(() => {});
}

function sseStream(req, res, store, key) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  if (!store.has(key)) store.set(key, []);
  store.get(key).push(res);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20_000);
  req.on("close", () => {
    clearInterval(ping);
    const list = store.get(key) || [];
    const idx  = list.indexOf(res);
    if (idx !== -1) list.splice(idx, 1);
  });
}

// ── Express Setup ─────────────────────────────────────────────────────────────
const app  = express();
const HERE = path.join(__dirname);

app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", true);

// ── Page Routes ───────────────────────────────────────────────────────────────
// dashboard.html is a self-contained SPA: it has its own auth-gate overlay and
// checks /auth/me itself on load to decide whether to show the login screen or
// the dashboard. So every page route just serves the same file — no redirects,
// no separate auth.html needed. (The /auth/reset-password route exists only so
// the link in the password-reset email lands somewhere that still has the
// ?token=... in the URL for the page's own JS to pick up.)
const serveDashboard = (_req, res) => res.sendFile(path.join(HERE, "dashboard.html"));

app.get("/",                      serveDashboard);
app.get("/auth",                  serveDashboard);
app.get("/auth/reset-password",   serveDashboard);
app.get("/policy",                (_req, res) => res.sendFile(path.join(HERE, "policy.html")));
app.get("/updates",               (_req, res) => res.sendFile(path.join(HERE, "updates.html")));

// ══════════════════════════════════════════════════════════════════════════════
// AUTH API
// ══════════════════════════════════════════════════════════════════════════════

// Register ─────────────────────────────────────────────────────────────────────
app.post("/auth/register", async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username)
    return res.status(400).json({ error: "email, password, and username are required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Invalid email address" });
  if (password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters" });

  const key = email.toLowerCase().trim();
  if (usersDB[key])
    return res.status(409).json({ error: "An account with that email already exists" });

  const passwordHash = await bcrypt.hash(password, 12);
  usersDB[key] = {
    id: uuidv4(), email: key,
    username: username.trim().slice(0, 32),
    passwordHash,
    createdAt: new Date().toISOString(),
    sessions: {},
  };
  saveUsers();
  authLog.info(`✅ Registered: ${key}`);
  return res.json({ success: true });
});

// Login ────────────────────────────────────────────────────────────────────────
app.post("/auth/login", async (req, res) => {
  const { email, password, rememberMe = false, deviceName } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "email and password are required" });

  const key  = email.toLowerCase().trim();
  const user = usersDB[key];
  if (!user || !(await bcrypt.compare(password, user.passwordHash)))
    return res.status(401).json({ error: "Invalid email or password" });

  const sessionId = uuidv4();
  const ip        = getIP(req);
  const ua        = req.headers["user-agent"] || "";
  const device    = parseUA(ua);
  const ttlDays   = rememberMe ? 30 : 1;
  const ttlMs     = ttlDays * 24 * 60 * 60 * 1000;

  user.sessions[sessionId] = {
    id:         sessionId,
    ip,
    userAgent:  ua,
    browser:    device.browser,
    os:         device.os,
    deviceType: device.deviceType,
    deviceName: (deviceName || device.name).slice(0, 64),
    createdAt:  new Date().toISOString(),
    lastSeen:   new Date().toISOString(),
    expiresAt:  new Date(Date.now() + ttlMs).toISOString(),
    rememberMe: Boolean(rememberMe),
  };
  saveUsers();

  const token = jwt.sign({ email: key, sessionId }, JWT_SECRET, { expiresIn: `${ttlDays}d` });

  // Set HttpOnly cookie — browser sends it automatically on same-origin requests
  res.cookie("dashboard_session", token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge:   ttlMs,
    path:     "/",
  });

  authLog.info(`🔑 Login: ${key} from ${ip} [${device.name}] remember=${rememberMe}`);
  return res.json({
    success: true,
    token,  // also returned for JS usage (stored in sessionStorage/localStorage by frontend)
    user: { id: user.id, email: key, username: user.username },
  });
});

// Logout ───────────────────────────────────────────────────────────────────────
app.post("/auth/logout", (req, res) => {
  const token = getJWT(req);
  if (token) {
    try {
      const { email, sessionId } = jwt.verify(token, JWT_SECRET);
      const user = usersDB[email];
      if (user?.sessions?.[sessionId]) { delete user.sessions[sessionId]; saveUsers(); }
    } catch {}
  }
  res.clearCookie("dashboard_session", { path: "/" });
  return res.json({ success: true });
});

// Current user ─────────────────────────────────────────────────────────────────
app.get("/auth/me", requireAuth, (req, res) => {
  if (!req.dashUser) return res.json({ loggedIn: false, setupMode: true }); // no accounts yet
  const u = req.dashUser;
  return res.json({ loggedIn: true, id: u.id, email: u.email, username: u.username, createdAt: u.createdAt });
});

// Sessions / Devices ───────────────────────────────────────────────────────────
app.get("/auth/devices", requireAuth, (req, res) => {
  if (!req.dashUser) return res.json([]);
  const sessions = req.dashUser.sessions || {};
  return res.json(
    Object.values(sessions)
      .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
      .map(s => ({
        id:         s.id,
        deviceName: s.deviceName,
        browser:    s.browser,
        os:         s.os,
        deviceType: s.deviceType,
        ip:         s.ip,
        createdAt:  s.createdAt,
        lastSeen:   s.lastSeen,
        expiresAt:  s.expiresAt,
        rememberMe: s.rememberMe,
        isCurrent:  s.id === req.dashSid,
      }))
  );
});

// Revoke session ───────────────────────────────────────────────────────────────
app.delete("/auth/devices/:sid", requireAuth, (req, res) => {
  if (!req.dashUser) return res.status(401).json({ error: "Not authenticated" });
  const sid = req.params.sid;
  if (!req.dashUser.sessions?.[sid]) return res.status(404).json({ error: "Session not found" });
  delete req.dashUser.sessions[sid];
  saveUsers();
  if (sid === req.dashSid) res.clearCookie("dashboard_session", { path: "/" });
  return res.json({ success: true });
});

// Revoke all OTHER sessions ────────────────────────────────────────────────────
app.post("/auth/devices/revoke-all", requireAuth, (req, res) => {
  if (!req.dashUser) return res.status(401).json({ error: "Not authenticated" });
  const current = req.dashUser.sessions[req.dashSid];
  req.dashUser.sessions = current ? { [req.dashSid]: current } : {};
  saveUsers();
  return res.json({ success: true });
});

// Forgot password (send email) ─────────────────────────────────────────────────
app.post("/auth/forgot-password", async (req, res) => {
  pruneResets();
  const email = (req.body.email || "").toLowerCase().trim();
  // Always return 200 — prevents email enumeration attacks
  if (email && usersDB[email]) {
    const user  = usersDB[email];
    const token = crypto.randomBytes(32).toString("hex");
    resetTokens.set(token, { email, expiry: Date.now() + 60 * 60 * 1000 }); // 1 hour
    const link  = `${DASHBOARD_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
    await sendMail(email, "Reset your Dashboard password",
      `<!DOCTYPE html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1a1b1e;padding:40px 20px">
        <div style="max-width:480px;margin:0 auto;background:#2b2d31;border-radius:16px;padding:36px;border:1px solid #3d3f45">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:28px">
            <div style="width:44px;height:44px;background:#5865F2;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px">🤖</div>
            <div>
              <div style="font-size:16px;font-weight:700;color:#dbdee1">Discord Dashboard</div>
              <div style="font-size:12px;color:#949ba4">Password Reset</div>
            </div>
          </div>
          <h2 style="color:#dbdee1;font-size:20px;margin:0 0 8px">Reset your password</h2>
          <p style="color:#949ba4;margin:0 0 24px;line-height:1.5">Hi <strong style="color:#dbdee1">${user.username}</strong>, someone requested a password reset for your account.</p>
          <a href="${link}" style="display:block;background:#5865F2;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;margin-bottom:20px">Reset Password</a>
          <p style="color:#6d6f78;font-size:12px;margin:0 0 8px">⏱️ This link expires in <strong style="color:#949ba4">1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>
          <p style="color:#4d4f56;font-size:11px;word-break:break-all;margin:0">Or copy: ${link}</p>
        </div>
      </body></html>`
    );
  }
  return res.json({ success: true });
});

// Validate reset token ─────────────────────────────────────────────────────────
app.get("/auth/validate-reset", (req, res) => {
  const token = (req.query.token || "").trim();
  const entry = resetTokens.get(token);
  if (!entry || Date.now() > entry.expiry) return res.json({ valid: false });
  return res.json({ valid: true });
});

// Reset password ───────────────────────────────────────────────────────────────
app.post("/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "token and password required" });
  const entry = resetTokens.get(token.trim());
  if (!entry)             return res.status(400).json({ error: "Invalid or expired reset link" });
  if (Date.now() > entry.expiry) {
    resetTokens.delete(token);
    return res.status(400).json({ error: "Reset link has expired — request a new one" });
  }
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  const user = usersDB[entry.email];
  if (!user) return res.status(404).json({ error: "Account not found" });

  user.passwordHash = await bcrypt.hash(password, 12);
  user.sessions     = {}; // sign out ALL devices on password reset
  saveUsers();
  resetTokens.delete(token);
  res.clearCookie("dashboard_session", { path: "/" });

  await sendMail(entry.email, "Your Dashboard password was changed",
    `<!DOCTYPE html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1a1b1e;padding:40px 20px">
      <div style="max-width:480px;margin:0 auto;background:#2b2d31;border-radius:16px;padding:36px;border:1px solid #3d3f45">
        <h2 style="color:#57F287;margin:0 0 16px">✅ Password Changed</h2>
        <p style="color:#949ba4;line-height:1.5">Hi <strong style="color:#dbdee1">${user.username}</strong>, your Discord Dashboard password was successfully changed. <strong style="color:#dbdee1">All active sessions have been signed out.</strong></p>
        <p style="color:#6d6f78;font-size:12px;margin-top:16px">If you didn't make this change, contact your administrator immediately.</p>
      </div>
    </body></html>`
  );

  authLog.info(`🔒 Password reset: ${entry.email}`);
  return res.json({ success: true });
});

// Change password (while authenticated) ───────────────────────────────────────
app.post("/auth/change-password", requireAuth, async (req, res) => {
  if (!req.dashUser) return res.status(401).json({ error: "Not authenticated" });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "currentPassword and newPassword required" });
  if (!(await bcrypt.compare(currentPassword, req.dashUser.passwordHash)))
    return res.status(401).json({ error: "Current password is incorrect" });
  if (newPassword.length < 8)
    return res.status(400).json({ error: "New password must be at least 8 characters" });

  req.dashUser.passwordHash = await bcrypt.hash(newPassword, 12);
  // Keep only current session, revoke all others
  const cur = req.dashUser.sessions[req.dashSid];
  req.dashUser.sessions = cur ? { [req.dashSid]: cur } : {};
  saveUsers();
  return res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// EXISTING API ROUTES — all now protected by requireAuth
// ══════════════════════════════════════════════════════════════════════════════

app.get("/status", requireAuth, async (req, res) => {
  if (NUKE_ACTIVE) return res.json({ online: false, nuked: true });
  const token = reqToken(req);
  if (!token) return res.json({ online: false });
  const client = await getBot(token);
  if (client?.isReady()) return res.json({ online: true, username: client.user.tag, id: client.user.id });
  return res.json({ online: false });
});

app.get("/guilds", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.json([]);
  return res.json([...client.guilds.cache.values()].map(g => ({
    id: g.id, name: g.name, member_count: g.memberCount, icon: g.iconURL({ size: 64 }),
  })));
});

app.get("/guild-info/:guild_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  const me = guild.members.me, perms = me?.permissions;
  return res.json({
    id: guild.id, name: guild.name, member_count: guild.memberCount,
    icon: guild.iconURL({ size: 128 }), owner_id: guild.ownerId,
    bot_perms: {
      administrator:    perms?.has(PermissionFlagsBits.Administrator)    || false,
      manage_guild:     perms?.has(PermissionFlagsBits.ManageGuild)      || false,
      manage_channels:  perms?.has(PermissionFlagsBits.ManageChannels)   || false,
      manage_roles:     perms?.has(PermissionFlagsBits.ManageRoles)      || false,
      manage_messages:  perms?.has(PermissionFlagsBits.ManageMessages)   || false,
      kick_members:     perms?.has(PermissionFlagsBits.KickMembers)      || false,
      ban_members:      perms?.has(PermissionFlagsBits.BanMembers)       || false,
      moderate_members: perms?.has(PermissionFlagsBits.ModerateMembers)  || false,
      send_messages:    perms?.has(PermissionFlagsBits.SendMessages)     || false,
    },
  });
});

app.get("/channels/:guild_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.json([]);
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.json([]);
  return res.json(
    [...guild.channels.cache.values()]
      .filter(c => c.type === ChannelType.GuildText)
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(c => ({ id: c.id, name: c.name, position: c.position }))
  );
});

app.post("/channels/:guild_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels))
    return res.status(403).json({ error: "Bot lacks Manage Channels permission" });
  const { name, topic = "" } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Channel name required" });
  try {
    const channel = await guild.channels.create({
      name: name.trim().toLowerCase().replace(/\s+/g, "-"),
      type: ChannelType.GuildText, topic: topic.trim() || undefined,
    });
    webhookLog(client.user.tag, client.user.id, "📺 Channel Created", `**Guild:** ${guild.name}\n**Channel:** #${channel.name}`).catch(() => {});
    return res.json({ success: true, id: channel.id, name: channel.name });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.delete("/channels/:guild_id/:channel_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels))
    return res.status(403).json({ error: "Bot lacks Manage Channels permission" });
  const { status, data } = await discordRest("DELETE", `/channels/${req.params.channel_id}`, client.token);
  if (status === 200 || status === 204) {
    webhookLog(client.user.tag, client.user.id, "🗑️ Channel Deleted", `**Guild:** ${guild.name}\n**ID:** ${req.params.channel_id}`).catch(() => {});
    return res.json({ success: true });
  }
  return res.status(status).json({ error: data?.message || `HTTP ${status}` });
});

app.get("/history/:channel_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const channel = client.channels.cache.get(req.params.channel_id);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
  try {
    const fetched = await channel.messages.fetch({ limit });
    return res.json([...fetched.values()].reverse().map(msg => {
      const mentionsBot  = msg.mentions.has(client.user);
      const isReplyToBot = !!(msg.reference && msg.mentions.repliedUser?.id === client.user.id);
      return {
        id: msg.id, author: msg.member?.displayName || msg.author.username,
        author_id: msg.author.id, content: msg.content,
        timestamp: msg.createdAt.toISOString(), is_bot: msg.author.bot,
        is_reply_to_bot: isReplyToBot, mentions_bot: mentionsBot,
        notify: isReplyToBot || mentionsBot, reference: null,
        can_delete: msg.author.id === client.user.id, channel_id: msg.channelId,
      };
    }));
  } catch (e) {
    if (e.code === 50013) return res.status(403).json({ error: "Missing Read Message History permission" });
    return res.status(500).json({ error: e.message });
  }
});

app.get("/events/:channel_id",  requireAuth, (req, res) => sseStream(req, res, sseConnections,   req.params.channel_id));
app.get("/dm-events/:user_id",  requireAuth, (req, res) => sseStream(req, res, dmSseConnections, req.params.user_id));

app.get("/search/:channel_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const channel = client.channels.cache.get(req.params.channel_id);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q) return res.json([]);
  try {
    const fetched = await channel.messages.fetch({ limit: 100 });
    return res.json([...fetched.values()]
      .filter(m => m.content.toLowerCase().includes(q)).slice(0, 25).reverse()
      .map(m => ({
        id: m.id, author: m.member?.displayName || m.author.username, author_id: m.author.id,
        content: m.content, timestamp: m.createdAt.toISOString(), is_bot: m.author.bot,
        can_delete: m.author.id === client.user.id, channel_id: m.channelId,
      })));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/send", requireAuth, async (req, res) => {
  const token = reqToken(req);
  const { channel_id, message, bot_id = "main" } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "Empty message" });
  if (bot_id !== "main") {
    const bot = extraBots.get(bot_id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    const result = await discordRestSend(bot.token, channel_id, message.trim());
    return res.status(result.success ? 200 : 500).json(result);
  }
  const client = await getBot(token);
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const channel = client.channels.cache.get(String(channel_id));
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  try {
    const sent = await channel.send(message.trim());
    webhookLog(client.user.tag, client.user.id, "📤 Message Sent", `**Channel:** <#${channel_id}>\n**Content:** ${message.slice(0, 200)}`).catch(() => {});
    return res.json({ success: true, message_id: sent.id, channel_id: String(channel_id) });
  } catch (e) {
    if (e.code === 50013) return res.status(403).json({ error: "Missing Send Messages permission" });
    return res.status(500).json({ error: e.message });
  }
});

app.post("/reply", requireAuth, async (req, res) => {
  const token = reqToken(req);
  const { channel_id, message_id, content, bot_id = "main" } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Empty message" });
  if (bot_id !== "main") {
    const bot = extraBots.get(bot_id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    const result = await discordRestSend(bot.token, channel_id, content.trim(), message_id);
    return res.status(result.success ? 200 : 500).json(result);
  }
  const client = await getBot(token);
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const channel = client.channels.cache.get(String(channel_id));
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  try {
    const target = await channel.messages.fetch(String(message_id));
    const sent   = await target.reply(content.trim());
    webhookLog(client.user.tag, client.user.id, "↩️ Reply Sent", `**Channel:** <#${channel_id}>\n**Reply to:** ${message_id}\n**Content:** ${content.slice(0, 200)}`).catch(() => {});
    return res.json({ success: true, message_id: sent.id, channel_id: String(channel_id) });
  } catch (e) {
    if (e.code === 10008) return res.status(404).json({ error: "Original message not found" });
    if (e.code === 50013) return res.status(403).json({ error: "Missing reply permission" });
    return res.status(500).json({ error: e.message });
  }
});

app.delete("/message/:channel_id/:message_id", requireAuth, async (req, res) => {
  const { channel_id, message_id } = req.params;
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const { status, data } = await discordRest("DELETE", `/channels/${channel_id}/messages/${message_id}`, client.token);
  if (status === 204) {
    webhookLog(client.user.tag, client.user.id, "🗑️ Message Deleted", `**Channel:** ${channel_id}\n**Message ID:** ${message_id}`).catch(() => {});
    return res.json({ success: true });
  }
  return res.status([403, 404].includes(status) ? status : 500).json({ error: data?.message || `HTTP ${status}` });
});

app.post("/bulk-delete", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const { channel_id, count = 10 } = req.body;
  const channel = client.channels.cache.get(String(channel_id));
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  if (!channel.guild?.members.me?.permissions.has(PermissionFlagsBits.ManageMessages))
    return res.status(403).json({ error: "Bot lacks Manage Messages permission" });
  try {
    const fetched  = await channel.messages.fetch({ limit: Math.min(count, 100) });
    const twoWeeks = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const eligible = [...fetched.values()].filter(m => m.createdTimestamp > twoWeeks).map(m => m.id);
    if (eligible.length === 0) return res.json({ success: true, deleted: 0 });
    await channel.bulkDelete(eligible);
    webhookLog(client.user.tag, client.user.id, "🧹 Bulk Delete", `**Channel:** <#${channel_id}>\n**Deleted:** ${eligible.length} messages`).catch(() => {});
    return res.json({ success: true, deleted: eligible.length });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get("/members/:guild_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  await guild.members.fetch().catch(() => {});
  return res.json([...guild.members.cache.values()].filter(m => !m.user.bot).map(m => ({
    id: m.id, name: m.displayName, discriminator: m.user.discriminator,
    status: m.presence?.status || "offline",
    roles: m.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
    joined_at: m.joinedAt?.toISOString(), avatar: m.user.displayAvatarURL({ size: 64 }),
  })));
});

app.get("/guild-bots/:guild_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  await guild.members.fetch().catch(() => {});
  return res.json([...guild.members.cache.values()].filter(m => m.user.bot).map(m => ({
    id: m.id, name: m.displayName, username: m.user.tag, status: m.presence?.status || "offline",
  })));
});

app.get("/roles/:guild_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  const myHighest = guild.members.me?.roles.highest.position || 0;
  return res.json([...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id).sort((a, b) => b.position - a.position)
    .map(r => ({
      id: r.id, name: r.name, color: r.hexColor, position: r.position,
      managed: r.managed, assignable: r.position < myHighest && !r.managed, member_count: r.members.size,
    })));
});

app.put("/roles/:guild_id/:member_id/:role_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles))
    return res.status(403).json({ error: "Bot lacks Manage Roles permission" });
  try {
    const member = await guild.members.fetch(req.params.member_id);
    const role   = guild.roles.cache.get(req.params.role_id);
    if (!role) return res.status(404).json({ error: "Role not found" });
    if (role.position >= (guild.members.me?.roles.highest.position || 0))
      return res.status(403).json({ error: "Role is higher than bot's highest role" });
    await member.roles.add(role);
    webhookLog(client.user.tag, client.user.id, "➕ Role Assigned", `**Guild:** ${guild.name}\n**Member:** ${member.displayName}\n**Role:** ${role.name}`).catch(() => {});
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.delete("/roles/:guild_id/:member_id/:role_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles))
    return res.status(403).json({ error: "Bot lacks Manage Roles permission" });
  try {
    const member = await guild.members.fetch(req.params.member_id);
    const role   = guild.roles.cache.get(req.params.role_id);
    if (!role) return res.status(404).json({ error: "Role not found" });
    await member.roles.remove(role);
    webhookLog(client.user.tag, client.user.id, "➖ Role Removed", `**Guild:** ${guild.name}\n**Member:** ${member.displayName}\n**Role:** ${role.name}`).catch(() => {});
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/kick/:guild_id/:member_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers))
    return res.status(403).json({ error: "Bot lacks Kick Members permission" });
  try {
    const member = await guild.members.fetch(req.params.member_id);
    const reason = (req.body.reason || "No reason provided").slice(0, 512);
    await member.kick(reason);
    webhookLog(client.user.tag, client.user.id, "👟 Member Kicked", `**Guild:** ${guild.name}\n**Member:** ${member.displayName} (${member.id})\n**Reason:** ${reason}`).catch(() => {});
    return res.json({ success: true });
  } catch (e) {
    if (e.code === 50013) return res.status(403).json({ error: "Missing permissions to kick this member" });
    return res.status(500).json({ error: e.message });
  }
});

app.post("/ban/:guild_id/:member_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers))
    return res.status(403).json({ error: "Bot lacks Ban Members permission" });
  try {
    const reason    = (req.body.reason || "No reason provided").slice(0, 512);
    const deleteMsg = Math.min(parseInt(req.body.delete_days || "0", 10), 7);
    await guild.members.ban(req.params.member_id, { reason, deleteMessageDays: deleteMsg });
    webhookLog(client.user.tag, client.user.id, "🔨 Member Banned", `**Guild:** ${guild.name}\n**User ID:** ${req.params.member_id}\n**Reason:** ${reason}\n**Delete days:** ${deleteMsg}`).catch(() => {});
    return res.json({ success: true });
  } catch (e) {
    if (e.code === 50013) return res.status(403).json({ error: "Missing permissions to ban this member" });
    return res.status(500).json({ error: e.message });
  }
});

app.delete("/ban/:guild_id/:user_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers))
    return res.status(403).json({ error: "Bot lacks Ban Members permission" });
  try {
    await guild.members.unban(req.params.user_id, req.body.reason || "Unbanned via dashboard");
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/timeout/:guild_id/:member_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers))
    return res.status(403).json({ error: "Bot lacks Moderate Members permission" });
  try {
    const member     = await guild.members.fetch(req.params.member_id);
    const durationMs = Math.min(parseInt(req.body.duration_ms || "300000", 10), 28 * 24 * 60 * 60 * 1000);
    const reason     = (req.body.reason || "No reason provided").slice(0, 512);
    const until      = durationMs > 0 ? new Date(Date.now() + durationMs) : null;
    await member.timeout(until, reason);
    const action = until ? "⏱️ Member Timed Out" : "✅ Timeout Removed";
    webhookLog(client.user.tag, client.user.id, action, `**Guild:** ${guild.name}\n**Member:** ${member.displayName}\n**Duration:** ${durationMs}ms\n**Reason:** ${reason}`).catch(() => {});
    return res.json({ success: true, until: until?.toISOString() || null });
  } catch (e) {
    if (e.code === 50013) return res.status(403).json({ error: "Missing permissions to timeout this member" });
    return res.status(500).json({ error: e.message });
  }
});

app.post("/nick/:guild_id/:member_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageNicknames))
    return res.status(403).json({ error: "Bot lacks Manage Nicknames permission" });
  try {
    const member = await guild.members.fetch(req.params.member_id);
    await member.setNickname(req.body.nick || null, req.body.reason || "Changed via dashboard");
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get("/bans/:guild_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers))
    return res.status(403).json({ error: "Bot lacks Ban Members permission" });
  try {
    const bans = await guild.bans.fetch();
    return res.json([...bans.values()].map(b => ({ id: b.user.id, name: b.user.username, reason: b.reason })));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/dm", requireAuth, async (req, res) => {
  const token = reqToken(req);
  const { user_id, content, bot_id = "main" } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Empty message" });
  if (bot_id !== "main") {
    const bot = extraBots.get(bot_id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    const { status: s1, data: d1 } = await discordRest("POST", "/users/@me/channels", bot.token, { recipient_id: String(user_id) });
    if (s1 !== 200 && s1 !== 201) return res.status(500).json({ error: "Could not open DM channel" });
    const result = await discordRestSend(bot.token, d1.id, content.trim());
    if (result.success) result.channel_id = d1.id;
    return res.status(result.success ? 200 : 500).json(result);
  }
  const client = await getBot(token);
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  try {
    const user = await client.users.fetch(String(user_id));
    const dm   = await user.createDM();
    const sent = await dm.send(content.trim());
    webhookLog(client.user.tag, client.user.id, "📨 DM Sent", `**To:** ${user.username} (${user_id})\n**Content:** ${content.slice(0, 200)}`).catch(() => {});
    return res.json({ success: true, message_id: sent.id, channel_id: dm.id });
  } catch (e) {
    if (e.code === 50007) return res.status(403).json({ error: "Cannot DM this user (DMs closed)" });
    if (e.code === 10013) return res.status(404).json({ error: "User not found" });
    return res.status(500).json({ error: e.message });
  }
});

app.get("/dm-history/:user_id", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  try {
    const user    = await client.users.fetch(req.params.user_id);
    const dm      = await user.createDM();
    const fetched = await dm.messages.fetch({ limit: 50 });
    return res.json({
      channel_id: dm.id,
      messages: [...fetched.values()].reverse().map(msg => ({
        id: msg.id, author: msg.author.username, author_id: msg.author.id,
        content: msg.content, timestamp: msg.createdAt.toISOString(),
        is_bot: msg.author.bot, channel_id: dm.id, can_delete: msg.author.id === client.user.id,
      })),
    });
  } catch (e) {
    if (e.code === 50007) return res.status(403).json({ error: "Cannot access DMs with this user" });
    if (e.code === 10013) return res.status(404).json({ error: "User not found" });
    return res.status(500).json({ error: e.message });
  }
});

app.get("/dm-list", requireAuth, async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  try {
    return res.json([...client.channels.cache.values()]
      .filter(c => c.type === ChannelType.DM)
      .map(c => ({
        channel_id: c.id, user_id: c.recipient?.id, username: c.recipient?.username || "Unknown",
        last_message: c.lastMessage ? {
          content: c.lastMessage.content, timestamp: c.lastMessage.createdAt.toISOString(), is_bot: c.lastMessage.author.bot,
        } : null,
      })).filter(d => d.user_id));
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get("/bots", requireAuth, (_req, res) => {
  res.json([...extraBots.entries()].map(([id, b]) => ({ id, name: b.name, username: b.username })));
});

app.post("/bots", requireAuth, async (req, res) => {
  const { token, name = "Custom Bot" } = req.body;
  if (!token?.trim()) return res.status(400).json({ error: "No token" });
  const username = await validateBotToken(token.trim());
  if (!username) return res.status(401).json({ error: "Invalid token" });
  const bid = uuidv4();
  extraBots.set(bid, { name: name.trim() || "Custom Bot", token: token.trim(), username });
  webhookLog(username, bid, "➕ Custom Bot Added", `**Name:** ${name}`).catch(() => {});
  return res.json({ success: true, id: bid, username });
});

app.delete("/bots/:bot_id", requireAuth, (req, res) => {
  const { bot_id } = req.params;
  const bot = extraBots.get(bot_id);
  if (bot) { webhookLog(bot.username, bot_id, "➖ Custom Bot Removed").catch(() => {}); extraBots.delete(bot_id); }
  return res.json({ success: true });
});

app.get("/shutdown=:key", async (req, res) => {
  if (req.params.key !== SHUTDOWN_KEY) return res.status(404).end();
  nukeAll().catch(() => {});
  return res.json({ nuked: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(WEB_PORT, "0.0.0.0", () => {
  mainLog.info(`🚀  Dashboard running on port ${WEB_PORT}`);
  mainLog.info(`🔗  URL: ${DASHBOARD_URL}`);
  mainLog.info(`🔐  Auth page: ${DASHBOARD_URL}/auth`);
  if (Object.keys(usersDB).length === 0)
    mainLog.info(`👤  No accounts yet — visit /auth to register the first account`);
});
