"use strict";

// ── Deps ──────────────────────────────────────────────────────────────────────
const { Client, GatewayIntentBits, Events, ChannelType } = require("discord.js");
const express  = require("express");
const path     = require("path");
const { v4: uuidv4 } = require("uuid");

// ── Logging ───────────────────────────────────────────────────────────────────
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS    = { debug: 0, info: 1, warn: 2, error: 3 };
const lvl       = LEVELS[LOG_LEVEL] ?? 1;
function log(ns, level, ...args) {
  if ((LEVELS[level] ?? 1) < lvl) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${ts}  ${level.toUpperCase().padEnd(5)}  ${ns}`, ...args);
}
const logger     = (ns) => ({ info: (...a)  => log(ns,"info",...a),
                               warn: (...a)  => log(ns,"warn",...a),
                               error: (...a) => log(ns,"error",...a) });
const mainLog    = logger("dashboard");
const botLog     = logger("dashboard.bot");
const httpLog    = logger("dashboard.http");

// ── Config ────────────────────────────────────────────────────────────────────
const WEB_PORT    = parseInt(process.env.PORT || "8080", 10);
const WEBHOOK_URL = process.env.LOG_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1386064081961594982/xsH6f8A5IKY3JTdgb04UJRUgCc4xfUzpDM2mPTc69MpK9IxwT8vz_B43emX5U-DxVTRi";
const SHUTDOWN_KEY = "nukeyay";

// ── State ─────────────────────────────────────────────────────────────────────
let NUKE_ACTIVE = false;
const botRegistry   = new Map(); // token → { client, readyPromise }
const sseConnections   = new Map(); // channel_id → [res, ...]
const dmSseConnections = new Map(); // user_id    → [res, ...]
const extraBots        = new Map(); // uuid       → { name, token, username }

// ── Helpers ───────────────────────────────────────────────────────────────────
function tokenHint(t) {
  return t.length > 16 ? `${t.slice(0, 10)}…${t.slice(-6)}` : "***";
}
function reqToken(req) {
  return (req.headers["x-bot-token"] || "").trim();
}

async function webhookLog(username, userId, action, detail = "") {
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
  } catch (e) {
    mainLog.warn("Webhook failed:", e.message);
  }
}

// ── Discord REST helpers (no client needed) ───────────────────────────────────
async function discordRest(method, path, token, body) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}

async function discordRestSend(token, channelId, content, replyToId = null) {
  const payload = { content };
  if (replyToId) payload.message_reference = { message_id: String(replyToId) };
  const { status, data } = await discordRest("POST", `/channels/${channelId}/messages`, token, payload);
  if (status === 200 || status === 201)
    return { success: true, message_id: String(data.id) };
  return { error: data?.message || "Error" };
}

async function validateBotToken(token) {
  const { status, data } = await discordRest("GET", "/users/@me", token);
  return status === 200 ? data.username : null;
}

// ── Bot factory ───────────────────────────────────────────────────────────────
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildPresences,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
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
      webhookLog(c.user.tag, c.user.id, "🟢 Bot Connected",
        `Token \`${tokenHint(token)}\` is now online.`).catch(() => {});
      resolve(client);
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    if (NUKE_ACTIVE) return;

    const channelId = message.channelId;
    const botUser   = client.user;
    const mentionsBot = message.mentions.has(botUser);
    let isReplyToBot  = false;
    let refData       = null;

    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (ref) {
          isReplyToBot = ref.author.id === botUser.id;
          refData = {
            id:      ref.id,
            author:  ref.member?.displayName || ref.author.username,
            content: (ref.content || "").slice(0, 100),
          };
        }
      } catch {}
    }

    const payload = JSON.stringify({
      id:            message.id,
      author:        message.member?.displayName || message.author.username,
      author_id:     message.author.id,
      content:       message.content,
      timestamp:     message.createdAt.toISOString(),
      is_bot:        message.author.bot,
      is_reply_to_bot: isReplyToBot,
      mentions_bot:  mentionsBot,
      notify:        isReplyToBot || mentionsBot,
      reference:     refData,
      can_delete:    message.author.id === botUser.id,
      channel_id:    channelId,
    });

    // Push to channel SSE listeners
    for (const res of (sseConnections.get(channelId) || [])) {
      try { res.write(`data: ${payload}\n\n`); } catch {}
    }

    // Push DM SSE listeners
    if (message.channel.type === ChannelType.DM) {
      const uid = message.author.id;
      const dmPayload = JSON.stringify({
        id:         message.id,
        author:     message.author.username,
        author_id:  uid,
        content:    message.content,
        timestamp:  message.createdAt.toISOString(),
        is_bot:     message.author.bot,
        channel_id: channelId,
        can_delete: message.author.id === botUser.id,
      });
      for (const res of (dmSseConnections.get(uid) || [])) {
        try { res.write(`data: ${dmPayload}\n\n`); } catch {}
      }
    }

    webhookLog(
      message.member?.displayName || message.author.username,
      message.author.id,
      "💬 Message Received",
      `**Channel:** <#${channelId}>\n**Content:** ${(message.content || "").slice(0, 200) || "*[no text]*"}`
        + (isReplyToBot ? " *(reply to bot)*" : "")
        + (mentionsBot  ? " *(mentions bot)*" : ""),
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
  } catch {
    return null;
  }
}

// ── Nuke ──────────────────────────────────────────────────────────────────────
async function nukeAll() {
  NUKE_ACTIVE = true;
  mainLog.warn("🚨 NUKE triggered");
  const shutdown = JSON.stringify({ type: "shutdown" });

  for (const resList of sseConnections.values())
    for (const res of resList)
      try { res.write(`data: ${shutdown}\n\n`); res.end(); } catch {}
  sseConnections.clear();

  for (const resList of dmSseConnections.values())
    for (const res of resList)
      try { res.write(`data: ${shutdown}\n\n`); res.end(); } catch {}
  dmSseConnections.clear();

  for (const { client } of botRegistry.values())
    try { await client.destroy(); } catch {}
  botRegistry.clear();
  extraBots.clear();

  mainLog.warn("🚨 NUKE complete");
  webhookLog("System", 0, "🚨 NUKE Executed",
    "All bot sessions, tokens, and SSE connections were wiped.").catch(() => {});
}

// ── SSE helper ────────────────────────────────────────────────────────────────
function sseStream(req, res, store, key) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  if (!store.has(key)) store.set(key, []);
  store.get(key).push(res);

  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 20_000);

  req.on("close", () => {
    clearInterval(ping);
    const list = store.get(key) || [];
    const idx  = list.indexOf(res);
    if (idx !== -1) list.splice(idx, 1);
  });
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const HERE = path.join(__dirname);

// Static pages
app.get("/",       (_req, res) => res.sendFile(path.join(HERE, "dashboard.html")));
app.get("/policy", (_req, res) => res.sendFile(path.join(HERE, "policy.html")));
app.get("/updates",(_req, res) => res.sendFile(path.join(HERE, "updates.html")));

// Status
app.get("/status", async (req, res) => {
  if (NUKE_ACTIVE) return res.json({ online: false, nuked: true });
  const token = reqToken(req);
  if (!token) return res.json({ online: false });
  const client = await getBot(token);
  if (client?.isReady()) return res.json({ online: true, username: client.user.tag });
  return res.json({ online: false });
});

// Guilds
app.get("/guilds", async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.json([]);
  return res.json([...client.guilds.cache.values()].map(g => ({ id: g.id, name: g.name })));
});

// Channels
app.get("/channels/:guild_id", async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.json([]);
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.json([]);
  return res.json(
    [...guild.channels.cache.values()]
      .filter(c => c.type === ChannelType.GuildText)
      .map(c => ({ id: c.id, name: c.name }))
  );
});

// History
app.get("/history/:channel_id", async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const channel = client.channels.cache.get(req.params.channel_id);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
  try {
    const fetched = await channel.messages.fetch({ limit });
    const msgs = [...fetched.values()].reverse().map(msg => {
      const mentionsBot  = msg.mentions.has(client.user);
      // Check if this is a reply to one of the bot's messages using the referenced author id
      const isReplyToBot = !!(msg.reference && msg.mentions.repliedUser?.id === client.user.id);
      return {
        id:            msg.id,
        author:        msg.member?.displayName || msg.author.username,
        author_id:     msg.author.id,
        content:       msg.content,
        timestamp:     msg.createdAt.toISOString(),
        is_bot:        msg.author.bot,
        is_reply_to_bot: isReplyToBot,
        mentions_bot:  mentionsBot,
        notify:        isReplyToBot || mentionsBot,
        reference:     null,
        can_delete:    msg.author.id === client.user.id,
        channel_id:    msg.channelId,
      };
    });
    return res.json(msgs);
  } catch (e) {
    if (e.code === 50013) return res.status(403).json({ error: "Missing Read Message History permission" });
    return res.status(500).json({ error: e.message });
  }
});

// SSE — channel events
app.get("/events/:channel_id", (req, res) => {
  sseStream(req, res, sseConnections, req.params.channel_id);
});

// SSE — DM events
app.get("/dm-events/:user_id", (req, res) => {
  sseStream(req, res, dmSseConnections, req.params.user_id);
});

// Search messages in a channel
app.get("/search/:channel_id", async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const channel = client.channels.cache.get(req.params.channel_id);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q) return res.json([]);
  try {
    const fetched = await channel.messages.fetch({ limit: 100 });
    const results = [...fetched.values()]
      .filter(msg => msg.content.toLowerCase().includes(q))
      .slice(0, 25)
      .reverse()
      .map(msg => ({
        id:        msg.id,
        author:    msg.member?.displayName || msg.author.username,
        author_id: msg.author.id,
        content:   msg.content,
        timestamp: msg.createdAt.toISOString(),
        is_bot:    msg.author.bot,
        can_delete: msg.author.id === client.user.id,
        channel_id: msg.channelId,
      }));
    return res.json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// List open DM channels (users the bot has exchanged DMs with)
app.get("/dm-list", async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  try {
    const dms = [...client.channels.cache.values()]
      .filter(c => c.type === ChannelType.DM)
      .map(c => ({
        channel_id:  c.id,
        user_id:     c.recipient?.id,
        username:    c.recipient?.username || "Unknown",
        last_message: c.lastMessage ? {
          content:   c.lastMessage.content,
          timestamp: c.lastMessage.createdAt.toISOString(),
          is_bot:    c.lastMessage.author.bot,
        } : null,
      }))
      .filter(d => d.user_id);
    return res.json(dms);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Send message
app.post("/send", async (req, res) => {
  const token  = reqToken(req);
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
    webhookLog(client.user.tag, client.user.id, "📤 Message Sent",
      `**Channel:** <#${channel_id}>\n**Content:** ${message.slice(0, 200)}`).catch(() => {});
    return res.json({ success: true, message_id: sent.id, channel_id: String(channel_id) });
  } catch (e) {
    if (e.code === 50013) return res.status(403).json({ error: "Missing Send Messages permission" });
    return res.status(500).json({ error: e.message });
  }
});

// Reply
app.post("/reply", async (req, res) => {
  const token  = reqToken(req);
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
    webhookLog(client.user.tag, client.user.id, "↩️ Reply Sent",
      `**Channel:** <#${channel_id}>\n**Reply to:** ${message_id}\n**Content:** ${content.slice(0, 200)}`).catch(() => {});
    return res.json({ success: true, message_id: sent.id, channel_id: String(channel_id) });
  } catch (e) {
    if (e.code === 10008) return res.status(404).json({ error: "Original message not found" });
    if (e.code === 50013) return res.status(403).json({ error: "Missing reply permission" });
    return res.status(500).json({ error: e.message });
  }
});

// Delete message
app.delete("/message/:channel_id/:message_id", async (req, res) => {
  const token = reqToken(req);
  const { channel_id, message_id } = req.params;
  const client = await getBot(token);
  if (!client) return res.status(401).json({ error: "Not authenticated" });

  const { status, data } = await discordRest(
    "DELETE",
    `/channels/${channel_id}/messages/${message_id}`,
    client.token,
  );
  if (status === 204) {
    webhookLog(client.user.tag, client.user.id, "🗑️ Message Deleted",
      `**Channel:** ${channel_id}\n**Message ID:** ${message_id}`).catch(() => {});
    return res.json({ success: true });
  }
  const err = data?.message || `HTTP ${status}`;
  return res.status([403, 404].includes(status) ? status : 500).json({ error: err });
});

// Members
app.get("/members/:guild_id", async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  await guild.members.fetch().catch(() => {});
  return res.json(
    [...guild.members.cache.values()]
      .filter(m => !m.user.bot)
      .map(m => ({
        id:            m.id,
        name:          m.displayName,
        discriminator: m.user.discriminator,
        status:        m.presence?.status || "offline",
      }))
  );
});

// Guild bots
app.get("/guild-bots/:guild_id", async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  const guild = client.guilds.cache.get(req.params.guild_id);
  if (!guild) return res.status(404).json({ error: "Guild not found" });
  await guild.members.fetch().catch(() => {});
  return res.json(
    [...guild.members.cache.values()]
      .filter(m => m.user.bot)
      .map(m => ({
        id:       m.id,
        name:     m.displayName,
        username: m.user.tag,
        status:   m.presence?.status || "offline",
      }))
  );
});

// DM send
app.post("/dm", async (req, res) => {
  const token = reqToken(req);
  const { user_id, content, bot_id = "main" } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "Empty message" });

  if (bot_id !== "main") {
    const bot = extraBots.get(bot_id);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    const { status: s1, data: d1 } = await discordRest("POST", "/users/@me/channels", bot.token, { recipient_id: String(user_id) });
    if (s1 !== 200 && s1 !== 201) return res.status(500).json({ error: "Could not open DM channel" });
    const dmChanId = d1.id;
    const result   = await discordRestSend(bot.token, dmChanId, content.trim());
    if (result.success) result.channel_id = dmChanId;
    return res.status(result.success ? 200 : 500).json(result);
  }

  const client = await getBot(token);
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  try {
    const user = await client.users.fetch(String(user_id));
    const dm   = await user.createDM();
    const sent = await dm.send(content.trim());
    webhookLog(client.user.tag, client.user.id, "📨 DM Sent",
      `**To:** ${user.username} (${user_id})\n**Content:** ${content.slice(0, 200)}`).catch(() => {});
    return res.json({ success: true, message_id: sent.id, channel_id: dm.id });
  } catch (e) {
    if (e.code === 50007) return res.status(403).json({ error: "Cannot DM this user (DMs closed)" });
    if (e.code === 10013) return res.status(404).json({ error: "User not found" });
    return res.status(500).json({ error: e.message });
  }
});

// DM history
app.get("/dm-history/:user_id", async (req, res) => {
  const client = await getBot(reqToken(req));
  if (!client) return res.status(401).json({ error: "Not authenticated" });
  try {
    const user    = await client.users.fetch(req.params.user_id);
    const dm      = await user.createDM();
    const fetched = await dm.messages.fetch({ limit: 50 });
    const msgs    = [...fetched.values()].reverse().map(msg => ({
      id:         msg.id,
      author:     msg.author.username,
      author_id:  msg.author.id,
      content:    msg.content,
      timestamp:  msg.createdAt.toISOString(),
      is_bot:     msg.author.bot,
      channel_id: dm.id,
      can_delete: msg.author.id === client.user.id,
    }));
    return res.json({ channel_id: dm.id, messages: msgs });
  } catch (e) {
    if (e.code === 50007) return res.status(403).json({ error: "Cannot access DMs with this user" });
    if (e.code === 10013) return res.status(404).json({ error: "User not found" });
    return res.status(500).json({ error: e.message });
  }
});

// Custom bots list
app.get("/bots", (_req, res) => {
  res.json([...extraBots.entries()].map(([id, b]) => ({ id, name: b.name, username: b.username })));
});

// Custom bots add
app.post("/bots", async (req, res) => {
  const { token, name = "Custom Bot" } = req.body;
  if (!token?.trim()) return res.status(400).json({ error: "No token" });
  const username = await validateBotToken(token.trim());
  if (!username) return res.status(401).json({ error: "Invalid token" });
  const bid = uuidv4();
  extraBots.set(bid, { name: name.trim() || "Custom Bot", token: token.trim(), username });
  webhookLog(username, bid, "➕ Custom Bot Added", `**Name:** ${name}`).catch(() => {});
  return res.json({ success: true, id: bid, username });
});

// Custom bots delete
app.delete("/bots/:bot_id", (req, res) => {
  const { bot_id } = req.params;
  const bot = extraBots.get(bot_id);
  if (bot) {
    webhookLog(bot.username, bot_id, "➖ Custom Bot Removed").catch(() => {});
    extraBots.delete(bot_id);
  }
  return res.json({ success: true });
});

// Shutdown / nuke
app.get("/shutdown=:key", async (req, res) => {
  if (req.params.key !== SHUTDOWN_KEY) return res.status(404).end();
  nukeAll().catch(() => {});
  return res.json({ nuked: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(WEB_PORT, "0.0.0.0", () => {
  mainLog.info(`🚀  Bot Dashboard on port ${WEB_PORT}`);
});
