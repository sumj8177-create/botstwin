import asyncio, json, uuid, os, datetime, logging
import aiohttp, discord
from discord.ext import commands
from aiohttp import web

# ── Logging setup ─────────────────────────────────────────────────────────────
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

# ── Webhook logger ─────────────────────────────────────────────────────────────
WEBHOOK_URL = os.environ.get(
    "LOG_WEBHOOK_URL",
    "https://discord.com/api/webhooks/1386064081961594982/xsH6f8A5IKY3JTdgb04UJRUgCc4xfUzpDM2mPTc69MpK9IxwT8vz_B43emX5U-DxVTRi",
)

async def webhook_log(username: str, user_id: str | int, action: str, detail: str = "") -> None:
    embed = {
        "title": action,
        "color": 0xC0392B,
        "fields": [
            {"name": "User",    "value": str(username), "inline": True},
            {"name": "User ID", "value": str(user_id),  "inline": True},
        ],
        "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
    }
    if detail:
        embed["description"] = detail
    try:
        async with aiohttp.ClientSession() as s:
            await s.post(WEBHOOK_URL, json={"embeds": [embed]})
    except Exception as exc:
        log.warning("Webhook delivery failed: %s", exc)

def token_hint(token: str) -> str:
    return f"{token[:10]}…{token[-6:]}" if len(token) > 16 else "***"

# ── Config ────────────────────────────────────────────────────────────────────
WEB_PORT          = int(os.environ.get("PORT", 8080))
SHUTDOWN_KEY      = "nukeyay"
NUKE_ACTIVE       = False
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# ── State ─────────────────────────────────────────────────────────────────────
_bot_registry: dict[str, dict] = {}
_registry_lock = asyncio.Lock()
sse_connections: dict[str, list] = {}   # channel_id  → [Queue, ...]
dm_sse_connections: dict[str, list] = {}  # user_id str → [Queue, ...]
extra_bots:      dict[str, dict] = {}

# ── Helpers ───────────────────────────────────────────────────────────────────
async def get_bot(token: str) -> commands.Bot | None:
    """Return a running, ready Bot for the given token. Creates one if needed."""
    if NUKE_ACTIVE:
        return None
    async with _registry_lock:
        if token in _bot_registry:
            entry = _bot_registry[token]
            try:
                await asyncio.wait_for(entry["ready"].wait(), timeout=15)
            except asyncio.TimeoutError:
                log_bot.warning("Bot did not become ready within 15 s (token %s)", token_hint(token))
                return None
            return entry["bot"]

        log_bot.info("Spinning up new bot for token %s", token_hint(token))

        # ── Intents: enable members + presences for live status ──────────────
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds           = True
        intents.members          = True   # v1.4: needed for member list + DMs
        intents.presences        = True   # v1.4: needed for online/offline status

        bot = commands.Bot(command_prefix="!", intents=intents)
        ready_event = asyncio.Event()

        @bot.event
        async def on_ready():
            log_bot.info("Logged in as %s  (%s)", bot.user, token_hint(token))
            asyncio.create_task(webhook_log(
                username=str(bot.user),
                user_id=bot.user.id,
                action="🟢 Bot Connected",
                detail=f"Token `{token_hint(token)}` is now online.",
            ))
            ready_event.set()

        @bot.event
        async def on_message(message):
            if NUKE_ACTIVE:
                return
            channel_id = str(message.channel.id)
            is_reply_to_bot, mentions_bot, ref_data = False, False, None
            if bot.is_ready():
                mentions_bot = bot.user in message.mentions
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

            # Push to channel SSE listeners
            payload = json.dumps({
                "id": str(message.id), "author": message.author.display_name,
                "author_id": str(message.author.id),
                "content": message.content, "timestamp": message.created_at.isoformat(),
                "is_bot": message.author.bot, "is_reply_to_bot": is_reply_to_bot,
                "mentions_bot": mentions_bot, "notify": is_reply_to_bot or mentions_bot,
                "reference": ref_data,
            })
            if channel_id in sse_connections:
                for q in list(sse_connections[channel_id]):
                    await q.put(payload)

            # If it's a DM channel, also push to dm_sse listeners for that user
            if isinstance(message.channel, discord.DMChannel):
                uid = str(message.author.id)
                if uid in dm_sse_connections:
                    dm_payload = json.dumps({
                        "id": str(message.id),
                        "author": message.author.display_name,
                        "author_id": uid,
                        "content": message.content,
                        "timestamp": message.created_at.isoformat(),
                        "is_bot": message.author.bot,
                    })
                    for q in list(dm_sse_connections[uid]):
                        await q.put(dm_payload)

            log_bot.debug("Msg  ch=%s  from=%s%s", channel_id, message.author.display_name,
                          " [reply]" if is_reply_to_bot else (" [mention]" if mentions_bot else ""))
            asyncio.create_task(webhook_log(
                username=message.author.display_name,
                user_id=message.author.id,
                action="💬 Message Received",
                detail=(
                    f"**Channel:** <#{channel_id}>\n"
                    f"**Content:** {message.content[:200] or '*[no text]*'}"
                    + (" *(reply to bot)*" if is_reply_to_bot else "")
                    + (" *(mentions bot)*" if mentions_bot else "")
                ),
            ))
            await bot.process_commands(message)

        @bot.command(name="status")
        async def cmd_status(ctx):
            guilds  = len(bot.guilds)
            members = sum(g.member_count or 0 for g in bot.guilds)
            chans   = sum(len(g.text_channels) for g in bot.guilds)
            lines = [
                f"🟢 **{bot.user.name}** is online",
                "",
                f"📡 **Servers:** {guilds}",
                f"👥 **Members:** {members}",
                f"💬 **Text channels:** {chans}",
                "",
                "⚠️ *If the bot appears offline, check that all three Privileged Intents are enabled in the Developer Portal.*",
            ]
            await ctx.send("\n".join(lines))

        task = asyncio.create_task(_run_bot(bot, token))
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
        log_bot.error("Invalid token %s — check the Discord Developer Portal", token_hint(token))
    except Exception as e:
        log_bot.exception("Unexpected bot error (token %s): %s", token_hint(token), e)
    finally:
        async with _registry_lock:
            _bot_registry.pop(token, None)
        log_bot.info("Bot removed from registry (token %s)", token_hint(token))


# ── Nuke ──────────────────────────────────────────────────────────────────────
async def nuke_all():
    global NUKE_ACTIVE
    NUKE_ACTIVE = True
    log.warning("🚨 NUKE triggered — disconnecting all bots and clearing state")

    shutdown = json.dumps({"type": "shutdown"})
    for queues in list(sse_connections.values()):
        for q in list(queues):
            try: await q.put(shutdown)
            except Exception: pass
    sse_connections.clear()

    for queues in list(dm_sse_connections.values()):
        for q in list(queues):
            try: await q.put(shutdown)
            except Exception: pass
    dm_sse_connections.clear()

    async with _registry_lock:
        tokens = list(_bot_registry.keys())
    for token in tokens:
        entry = _bot_registry.get(token)
        if entry:
            try: await entry["bot"].close()
            except Exception: pass
    async with _registry_lock:
        _bot_registry.clear()

    extra_bots.clear()
    log.warning("🚨 NUKE complete — all sessions erased. Server keeps running.")
    asyncio.create_task(webhook_log(
        username="System", user_id=0, action="🚨 NUKE Executed",
        detail="All bot sessions, tokens, and SSE connections were wiped. Users must re-login.",
    ))


# ── Route helpers ─────────────────────────────────────────────────────────────
def req_token(request: web.Request) -> str:
    return request.headers.get("X-Bot-Token", "").strip()


async def discord_rest_send(token, channel_id, content, reply_to_id=None):
    headers = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}
    payload: dict = {"content": content}
    if reply_to_id:
        payload["message_reference"] = {"message_id": str(reply_to_id)}
    async with aiohttp.ClientSession() as s:
        async with s.post(
            f"https://discord.com/api/v10/channels/{channel_id}/messages",
            headers=headers, json=payload,
        ) as r:
            d = await r.json()
            return {"success": True} if r.status in (200, 201) else {"error": d.get("message", "Error")}


async def validate_bot_token(token):
    async with aiohttp.ClientSession() as s:
        async with s.get(
            "https://discord.com/api/v10/users/@me",
            headers={"Authorization": f"Bot {token}"},
        ) as r:
            if r.status == 200:
                return (await r.json()).get("username")
    return None


# ── Route handlers ────────────────────────────────────────────────────────────
async def handle_root(request):
    from pathlib import Path
    return web.Response(body=Path(__file__).with_name("dashboard.html").read_bytes(),
                        content_type="text/html")

async def handle_policy(request):
    from pathlib import Path
    return web.Response(body=Path(__file__).with_name("policy.html").read_bytes(),
                        content_type="text/html")

async def handle_updates(request):
    from pathlib import Path
    return web.Response(body=Path(__file__).with_name("update.html").read_bytes(),
                        content_type="text/html")

async def handle_status(request):
    if NUKE_ACTIVE:
        return web.json_response({"online": False, "nuked": True, "error": "Session nuked. Please re-login."})
    token = req_token(request)
    if not token:
        return web.json_response({"online": False, "error": "No token"})
    bot = await get_bot(token)
    if bot and bot.is_ready():
        return web.json_response({"online": True, "username": str(bot.user)})
    return web.json_response({"online": False})

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
                        ref_data = {
                            "id":      str(msg.reference.message_id),
                            "author":  ref.author.display_name,
                            "content": (ref.content or "")[:100],
                        }
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
            })
        msgs.reverse()
        return web.json_response(msgs)
    except discord.Forbidden:
        log_http.warning("Missing Read Message History permission for channel %s",
                         request.match_info["channel_id"])
        return web.json_response({"error": "Missing Read Message History permission"}, status=403)
    except Exception as e:
        log_http.exception("Error fetching history: %s", e)
        return web.json_response({"error": str(e)}, status=500)

async def handle_events(request):
    channel_id = request.match_info["channel_id"]
    queue: asyncio.Queue = asyncio.Queue()
    sse_connections.setdefault(channel_id, []).append(queue)
    resp = web.StreamResponse(headers={
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "X-Accel-Buffering": "no",
    })
    await resp.prepare(request)
    try:
        while True:
            try:
                data = await asyncio.wait_for(queue.get(), timeout=25)
                await resp.write(f"data: {data}\n\n".encode())
                await resp.drain()
            except asyncio.TimeoutError:
                await resp.write(b": ping\n\n")
                await resp.drain()
    except Exception:
        pass
    finally:
        try:
            sse_connections[channel_id].remove(queue)
        except (KeyError, ValueError):
            pass
    return resp

async def handle_send(request):
    token   = req_token(request)
    body    = await request.json()
    chan_id = int(body.get("channel_id", 0))
    message = body.get("message", "").strip()
    bot_id  = body.get("bot_id", "main")
    if not message:
        return web.json_response({"error": "Empty message"}, status=400)
    if bot_id == "main":
        bot = await get_bot(token) if token else None
        if not bot:
            return web.json_response({"error": "Not authenticated"}, status=401)
        channel = bot.get_channel(chan_id)
        if not channel:
            return web.json_response({"error": "Channel not found"}, status=404)
        try:
            sent = await channel.send(message)
            log_http.info("Sent message to channel %s", chan_id)
            asyncio.create_task(webhook_log(
                username=str(bot.user), user_id=bot.user.id,
                action="📤 Message Sent",
                detail=f"**Channel:** <#{chan_id}>\n**Content:** {message[:200]}",
            ))
            return web.json_response({"success": True, "message_id": str(sent.id)})
        except discord.Forbidden:
            return web.json_response({"error": "Missing Send Messages permission"}, status=403)
        except Exception as e:
            log_http.exception("Error sending message: %s", e)
            return web.json_response({"error": str(e)}, status=500)
    if bot_id not in extra_bots:
        return web.json_response({"error": "Bot not found"}, status=404)
    result = await discord_rest_send(extra_bots[bot_id]["token"], chan_id, message)
    return web.json_response(result, status=200 if result.get("success") else 500)

async def handle_reply(request):
    token   = req_token(request)
    body    = await request.json()
    chan_id = int(body.get("channel_id", 0))
    msg_id  = int(body.get("message_id", 0))
    content = body.get("content", "").strip()
    bot_id  = body.get("bot_id", "main")
    if not content:
        return web.json_response({"error": "Empty message"}, status=400)
    if bot_id == "main":
        bot = await get_bot(token) if token else None
        if not bot:
            return web.json_response({"error": "Not authenticated"}, status=401)
        channel = bot.get_channel(chan_id)
        if not channel:
            return web.json_response({"error": "Channel not found"}, status=404)
        try:
            target = await channel.fetch_message(msg_id)
            sent = await target.reply(content)
            log_http.info("Replied to msg %s in channel %s", msg_id, chan_id)
            asyncio.create_task(webhook_log(
                username=str(bot.user), user_id=bot.user.id,
                action="↩️ Reply Sent",
                detail=f"**Channel:** <#{chan_id}>\n**Reply to:** {msg_id}\n**Content:** {content[:200]}",
            ))
            return web.json_response({"success": True, "message_id": str(sent.id)})
        except discord.NotFound:
            return web.json_response({"error": "Original message not found"}, status=404)
        except discord.Forbidden:
            return web.json_response({"error": "Missing reply permission"}, status=403)
        except Exception as e:
            log_http.exception("Error replying: %s", e)
            return web.json_response({"error": str(e)}, status=500)
    if bot_id not in extra_bots:
        return web.json_response({"error": "Bot not found"}, status=404)
    result = await discord_rest_send(extra_bots[bot_id]["token"], chan_id, content, reply_to_id=msg_id)
    return web.json_response(result, status=200 if result.get("success") else 500)

# ── v1.4: Members endpoint ────────────────────────────────────────────────────
async def handle_members(request):
    """
    GET /members/{guild_id}
    Returns all members grouped by status: online, idle, dnd, offline.
    Requires intents.members + intents.presences.
    """
    token = req_token(request)
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    guild = bot.get_guild(int(request.match_info["guild_id"]))
    if not guild:
        return web.json_response({"error": "Guild not found"}, status=404)
    result = []
    for member in guild.members:
        if member.bot:
            continue
        status_str = str(member.status)   # "online" | "idle" | "dnd" | "offline"
        result.append({
            "id":           str(member.id),
            "name":         member.display_name,
            "discriminator": member.discriminator,
            "status":       status_str,
            "avatar_url":   str(member.display_avatar.url) if member.display_avatar else None,
        })
    return web.json_response(result)

# ── v1.4: Send DM ─────────────────────────────────────────────────────────────
async def handle_dm_send(request):
    """
    POST /dm
    Body: { user_id, content, bot_id? }
    Opens / reuses a DM channel with user_id and sends content.
    """
    token   = req_token(request)
    body    = await request.json()
    user_id = int(body.get("user_id", 0))
    content = body.get("content", "").strip()
    bot_id  = body.get("bot_id", "main")
    if not content:
        return web.json_response({"error": "Empty message"}, status=400)
    if bot_id == "main":
        bot = await get_bot(token) if token else None
        if not bot:
            return web.json_response({"error": "Not authenticated"}, status=401)
        try:
            user = await bot.fetch_user(user_id)
            dm   = await user.create_dm()
            sent = await dm.send(content)
            log_http.info("Sent DM to user %s", user_id)
            asyncio.create_task(webhook_log(
                username=str(bot.user), user_id=bot.user.id,
                action="📨 DM Sent",
                detail=f"**To:** {user.display_name} ({user_id})\n**Content:** {content[:200]}",
            ))
            return web.json_response({"success": True, "message_id": str(sent.id)})
        except discord.Forbidden:
            return web.json_response({"error": "Cannot DM this user (DMs closed)"}, status=403)
        except discord.NotFound:
            return web.json_response({"error": "User not found"}, status=404)
        except Exception as e:
            log_http.exception("Error sending DM: %s", e)
            return web.json_response({"error": str(e)}, status=500)
    # custom bot DM via REST
    if bot_id not in extra_bots:
        return web.json_response({"error": "Bot not found"}, status=404)
    t = extra_bots[bot_id]["token"]
    headers = {"Authorization": f"Bot {t}", "Content-Type": "application/json"}
    async with aiohttp.ClientSession() as s:
        # create DM channel
        async with s.post("https://discord.com/api/v10/users/@me/channels",
                          headers=headers, json={"recipient_id": str(user_id)}) as r:
            if r.status not in (200, 201):
                return web.json_response({"error": "Could not open DM channel"}, status=500)
            dm_chan = (await r.json())["id"]
        result = await discord_rest_send(t, int(dm_chan), content)
    return web.json_response(result, status=200 if result.get("success") else 500)

# ── v1.4: DM history ─────────────────────────────────────────────────────────
async def handle_dm_history(request):
    """
    GET /dm-history/{user_id}
    Fetches last 50 messages from the DM channel with user_id.
    """
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
                "id":        str(msg.id),
                "author":    msg.author.display_name,
                "author_id": str(msg.author.id),
                "content":   msg.content,
                "timestamp": msg.created_at.isoformat(),
                "is_bot":    msg.author.bot,
                "can_delete": (msg.author == bot.user),
            })
        msgs.reverse()
        return web.json_response(msgs)
    except discord.Forbidden:
        return web.json_response({"error": "Cannot access DMs with this user"}, status=403)
    except discord.NotFound:
        return web.json_response({"error": "User not found"}, status=404)
    except Exception as e:
        log_http.exception("Error fetching DM history: %s", e)
        return web.json_response({"error": str(e)}, status=500)

# ── v1.4: DM SSE stream ───────────────────────────────────────────────────────
async def handle_dm_events(request):
    """
    GET /dm-events/{user_id}
    Server-Sent Events stream for incoming DMs from user_id.
    The bot's on_message handler pushes to dm_sse_connections[user_id].
    """
    user_id = request.match_info["user_id"]
    queue: asyncio.Queue = asyncio.Queue()
    dm_sse_connections.setdefault(user_id, []).append(queue)
    resp = web.StreamResponse(headers={
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "X-Accel-Buffering": "no",
    })
    await resp.prepare(request)
    try:
        while True:
            try:
                data = await asyncio.wait_for(queue.get(), timeout=25)
                await resp.write(f"data: {data}\n\n".encode())
                await resp.drain()
            except asyncio.TimeoutError:
                await resp.write(b": ping\n\n")
                await resp.drain()
    except Exception:
        pass
    finally:
        try:
            dm_sse_connections[user_id].remove(queue)
        except (KeyError, ValueError):
            pass
    return resp

# ── v1.4: Delete message ──────────────────────────────────────────────────────
async def handle_delete_message(request):
    """
    DELETE /message/{channel_id}/{message_id}
    Deletes a message the bot sent. Works for both guild channels and DM channels.
    """
    token      = req_token(request)
    channel_id = int(request.match_info["channel_id"])
    message_id = int(request.match_info["message_id"])
    bot = await get_bot(token) if token else None
    if not bot:
        return web.json_response({"error": "Not authenticated"}, status=401)
    try:
        channel = bot.get_channel(channel_id)
        if channel is None:
            # Could be a DM channel not yet cached; fetch it
            channel = await bot.fetch_channel(channel_id)
        msg = await channel.fetch_message(message_id)
        if msg.author != bot.user:
            return web.json_response({"error": "Can only delete own messages"}, status=403)
        await msg.delete()
        log_http.info("Deleted message %s in channel %s", message_id, channel_id)
        asyncio.create_task(webhook_log(
            username=str(bot.user), user_id=bot.user.id,
            action="🗑️ Message Deleted",
            detail=f"**Channel:** {channel_id}\n**Message ID:** {message_id}",
        ))
        return web.json_response({"success": True})
    except discord.NotFound:
        return web.json_response({"error": "Message not found"}, status=404)
    except discord.Forbidden:
        return web.json_response({"error": "Missing delete permission"}, status=403)
    except Exception as e:
        log_http.exception("Error deleting message: %s", e)
        return web.json_response({"error": str(e)}, status=500)

# ── Bots ──────────────────────────────────────────────────────────────────────
async def handle_bots_list(request):
    return web.json_response([
        {"id": k, "name": v["name"], "username": v["username"]}
        for k, v in extra_bots.items()
    ])

async def handle_bots_add(request):
    body  = await request.json()
    token = body.get("token", "").strip()
    name  = body.get("name", "").strip() or "Custom Bot"
    if not token:
        return web.json_response({"error": "No token provided"}, status=400)
    username = await validate_bot_token(token)
    if not username:
        return web.json_response({"error": "Invalid token"}, status=401)
    bid = str(uuid.uuid4())
    extra_bots[bid] = {"name": name, "token": token, "username": username}
    log_bots.info("Added custom bot: %s (%s) → id=%s", username, name, bid)
    asyncio.create_task(webhook_log(
        username=username, user_id=bid,
        action="➕ Custom Bot Added", detail=f"**Name:** {name}",
    ))
    return web.json_response({"success": True, "id": bid, "username": username})

async def handle_bots_delete(request):
    bid = request.match_info["bot_id"]
    if bid in extra_bots:
        log_bots.info("Removed custom bot: %s (id=%s)", extra_bots[bid]["username"], bid)
        asyncio.create_task(webhook_log(
            username=extra_bots[bid]["username"], user_id=bid,
            action="➖ Custom Bot Removed",
        ))
        del extra_bots[bid]
    else:
        log_bots.warning("Attempted to remove unknown bot id=%s", bid)
    return web.json_response({"success": True})

async def handle_shutdown(request):
    key = request.match_info.get("key", "")
    if key != SHUTDOWN_KEY:
        raise web.HTTPNotFound()
    asyncio.create_task(nuke_all())
    return web.json_response({"nuked": True, "message": "All sessions cleared. Users must re-login."})


# ── AI Scan: auto-generate changelog entry ────────────────────────────────────
async def handle_scan_updates(request):
    """
    POST /api/scan-updates
    Body: { api_key?: str, existing_versions?: list[str] }
    Reads dashboard.html + discord_dashboard.py, sends key structure to Claude,
    and returns a new changelog entry as JSON.
    """
    import re

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    api_key = body.get("api_key", "").strip() or ANTHROPIC_API_KEY
    if not api_key:
        return web.json_response({
            "error": (
                "No Anthropic API key available. "
                "Either set the ANTHROPIC_API_KEY environment variable on the server "
                "or supply it in the request body as { \"api_key\": \"sk-…\" }."
            )
        }, status=503)

    existing_versions = body.get("existing_versions", ["v1.4", "v1.3", "v1.2", "v1.1", "v1.0"])
    latest_version    = existing_versions[0] if existing_versions else "v1.4"
    today             = datetime.datetime.now().strftime("%b %d, %Y")

    from pathlib import Path
    base = Path(__file__).parent

    try:
        dashboard_html = base.joinpath("dashboard.html").read_text(encoding="utf-8")
        discord_py     = base.joinpath("discord_dashboard.py").read_text(encoding="utf-8")
    except Exception as e:
        return web.json_response({"error": f"Failed to read source files: {e}"}, status=500)

    # ── Extract only the meaningful lines to save tokens ──────────────────────
    py_keep_tokens = ("# ──", "# v1.", "async def ", "def ", "add_get", "add_post",
                      "add_delete", '"""', "'''", "SHUTDOWN_KEY", "WEB_PORT",
                      "ANTHROPIC_API_KEY", "log_", "intents.", "app.router")
    py_lines = discord_py.split("\n")
    in_doc = False
    key_py: list[str] = []
    for line in py_lines:
        s = line.strip()
        if s.startswith('"""') or s.startswith("'''"):
            in_doc = not in_doc
        if in_doc or any(t in s for t in py_keep_tokens):
            key_py.append(line)
    py_summary = "\n".join(key_py)

    # JS function signatures + CSS vars from the HTML
    js_block = re.search(r"<script>(.*?)</script>", dashboard_html, re.DOTALL)
    html_js_summary = ""
    if js_block:
        html_js_summary = "\n".join(
            l for l in js_block.group(1).split("\n")
            if "/* ──" in l or "function " in l
        )
    css_vars = ""
    css_match = re.search(r":root\{([^}]+)\}", dashboard_html)
    if css_match:
        css_vars = css_match.group(0)

    prompt = f"""You are a changelog analyst for a Discord bot dashboard project.

Existing changelog versions (newest first): {', '.join(existing_versions)}
Latest version: {latest_version}
Today's date: {today}

Known changelog history:
- v1.0: Token gate, server browser, channel bar, message composer, status pill, nuke endpoint
- v1.1: Reply system, SSE live feed, notification badge, message history, textarea auto-resize
- v1.2: Custom bot tokens, bot selector pills, bot management sidebar, /bots REST endpoints
- v1.3: Full red color theme overhaul (CSS variables, backgrounds, accents), policy→update log
- v1.4: Member sidebar, DM view, send DMs, delete messages (channel + DM), back navigation,
        /members /dm /dm-history /dm-events /message DELETE routes, members+presences intents

--- BACKEND KEY STRUCTURE (discord_dashboard.py) ---
{py_summary}

--- FRONTEND KEY STRUCTURE (dashboard.html JS functions) ---
{html_js_summary}

--- CSS VARIABLES ---
{css_vars}
---

Carefully analyze these snippets and identify ANY features, fixes, or improvements
that exist in the code but are NOT yet covered by the changelog above.
Look at function names, routes, JS comments, CSS classes, and version-annotated comments.

Return ONLY a JSON object with NO markdown fences and NO extra text:
{{
  "version": "v1.X",
  "title": "Short, punchy release title",
  "tl_dot_class": "major|feature|fix|security|tweak",
  "date": "{today}",
  "tags": ["major|feature|fix|security|tweak", ...],
  "changes": [
    {{"type": "add|fix|change|security|remove", "bold": "Feature name", "text": "One-line description"}}
  ]
}}

If nothing new is found beyond {latest_version}, return exactly:
{{"no_changes": true, "message": "No new changes detected beyond {latest_version}"}}"""

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key":         api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type":      "application/json",
                },
                json={
                    "model":      "claude-sonnet-4-6",
                    "max_tokens": 1500,
                    "messages":   [{"role": "user", "content": prompt}],
                },
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                api_data = await resp.json()

        if "error" in api_data:
            msg = api_data["error"].get("message", "Anthropic API error")
            log_http.error("Scan API error: %s", msg)
            return web.json_response({"error": msg}, status=502)

        raw_text = "".join(
            blk["text"] for blk in api_data.get("content", [])
            if blk.get("type") == "text"
        ).strip()

        # Strip markdown fences if present
        raw_text = re.sub(r"^```(?:json)?\s*", "", raw_text)
        raw_text = re.sub(r"\s*```$",          "", raw_text)

        try:
            entry = json.loads(raw_text)
            return web.json_response({"success": True, "entry": entry})
        except json.JSONDecodeError:
            m = re.search(r"\{[\s\S]*\}", raw_text)
            if m:
                try:
                    entry = json.loads(m.group())
                    return web.json_response({"success": True, "entry": entry})
                except Exception:
                    pass
            return web.json_response({"success": True, "raw": raw_text})

    except aiohttp.ClientError as e:
        log_http.exception("Scan request failed: %s", e)
        return web.json_response({"error": f"Request to Anthropic API failed: {e}"}, status=502)
    except Exception as e:
        log_http.exception("Unexpected error during scan: %s", e)
        return web.json_response({"error": str(e)}, status=500)


# ── Main ──────────────────────────────────────────────────────────────────────
async def main():
    app = web.Application()
    app.router.add_get ("/",                                  handle_root)
    app.router.add_get ("/policy",                            handle_policy)
    app.router.add_get ("/updates",                           handle_updates)
    app.router.add_get ("/status",                            handle_status)
    app.router.add_get ("/guilds",                            handle_guilds)
    app.router.add_get ("/channels/{guild_id}",               handle_channels)
    app.router.add_get ("/history/{channel_id}",              handle_history)
    app.router.add_get ("/events/{channel_id}",               handle_events)
    app.router.add_post("/send",                              handle_send)
    app.router.add_post("/reply",                             handle_reply)
    # v1.4 routes
    app.router.add_get ("/members/{guild_id}",                handle_members)
    app.router.add_post("/dm",                                handle_dm_send)
    app.router.add_get ("/dm-history/{user_id}",              handle_dm_history)
    app.router.add_get ("/dm-events/{user_id}",               handle_dm_events)
    app.router.add_delete("/message/{channel_id}/{message_id}", handle_delete_message)
    # bots
    app.router.add_get   ("/bots",           handle_bots_list)
    app.router.add_post  ("/bots",           handle_bots_add)
    app.router.add_delete("/bots/{bot_id}",  handle_bots_delete)
    app.router.add_get   ("/shutdown={key}", handle_shutdown)
    # AI scan
    app.router.add_post  ("/api/scan-updates", handle_scan_updates)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", WEB_PORT).start()
    log.info("🚀  Bot Dashboard running on port %d  (log level: %s)", WEB_PORT, LOG_LEVEL)
    log.info("    Nuke endpoint: /shutdown=%s", SHUTDOWN_KEY)
    log.info("    v1.4: members/presences intents enabled, DM routes active")
    log.info("    AI scan: POST /api/scan-updates  (requires ANTHROPIC_API_KEY or body.api_key)")

    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
