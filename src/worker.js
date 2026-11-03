/**
 * Telegram 自动回复 Bot（Cloudflare Workers，单文件，无需构建）
 *
 * 行为：
 *  - 在任意群里被 @ 到（或回复了机器人的消息）→ 引用你那条消息，回同一段文案 + 一张图 + 一排按钮
 *  - 私聊里发任何消息 → 同样回这套内容
 *  - 按钮点击 → 弹一个小提示 / 或再发一条内容（由 CALLBACKS 配置）
 *
 * 所有文案、图片、按钮都走环境变量，改完重新部署即可，不用动代码。
 */

// ---------- 小型工具 ----------

const BOUND_REPLY_MAX = 1024; // Telegram 图片说明文字上限

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseJSONArray(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    console.error('BUTTONS 不是合法 JSON：', raw);
    return null;
  }
}

function parseJSONObject(raw, label) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    console.error(`${label} 不是合法 JSON：`, raw);
    return null;
  }
}

// ---------- Telegram API ----------

async function tg(env, method, payload) {
  if (!env.BOT_TOKEN) throw new Error('缺少 BOT_TOKEN（用 wrangler secret put BOT_TOKEN 配置）');
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, description: `HTTP ${res.status}（响应不是 JSON）` };
  }
  if (!data.ok) {
    // 只打日志，不抛错：避免一个失败的回复把整个 webhook 打挂
    console.error(`[tg:${method}]`, data.error_code ?? '', data.description ?? data);
  }
  return data;
}

// 同一个 Worker 实例里缓存 getMe 结果，省一次请求
let cachedMe = null;

async function getMe(env) {
  if (cachedMe?.username) return cachedMe;
  // 配了 BOT_USERNAME 就不调 getMe：省一次请求，getMe 被限流时也能识别 @
  if (env.BOT_USERNAME) {
    cachedMe = { id: 0, username: String(env.BOT_USERNAME).replace(/^@/, '').trim() };
    return cachedMe;
  }
  const res = await tg(env, 'getMe', {});
  if (res.ok && res.result?.username) cachedMe = res.result;
  return cachedMe;
}

// ---------- 按钮 ----------

function normalizeButton(b) {
  if (typeof b === 'string') return { text: b, callback_data: b.slice(0, 64) };
  const btn = { text: String(b.text ?? b.label ?? '按钮') };
  if (b.url) {
    btn.url = String(b.url); // URL 按钮：点了直接打开链接
  } else {
    // 回调按钮：点了走 handleCallback，data 用 callback_data / data / text
    btn.callback_data = String(b.callback_data ?? b.data ?? btn.text).slice(0, 64);
  }
  return btn;
}

/**
 * BUTTONS 支持两种写法：
 *   1) 一维：["按钮A", "按钮B"]                 → 每个按钮独占一行
 *   2) 二维：[["按钮A","按钮B"], ["按钮C"]]      → 按行排列
 */
function buildKeyboard(env) {
  const rows = parseJSONArray(env.BUTTONS);
  if (!rows || !rows.length) return null;
  const isFlat = !Array.isArray(rows[0]);
  const keyboard = (isFlat ? rows.map((b) => [b]) : rows)
    .map((row) => (Array.isArray(row) ? row.map(normalizeButton) : [normalizeButton(row)]))
    .filter((row) => row.length);
  return keyboard.length ? keyboard : null;
}

// ---------- 触发判断 ----------

function mentionMatchers(message) {
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  const me = cachedMe;
  const uname = me?.username;
  const botId = me?.id;

  const hits = [];
  for (const e of entities) {
    if (e.type === 'mention' && uname) {
      const slice = text.slice(e.offset, e.offset + e.length);
      if (slice.toLowerCase() === '@' + uname.toLowerCase()) hits.push(slice);
    }
    if (e.type === 'text_mention' && botId && e.user?.id === botId) hits.push('text_mention');
    if (e.type === 'bot_command' && uname) {
      const slice = text.slice(e.offset, e.offset + e.length);
      if (slice.toLowerCase().endsWith('@' + uname.toLowerCase())) hits.push(slice);
    }
  }
  // 兜底：有些客户端不返回 entities，直接按文本里有没有 @username 判
  if (!hits.length && uname && new RegExp('@' + escapeRe(uname), 'i').test(text)) {
    hits.push('@' + uname);
  }
  return hits;
}

function isReplyToMe(message) {
  const target = message.reply_to_message;
  if (!target) return false;
  if (cachedMe?.id && target.from?.id === cachedMe.id) return true;
  if (cachedMe?.username && target.from?.username === cachedMe.username) return true;
  return false;
}

// ---------- 冷却（同一个人同一个群，N 秒内只回一次，防刷屏） ----------

const lastSeen = new Map();

function onCooldown(key, ms) {
  if (!ms || ms <= 0) return false;
  const now = Date.now();
  if (lastSeen.size > 5000) {
    for (const [k, t] of lastSeen) if (now - t > ms) lastSeen.delete(k);
  }
  const prev = lastSeen.get(key);
  if (prev && now - prev < ms) return true;
  lastSeen.set(key, now);
  return false;
}

// ---------- 回复 ----------

/**
 * IMAGE_URL 支持三种写法：
 *   https://...jpg   公网直链，原样用
 *   /meme.jpg        相对路径 → 拼成 https://<Worker 自己的域名>/meme.jpg
 *                    （图放 public/ 里，走 Worker 静态资源，不用另找图床）
 *   <file_id>        Telegram file_id，原样用
 */
function resolveImageUrl(raw, origin) {
  const s = (raw || '').trim();
  if (!s) return '';
  if (s.startsWith('/')) return origin ? origin + s : '';
  return s;
}

async function sendReply(env, chatId, replyToMessageId, origin) {
  const text = env.REPLY_TEXT || '（未配置 REPLY_TEXT）这是自动回复的固定文案，改 wrangler.toml 里的 REPLY_TEXT。';
  const keyboard = buildKeyboard(env);

  const base = {};
  if (env.PARSE_MODE) base.parse_mode = env.PARSE_MODE; // 默认纯文本，最稳；要 HTML 就设 PARSE_MODE=HTML
  if (keyboard) base.reply_markup = { inline_keyboard: keyboard };
  if (replyToMessageId) {
    base.reply_to_message_id = replyToMessageId; // 就是「引用你说的话」
    base.allow_sending_without_reply = true; // 原消息被删了也别报错
  }

  const image = resolveImageUrl(env.IMAGE_URL, origin);

  // 有图且文案放得进图片说明 → 一条图文消息，图和按钮一起出来
  if (image && text.length <= BOUND_REPLY_MAX) {
    const r = await tg(env, 'sendPhoto', { chat_id: chatId, photo: image, caption: text, ...base });
    if (r.ok) return r;
    // 图片挂了（URL 失效 / 不是 http 链接）→ 退回纯文字，别让用户等
  }

  const sent = await tg(env, 'sendMessage', { chat_id: chatId, text, ...base, link_preview_options: { is_disabled: true } });
  if (image && text.length > BOUND_REPLY_MAX) {
    const photoExtra = {};
    if (replyToMessageId) {
      photoExtra.reply_to_message_id = replyToMessageId;
      photoExtra.allow_sending_without_reply = true;
    }
    await tg(env, 'sendPhoto', { chat_id: chatId, photo: image, ...photoExtra });
  }
  return sent;
}

// ---------- 按钮点击 ----------

async function handleCallback(cq, env) {
  const map = parseJSONObject(env.CALLBACKS, 'CALLBACKS') || {};
  const data = cq.data ?? '';
  const entry = map[data];
  const cfg = typeof entry === 'string' ? { text: entry } : entry || {};
  const alertText = cfg.text ?? env.CALLBACK_DEFAULT ?? '';

  await tg(env, 'answerCallbackQuery', {
    callback_query_id: cq.id,
    ...(alertText ? { text: String(alertText).slice(0, 200) } : {}),
    ...(cfg.alert ? { show_alert: true } : {}),
  });

  // 想让按钮「点进去还能看到内容」→ 在 CALLBACKS 里给个 send 字段
  if (cfg.send && cq.message?.chat?.id) {
    await tg(env, 'sendMessage', {
      chat_id: cq.message.chat.id,
      text: String(cfg.send),
      reply_to_message_id: cq.message.message_id,
      allow_sending_without_reply: true,
      link_preview_options: { is_disabled: true },
      ...(env.PARSE_MODE ? { parse_mode: env.PARSE_MODE } : {}),
    });
  }
}

// ---------- Guest Mode（不进群也能被 @ 回复，Bot API 10.0）----------

/**
 * 任何人可以在一个「没拉这个 bot」的群里 @ 它：Telegram 送来一条 guest_message
 *（带 guest_query_id），bot 用 answerGuestQuery 回一张卡片 —— 全程不是群成员，
 * 也读不到群里的其他消息。
 *
 * 开关在 BotFather：/mybots → 选 bot → Bot Settings → supports_guest_queries
 *（getMe 里的 supports_guest_queries 字段能看出开没开）。
 *
 * 注意：guest 回答的形状是「inline 结果」，只能是一张卡（图或文 + 按钮），
 * 不能引用对方消息、不能发多条，跟群成员那套完整版式不是一回事。
 */

function guestCardId(queryId) {
  // id 只是这张卡的标识，用 query id 派生一个合法值就够了
  return `g${String(queryId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}`;
}

async function answerGuest(gm, env, origin) {
  const queryId = gm?.guest_query_id;
  if (!queryId) return;

  const full = env.REPLY_TEXT || '（未配置 REPLY_TEXT）这是自动回复的固定文案，改 wrangler.toml 里的 REPLY_TEXT。';
  // guest 卡片没有 1024 的说明上限那么宽松，超了就截断，别让整张卡被拒
  const text = full.length > BOUND_REPLY_MAX ? `${full.slice(0, BOUND_REPLY_MAX - 1)}…` : full;
  const keyboard = buildKeyboard(env);
  const image = resolveImageUrl(env.IMAGE_URL, origin);
  const id = guestCardId(queryId);
  const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
  const parse = env.PARSE_MODE ? { parse_mode: env.PARSE_MODE } : {};

  const photoCard = {
    type: 'photo',
    id,
    photo_url: image,
    thumbnail_url: image,
    title: '习包子',
    description: text.slice(0, 120),
    caption: text,
    ...parse,
    ...markup,
  };

  const articleCard = {
    type: 'article',
    id,
    title: '习包子',
    description: text.slice(0, 120),
    input_message_content: { message_text: text, ...parse },
    ...markup,
  };

  const log = (ok, note) =>
    console.log(
      '[guest]',
      JSON.stringify({
        chat: gm.chat?.type,
        chatId: gm.chat?.id ?? null,
        caller: gm.guest_bot_caller_user?.id ?? null,
        card: image ? 'photo' : 'article',
        ok,
        ...(note ? { note } : {}),
      }),
    );

  const r = await tg(env, 'answerGuestQuery', { guest_query_id: queryId, result: image ? photoCard : articleCard });
  if (r.ok) {
    log(true);
    return;
  }
  // 图片卡片被拒（图床不通 / 尺寸不合规）→ 退回纯文字卡片再试一次
  if (image) {
    const r2 = await tg(env, 'answerGuestQuery', { guest_query_id: queryId, result: articleCard });
    log(r2.ok, r2.ok ? 'photo 卡失败，已退回文字卡' : '文字卡也失败');
    return;
  }
  log(false, '文字卡失败');
}

// ---------- 更新分发 ----------

async function handleUpdate(update, env, origin) {
  await getMe(env);

  // Guest Mode：群里 @ 了一个不在这个群里的 bot，Telegram 只送这一条消息过来
  if (update.guest_message) {
    await answerGuest(update.guest_message, env, origin);
    return;
  }

  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  // 只处理新消息；edited_message 会让编辑一次就重复回一遍，不带
  const message = update.message;
  if (!message) return;

  const chat = message.chat;
  if (!chat || chat.type === 'channel') return; // 频道里的帖子不动

  const from = message.from;
  // 别的机器人发的就别互相刷了；但「以频道/匿名管理员身份发言」的消息 sender_chat 有值，那还是人在说话，别误杀
  if (from?.is_bot && !message.sender_chat) return;

  const isPrivate = chat.type === 'private';
  const mentions = mentionMatchers(message);
  const repliedToMe = isReplyToMe(message);

  // 群里：只有被 @ 或回复机器人才回；私聊：直接回
  const shouldReply = isPrivate || mentions.length > 0 || repliedToMe;

  // 一行诊断日志：wrangler tail 里能直接看出「消息到了但没被认成 @」还是「压根没收到」
  console.log(
    '[update]',
    JSON.stringify({
      chat: chat.type,
      chatId: chat.id,
      fromId: from?.id ?? null,
      senderChat: message.sender_chat?.type ?? null,
      entities: (message.entities ?? []).map((e) => e.type).join(',') || '无',
      text: String(message.text ?? message.caption ?? '').slice(0, 60),
      mentions,
      repliedToMe,
      shouldReply,
    }),
  );
  if (!shouldReply) return;

  const cooldown = Number(env.COOLDOWN_MS ?? 3000);
  if (!isPrivate && onCooldown(`${chat.id}:${from?.id ?? 0}`, cooldown)) {
    console.log('[update] 被 COOLDOWN_MS 限流，跳过', chat.id, from?.id ?? 0);
    return;
  }

  await sendReply(env, chat.id, message.message_id, origin);
}

// ---------- 入口 ----------

const SETUP_HTML = (env) => `<!doctype html>
<meta charset="utf-8"><title>Telegram Bot 状态</title>
<style>body{font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#111}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px}
.ok{color:#0a7d3c}.bad{color:#b42318}li{margin:4px 0}</style>
<h2>Telegram 自动回复 Bot</h2>
<p>Worker 已经跑起来了。配置检查：</p>
<ul>
  <li>BOT_TOKEN：<b class="${env.BOT_TOKEN ? 'ok' : 'bad'}">${env.BOT_TOKEN ? '已配置' : '未配置'}</b></li>
  <li>REPLY_TEXT：<b class="${env.REPLY_TEXT ? 'ok' : 'bad'}">${env.REPLY_TEXT ? `${env.REPLY_TEXT.length} 字` : '未配置（用默认占位文案）'}</b></li>
  <li>IMAGE_URL：<b class="${env.IMAGE_URL ? 'ok' : 'bad'}">${env.IMAGE_URL ? '已配置' : '未配置（只发文字）'}</b></li>
  <li>BUTTONS：<b class="${env.BUTTONS ? 'ok' : 'bad'}">${env.BUTTONS ? '已配置' : '未配置（无按钮）'}</b></li>
  <li>WEBHOOK_SECRET：<b class="${env.WEBHOOK_SECRET ? 'ok' : 'bad'}">${env.WEBHOOK_SECRET ? '已配置' : '未配置（任何人都能伪造 update）'}</b></li>
</ul>
<p>下一步：把 webhook 指到这个 Worker 的地址 —— 见 README 里的 <code>setWebhook</code> 命令。</p>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' || request.method === 'HEAD') {
      return new Response(SETUP_HTML(env), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 只接 Telegram 的请求：setWebhook 时带上同一个 secret_token
    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (got !== env.WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // 立刻 200，别让 Telegram 等到超时重发；实际活在 waitUntil 里做
    ctx.waitUntil(handleUpdate(update, env, url.origin).catch((err) => console.error('[handleUpdate]', err?.stack || err)));
    return new Response('ok');
  },
};
