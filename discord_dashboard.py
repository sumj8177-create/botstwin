import asyncio, json, uuid, os, datetime, logging
import aiohttp, discord
from discord.ext import commands
from aiohttp import web

# ── Logging ───────────────────────────────────────────────────────────────────
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logging.getLogger("discord").setLevel(logging.WARNING)
logging.getLogger("discord.http").setLevel(logging.WARNING)
logging.getLogger("aiohttp.access").setLevel(logging.WARNING)

log      = logging.getLogger("dashboard")
log_bot  = logging.getLogger("dashboard.bot")
log_bots = logging.getLogger("dashboard.bots")
log_http = logging.getLogger("dashboard.http")

# ── Shared HTTP session (created once, reused everywhere) ─────────────────────
_http: aiohttp.ClientSession | None = None

def http() -> aiohttp.ClientSession:
    global _http
    if _http is None or _http.closed:
        _http = aiohttp.ClientSession()
    return _http

# ── Webhook logger ─────────────────────────────────────────────────────────────
WEBHOOK_URL = os.environ.get(
    "LOG_WEBHOOK_URL",
    "https://discord.com/api/webhooks/1386064081961594982/xsH6f8A5IKY3JTdgb04UJRUgCc4xfUzpDM2mPTc69MpK9IxwT8vz_B43emX5U-DxVTRi",
)

async def webhook_log(username: str, user_id, action: str, detail: str = "") -> None:
    embed = {
        "title": action, "color": 0xC0392B,
        "fields": [
            {"name": "User",    "value": str(username), "inline": True},
            {"name": "User ID", "value": str(user_id),  "inline": True},
        ],
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    }
    if detail:
        embed["description"] = detail
    try:
        await http().post(WEBHOOK_URL, json={"embeds": [embed]})
    except Exception as exc:
        log.warning("Webhook failed: %s", exc)

def token_hint(token: str) -> str:
    return f"{token[:10]}…{token[-6:]}" if len(token) > 16 else "***"

# ── Config ─────────────────────────────────────────────────────────────────────
WEB_PORT     = int(os.environ.get("PORT", 8080))
SHUTDOWN_KEY = "nukeyay"
NUKE_ACTIVE  = False

# ── State ──────────────────────────────────────────────────────────────────────
_bot_registry: dict[str, dict] = {}         # token → {bot, ready, task}
_registry_lock = asyncio.Lock()
sse_connections:    dict[str, list] = {}     # channel_id → [Queue …]
dm_sse_connections: dict[str, list] = {}     # user_id    → [Queue …]
extra_bots:         dict[str, dict] = {}     # uuid → {name, token, username}

# ── Bot factory ───────────────────────────────────────────────────────────────
async def get_bot(token: str) -> commands.Bot | None:
    """Return the ready Bot for *token*, spinning one up if needed."""
    if NUKE_ACTIVE:
        return None

    # Fast path — already in registry
    async with _registry_lock:
        entry = _bot_registry.get(token)

    if entry:
        if entry["ready"].is_set():
            return entry["bot"]          # ← already ready, zero wait
        try:
            await asyncio.wait_for(entry["ready"].wait(), timeout=15)
            return entry["bot"]
        except asyncio.TimeoutError:
            log_bot.warning("Bot ready-timeout (token %s)", token_hint(token))
            return None

    # Slow path — create new bot
    log_bot.info("Spinning up bot for token %s", token_hint(token))

    intents = discord.Intents.default()
    intents.message_content = True
    intents.guilds           = True
    intents.members          = True   # live member list
    intents.presences        = True   # online/idle/dnd/offline status

    bot = commands.Bot(command_prefix="!", intents=intents)
    ready_event = asyncio.Event()

    @bot.event
    async def on_ready():
        log_bot.info("Logged in as %s", bot.user)
        asyncio.create_task(webhook_log(str(bot.user), bot.user.id, "🟢 Bot Connected",
                                        f"Token `{token_hint(token)}` is now online."))
        ready_event.set()

    @bot.event
    async def on_message(message: discord.Message):
        if NUKE_ACTIVE:
            return
        channel_id = str(message.channel.id)
        is_reply_to_bot = False
        mentions_bot    = bot.user in message.mentions if bot.is_ready() else False
        ref_data        = None

        if message.reference:
            try:
                ref = message.reference.resolved
                if ref and hasattr(ref, "author"):
                    is_reply_to_bot = ref.author == bot.user
                    ref_data = {
                        "id":      str(message.reference.message_id),
                        "author":  ref.author.display_name,
                        "content": (ref.content or "")[:100],
                    }
            except Exception:
                pass

        payload = json.dumps({
            "id": str(message.id), "author": message.author.display_name,
            "author_id": str(message.author.id),
            "content": message.content, "timestamp": message.created_at.isoformat(),
            "is_bot": message.author.bot,
            "is_reply_to_bot": is_reply_to_bot,
            "mentions_bot": mentions_bot,
            "notify": is_reply_to_bot or mentions_bot,
            "reference": ref_data,
            # bot's own channel messages can be deleted
            "can_delete": (message.author == bot.user),
            "channel_id": channel_id,
        })

        # Push to channel SSE listeners
        for q in list(sse_connections.get(channel_id, [])):
            await q.put(payload)

        # Push to DM SSE listeners if this is a DM
        if isinstance(message.channel, discord.DMChannel):
            uid = str(message.author.id)
            dm_payload = json.dumps({
                "id": str(message.id), "author": message.author.display_name,
                "author_id": uid, "content": message.content,
                "timestamp": message.created_at.isoformat(),
                "is_bot": message.author.bot,
                "channel_id": channel_id,          # ← DM channel id for deletes
                "can_delete": (message.author == bot.user),
            })
            for q in list(dm_sse_connections.get(uid, [])):
                await q.put(dm_payload)

        asyncio.create_task(webhook_log(
            message.author.display_name, message.author.id, "💬 Message Received",
            f"**Channel:** <#{channel_id}>\n**Content:** {message.content[:200] or '*[no text]*'}"
            + (" *(reply to bot)*" if is_reply_to_bot else "")
            + (" *(mentions bot)*" if mentions_bot else ""),
        ))
        await bot.process_commands(message)

    @bot.command(name="status")
    async def cmd_status(ctx):
        guilds  = len(bot.guilds)
        members = sum(g.member_count or 0 for g in bot.guilds)
        chans   = sum(len(g.text_channels) for g in bot.guilds)
        await ctx.send(
            f"🟢 **{bot.user.name}** is online\n\n"
            f"📡 **Servers:** {guilds}\n👥 **Members:** {members}\n"
            f"💬 **Text channels:** {chans}\n\n"
            "⚠️ *If the bot appears offline, ensure all three Privileged Intents are enabled.*"
        )

    task = asyncio.create_task(_run_bot(bot, token))
    async with _registry_lock:
        _bot_registry[token] = {"bot": bot, "ready": ready_event, "task": task}

    try:
        await asyncio.wait_for(ready_event.wait(), timeout=15)
    except asyncio.TimeoutError:
        log_bot.warning("Timed out waiting for bot ready (token %s)", token_hint(token))
        return None
    return bot


async def _run_bot(bot: commands.Bot, token: str):
    try:
        await bot.start(token)
    except discord.LoginFailure:
        log_bot.error("Invalid token %s", token_hint(token))
    except Exception as e:
        log_bot.exception("Bot error (token %s): %s", token_hint(token), e)
    finally:
        async with _registry_lock:
            _bot_registry.pop(token, None)


# ── Nuke ───────────────────────────────────────────────────────────────────────
async def nuke_all():
    global NUKE_ACTIVE
    NUKE_ACTIVE = True
    log.warning("🚨 NUKE triggered")
    shutdown = json.dumps({"type": "shutdown"})
    for qs in list(sse_connections.values()):
        for q in qs:
            try: await q.put(shutdown)
            except Exception: pass
    sse_connections.clear()
    for qs in list(dm_sse_connections.values()):
        for q in qs:
            try: await q.put(shutdown)
            except Exception: pass
    dm_sse_connections.clear()
    async with _registry_lock:
        tokens = list(_bot_registry.keys())
    for t in tokens:
        entry = _bot_registry.get(t)
        if entry:
            try: await entry["bot"].close()
            except Exception: pass
    async with _registry_lock:
        _bot_registry.clear()
    extra_bots.clear()
    log.warning("🚨 NUKE complete")
    asyncio.create_task(webhook_log("System", 0, "🚨 NUKE Executed",
        "All bot sessions, tokens, and SSE connections were wiped."))


# ── Helpers ────────────────────────────────────────────────────────────────────
def req_token(request: web.Request) -> str:
    return request.headers.get("X-Bot-Token", "").strip()

async def discord_rest_send(token, channel_id, content, reply_to_id=None):
    headers = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}
    payload: dict = {"content": content}
    if reply_to_id:
        payload["message_reference"] = {"message_id": str(reply_to_id)}
    async with http().post(
        f"https://discord.com/api/v10/channels/{channel_id}/messages",
        headers=headers, json=payload,
    ) as r:
        d = await r.json()
        return {"success": True, "message_id": str(d.get("id",""))} if r.status in (200, 201) \
               else {"error": d.get("message", "Error")}

async def validate_bot_token(token):
    async with http().get(
        "https://discord.com/api/v10/users/@me",
        headers={"Authorization": f"Bot {token}"},
    ) as r:
        if r.status == 200:
            return (await r.json()).get("username")
    return None

# ── Static files ───────────────────────────────────────────────────────────────
from pathlib import Path
_HERE = Path(__file__).parent

async def handle_root(request):
    return web.Response(body=(_HERE/"dashboard.html").read_bytes(), content_type="text/html")
async def handle_policy(request):
    return web.Response(body=(_HERE/"policy.html").read_bytes(), content_type="text/html")
async def handle_updates(request):
    return web.Response(body=(_HERE/"updates.html").read_bytes(), content_type="text/html")

# ── /status — lightweight, no get_bot() call if already ready ─────────────────
async def handle_status(request):
    if NUKE_ACTIVE:
        return web.json_response({"online": False, "nuked": True})
    token = req_token(request)
    if not token:
        return web.json_response({"online": False})
    # Use cached entry if ready; don't block on a new bot spin-up here
    async with _registry_lock:
        entry = _bot_registry.get(token)
    if entry and entry["ready"].is_set():
        bot = entry["bot"]
        if bot.is_ready():
            return web.json_response({"online": True, "username": str(bot.user)})
    # First login — do full get_bot
    bot = await get_bot(token)
    if bot and bot.is_ready():
        return web.json_response({"online": True, "username": str(bot.user)})
    return web.json_response({"online": False})

# ── Guilds & channels ──────────────────────────────────────────────────────────
async def handle_guilds(request):
    token = req_token(request)
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response([])
    return web.json_response([{"id": str(g.id), "name": g.name} for g in bot.guilds])

async def handle_channels(request):
    token = req_token(request)
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response([])
    guild = bot.get_guild(int(request.match_info["guild_id"]))
    if not guild:
        return web.json_response([])
    return web.json_response([{"id": str(c.id), "name": c.name} for c in guild.text_channels])

# ── History ────────────────────────────────────────────────────────────────────
async def handle_history(request):
    token = req_token(request)
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    channel = bot.get_channel(int(request.match_info["channel_id"]))
    if not channel:
        return web.json_response({"error": "Channel not found"}, status=404)
    try:
        msgs = []
        async for msg in channel.history(limit=50):
            ref_data, is_reply_to_bot = None, False
            mentions_bot = bot.user in msg.mentions if bot.is_ready() else False
            if msg.reference:
                try:
                    ref = msg.reference.resolved
                    if ref and hasattr(ref, "author"):
                        is_reply_to_bot = ref.author == bot.user
                        ref_data = {"id": str(msg.reference.message_id),
                                    "author": ref.author.display_name,
                                    "content": (ref.content or "")[:100]}
                except Exception:
                    pass
            msgs.append({
                "id": str(msg.id), "author": msg.author.display_name,
                "author_id": str(msg.author.id),
                "content": msg.content, "timestamp": msg.created_at.isoformat(),
                "is_bot": msg.author.bot, "is_reply_to_bot": is_reply_to_bot,
                "mentions_bot": mentions_bot, "notify": is_reply_to_bot or mentions_bot,
                "reference": ref_data,
                "can_delete": (msg.author == bot.user),
                "channel_id": str(channel.id),
            })
        msgs.reverse()
        return web.json_response(msgs)
    except discord.Forbidden:
        return web.json_response({"error": "Missing Read Message History permission"}, status=403)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# ── SSE ────────────────────────────────────────────────────────────────────────
async def _sse_stream(request, store: dict, key: str):
    """Generic SSE handler used by both channel and DM streams."""
    queue: asyncio.Queue = asyncio.Queue()
    store.setdefault(key, []).append(queue)
    resp = web.StreamResponse(headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
    await resp.prepare(request)
    try:
        while True:
            try:
                data = await asyncio.wait_for(queue.get(), timeout=20)
                await resp.write(f"data: {data}\n\n".encode())
            except asyncio.TimeoutError:
                await resp.write(b": ping\n\n")
    except Exception:
        pass
    finally:
        try: store[key].remove(queue)
        except (KeyError, ValueError): pass
    return resp

async def handle_events(request):
    return await _sse_stream(request, sse_connections, request.match_info["channel_id"])

async def handle_dm_events(request):
    return await _sse_stream(request, dm_sse_connections, request.match_info["user_id"])

# ── Send / Reply ───────────────────────────────────────────────────────────────
async def handle_send(request):
    token   = req_token(request)
    body    = await request.json()
    chan_id = int(body.get("channel_id", 0))
    message = body.get("message", "").strip()
    bot_id  = body.get("bot_id", "main")
    if not message:
        return web.json_response({"error": "Empty message"}, status=400)
    if bot_id != "main":
        if bot_id not in extra_bots:
            return web.json_response({"error": "Bot not found"}, status=404)
        result = await discord_rest_send(extra_bots[bot_id]["token"], chan_id, message)
        return web.json_response(result, status=200 if result.get("success") else 500)
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    channel = bot.get_channel(chan_id)
    if not channel:
        return web.json_response({"error": "Channel not found"}, status=404)
    try:
        sent = await channel.send(message)
        asyncio.create_task(webhook_log(str(bot.user), bot.user.id, "📤 Message Sent",
            f"**Channel:** <#{chan_id}>\n**Content:** {message[:200]}"))
        return web.json_response({"success": True, "message_id": str(sent.id),
                                  "channel_id": str(chan_id)})
    except discord.Forbidden:
        return web.json_response({"error": "Missing Send Messages permission"}, status=403)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def handle_reply(request):
    token   = req_token(request)
    body    = await request.json()
    chan_id = int(body.get("channel_id", 0))
    msg_id  = int(body.get("message_id", 0))
    content = body.get("content", "").strip()
    bot_id  = body.get("bot_id", "main")
    if not content:
        return web.json_response({"error": "Empty message"}, status=400)
    if bot_id != "main":
        if bot_id not in extra_bots:
            return web.json_response({"error": "Bot not found"}, status=404)
        result = await discord_rest_send(extra_bots[bot_id]["token"], chan_id, content, reply_to_id=msg_id)
        return web.json_response(result, status=200 if result.get("success") else 500)
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    channel = bot.get_channel(chan_id)
    if not channel:
        return web.json_response({"error": "Channel not found"}, status=404)
    try:
        target = await channel.fetch_message(msg_id)
        sent = await target.reply(content)
        asyncio.create_task(webhook_log(str(bot.user), bot.user.id, "↩️ Reply Sent",
            f"**Channel:** <#{chan_id}>\n**Reply to:** {msg_id}\n**Content:** {content[:200]}"))
        return web.json_response({"success": True, "message_id": str(sent.id),
                                  "channel_id": str(chan_id)})
    except discord.NotFound:
        return web.json_response({"error": "Original message not found"}, status=404)
    except discord.Forbidden:
        return web.json_response({"error": "Missing reply permission"}, status=403)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# ── DELETE message — works for both channel msgs and DM msgs ──────────────────
async def handle_delete_message(request):
    """
    DELETE /message/{channel_id}/{message_id}

    Uses the Discord REST API directly (no fetch_message round-trip) so it's
    fast.  The bot can only delete its own messages in DMs; in guild channels
    it can also delete any message if it has Manage Messages.
    """
    token      = req_token(request)
    channel_id = request.match_info["channel_id"]
    message_id = request.match_info["message_id"]

    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)

    headers = {"Authorization": f"Bot {bot.http.token}"}
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages/{message_id}"
    try:
        async with http().delete(url, headers=headers) as r:
            if r.status == 204:
                asyncio.create_task(webhook_log(str(bot.user), bot.user.id,
                    "🗑️ Message Deleted",
                    f"**Channel:** {channel_id}\n**Message ID:** {message_id}"))
                return web.json_response({"success": True})
            body = await r.json()
            err  = body.get("message", f"HTTP {r.status}")
            # 403 = missing perms (not own message in DM), 404 = already gone
            return web.json_response({"error": err}, status=r.status if r.status in (403,404) else 500)
    except Exception as e:
        log_http.exception("Delete error: %s", e)
        return web.json_response({"error": str(e)}, status=500)

# ── Members ────────────────────────────────────────────────────────────────────
async def handle_members(request):
    token = req_token(request)
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    guild = bot.get_guild(int(request.match_info["guild_id"]))
    if not guild:
        return web.json_response({"error": "Guild not found"}, status=404)
    return web.json_response([
        {"id": str(m.id), "name": m.display_name,
         "discriminator": m.discriminator, "status": str(m.status)}
        for m in guild.members if not m.bot
    ])

# ── Guild bots scan ────────────────────────────────────────────────────────────
async def handle_guild_bots(request):
    """GET /guild-bots/{guild_id} — returns every bot account in the server."""
    token = req_token(request)
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    guild = bot.get_guild(int(request.match_info["guild_id"]))
    if not guild:
        return web.json_response({"error": "Guild not found"}, status=404)
    return web.json_response([
        {
            "id":       str(m.id),
            "name":     m.display_name,
            "username": str(m),
            "status":   str(m.status),
        }
        for m in guild.members if m.bot
    ])

# ── DM send ────────────────────────────────────────────────────────────────────
async def handle_dm_send(request):
    """POST /dm  — opens a DM channel and sends content; returns the DM channel_id."""
    token   = req_token(request)
    body    = await request.json()
    user_id = int(body.get("user_id", 0))
    content = body.get("content", "").strip()
    bot_id  = body.get("bot_id", "main")
    if not content:
        return web.json_response({"error": "Empty message"}, status=400)

    if bot_id != "main":
        if bot_id not in extra_bots:
            return web.json_response({"error": "Bot not found"}, status=404)
        t = extra_bots[bot_id]["token"]
        hdrs = {"Authorization": f"Bot {t}", "Content-Type": "application/json"}
        async with http().post("https://discord.com/api/v10/users/@me/channels",
                               headers=hdrs, json={"recipient_id": str(user_id)}) as r:
            if r.status not in (200, 201):
                return web.json_response({"error": "Could not open DM channel"}, status=500)
            dm_chan_id = (await r.json())["id"]
        result = await discord_rest_send(t, int(dm_chan_id), content)
        if result.get("success"):
            result["channel_id"] = dm_chan_id
        return web.json_response(result, status=200 if result.get("success") else 500)

    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    try:
        user = await bot.fetch_user(user_id)
        dm   = await user.create_dm()
        sent = await dm.send(content)
        asyncio.create_task(webhook_log(str(bot.user), bot.user.id, "📨 DM Sent",
            f"**To:** {user.display_name} ({user_id})\n**Content:** {content[:200]}"))
        return web.json_response({"success": True,
                                  "message_id": str(sent.id),
                                  "channel_id": str(dm.id)})   # ← returned so frontend can delete
    except discord.Forbidden:
        return web.json_response({"error": "Cannot DM this user (DMs closed)"}, status=403)
    except discord.NotFound:
        return web.json_response({"error": "User not found"}, status=404)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# ── DM history ─────────────────────────────────────────────────────────────────
async def handle_dm_history(request):
    token   = req_token(request)
    user_id = int(request.match_info["user_id"])
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    try:
        user = await bot.fetch_user(user_id)
        dm   = await user.create_dm()
        msgs = []
        async for msg in dm.history(limit=50):
            msgs.append({
                "id":         str(msg.id),
                "author":     msg.author.display_name,
                "author_id":  str(msg.author.id),
                "content":    msg.content,
                "timestamp":  msg.created_at.isoformat(),
                "is_bot":     msg.author.bot,
                "channel_id": str(dm.id),        # ← needed for delete
                "can_delete": (msg.author == bot.user),
            })
        msgs.reverse()
        return web.json_response({"channel_id": str(dm.id), "messages": msgs})
    except discord.Forbidden:
        return web.json_response({"error": "Cannot access DMs with this user"}, status=403)
    except discord.NotFound:
        return web.json_response({"error": "User not found"}, status=404)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# ── Custom bots ────────────────────────────────────────────────────────────────
async def handle_bots_list(request):
    return web.json_response([{"id": k, "name": v["name"], "username": v["username"]}
                               for k, v in extra_bots.items()])

async def handle_bots_add(request):
    body  = await request.json()
    token = body.get("token", "").strip()
    name  = body.get("name", "").strip() or "Custom Bot"
    if not token:
        return web.json_response({"error": "No token"}, status=400)
    username = await validate_bot_token(token)
    if not username:
        return web.json_response({"error": "Invalid token"}, status=401)
    bid = str(uuid.uuid4())
    extra_bots[bid] = {"name": name, "token": token, "username": username}
    asyncio.create_task(webhook_log(username, bid, "➕ Custom Bot Added", f"**Name:** {name}"))
    return web.json_response({"success": True, "id": bid, "username": username})

async def handle_bots_delete(request):
    bid = request.match_info["bot_id"]
    if bid in extra_bots:
        asyncio.create_task(webhook_log(extra_bots[bid]["username"], bid, "➖ Custom Bot Removed"))
        del extra_bots[bid]
    return web.json_response({"success": True})

async def handle_shutdown(request):
    if request.match_info.get("key") != SHUTDOWN_KEY:
        raise web.HTTPNotFound()
    asyncio.create_task(nuke_all())
    return web.json_response({"nuked": True})

# ── App ────────────────────────────────────────────────────────────────────────
async def main():
    app = web.Application()
    r = app.router
    r.add_get   ("/",                                     handle_root)
    r.add_get   ("/policy",                               handle_policy)
    r.add_get   ("/updates",                              handle_updates)
    r.add_get   ("/status",                               handle_status)
    r.add_get   ("/guilds",                               handle_guilds)
    r.add_get   ("/channels/{guild_id}",                  handle_channels)
    r.add_get   ("/history/{channel_id}",                 handle_history)
    r.add_get   ("/events/{channel_id}",                  handle_events)
    r.add_post  ("/send",                                 handle_send)
    r.add_post  ("/reply",                                handle_reply)
    r.add_delete("/message/{channel_id}/{message_id}",    handle_delete_message)
    r.add_get   ("/members/{guild_id}",                   handle_members)
    r.add_get   ("/guild-bots/{guild_id}",                handle_guild_bots)
    r.add_post  ("/dm",                                   handle_dm_send)
    r.add_get   ("/dm-history/{user_id}",                 handle_dm_history)
    r.add_get   ("/dm-events/{user_id}",                  handle_dm_events)
    r.add_get   ("/bots",                                 handle_bots_list)
    r.add_post  ("/bots",                                 handle_bots_add)
    r.add_delete("/bots/{bot_id}",                        handle_bots_delete)
    r.add_get   ("/shutdown={key}",                       handle_shutdown)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", WEB_PORT).start()
    log.info("🚀  Bot Dashboard on port %d", WEB_PORT)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
