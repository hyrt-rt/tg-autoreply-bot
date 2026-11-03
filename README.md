# Telegram 自动回复 Bot（Cloudflare Workers）

一个「被点名就说同一句话」的机器人：**一张梗图 + 一段固定文案 + 一排按钮**。

跑在 Cloudflare Workers 上，单文件、没有框架、没有构建步骤，`wrangler deploy` 一条命令上线，免费额度足够用。文案、图片、按钮全部写在配置里，改完重新部署即可，不用碰代码。

> **许可证：PolyForm Noncommercial 1.0.0** —— 仅供非商业用途（个人学习、研究、实验、爱好项目，以及慈善、教育、公益、政府机构使用）。**任何商业用途都不被授权**，包括拿去卖、做成付费服务、集成进商业产品。需要商用请先取得作者书面许可。详见 [LICENSE.md](LICENSE.md)。

---

## 一、它现在会做什么

| 你做的事 | 它的反应 |
| --- | --- |
| 群里 `@你的bot` | 引用你那条消息，回梗图 + 文案 + 六个按钮 |
| 群里**回复**它的消息 | 同上（不用再 @） |
| 私聊它，随便发一句 / `/start` | 同上 |
| 点任意一个按钮 | 弹出一句对应的提示（弹窗形式） |
| **在它没被拉进去的群里** `@你的bot` | Guest Mode：回一张卡片，不用进群（见第三节） |
| 频道里的帖子、其他机器人发的消息 | 不理，避免互相刷屏 |

同一个人在同一个群里，3 秒内只回一次（`COOLDOWN_MS`），防止有人连点刷屏。

---

## 二、怎么用（已经部署好的情况）

不需要你做任何部署，直接三个入口：

1. **私聊**：搜机器人的用户名（例如 `@xxx_bot`），点开，随便发一句话。
2. **群里 @**：先把机器人拉进群（见下方「拉不进群怎么办」），然后在群里打 `@xxx_bot`，从候选里点选，别手打错字母。
3. **不进群也能用**：在任意一个**没有**拉它的群里打 `@xxx_bot` —— 这要求机器人开了 Guest Mode（第三节第 3 条）。

按钮点了没反应，通常是机器人没被允许在这个群发言，或者群设置了「仅管理员可发言」。

---

## 三、BotFather 里必须确认的几个开关

这些是**机器人账号本身**的权限，只能在 `@BotFather` 里改，改完不用重新部署。逐条对一遍，缺一条就会表现成「它不回我」。

| 开关 | 位置 | 要设成 | 不开会怎样 |
| --- | --- | --- | --- |
| 允许被拉进群 | `/setjoingroups` | **Enable** | 任何群都加不进去，连管理员也不行 |
| 隐私模式 | `/setprivacy` | **Disable** | 群里只收到「真 @ 它」「/命令」「回复它」三类消息，其他一概看不到 |
| **Guest Mode（访客模式）** | `/mybots` → 选机器人 → **Bot Settings** → **supports_guest_queries** | **打开** | 在没拉它的群里 @ 它，Telegram 根本不会把消息转给它 |
| 内联模式（可选） | `/setinline` | 需要才开 | 不能在任何聊天里打 `@bot 关键词` 调出卡片自己发 |

几个容易搞混的点：

- **Guest Mode 和「拉进群」是两套东西。** Guest Mode 让它「不进群也能回一张卡片」，代价是只能回**一张**卡片（图 + 说明文字 + 按钮），不能引用对方消息、不能连发多条、也读不到群里其他消息（只能看到 @ 它的那一条）。想要「引用你说的话 + 图 + 长文案 + 一排按钮」这种完整效果，还是得把机器人拉进群。
- **隐私模式改完要对新入群生效。** 如果机器人早就在某个群里，改完 `/setprivacy` 后要先把它踢出群再重新拉一次。
- **把机器人设为群管理员**可以绕过隐私模式，同时也能解决「进得去但发不出话」的群。
- 判断这些开关有没有生效，最快的方式是看 `getMe` 返回值：

```bash
curl "https://api.telegram.org/bot<你的token>/getMe"
```

```jsonc
{
  "can_join_groups": true,                 // false = 加不进任何群
  "can_read_all_group_messages": true,     // false = 隐私模式还开着
  "supports_guest_queries": true           // false = Guest Mode 还没开
}
```

### 拉不进群怎么办

- 群把「添加成员」权限限成了**仅管理员**：群 → 编辑 → 权限 → 添加成员。你若不是管理员，让管理员加一次即可，加进去之后你在群里 @ 它、它回话，都不再需要管理员身份。
- 那其实是个**频道**：频道没有「加成员」，只能「添加管理员」，路径是 频道 → 管理频道 → 管理员 → 添加管理员。
- 更快的加法：打开 `https://t.me/<机器人用户名>?startgroup=true`，选目标群，一步进去。

---

## 四、部署一份自己的

```bash
# 1. 装 wrangler（一次就够）
npm i -g wrangler        # 或者不装，后面命令前面加 npx

# 2. 登录 Cloudflare
wrangler login

# 3. 找 @BotFather 要 token（/newbot 或 /token），写进 secret
wrangler secret put BOT_TOKEN
wrangler secret put WEBHOOK_SECRET   # 自己编一串，例如 openssl rand -hex 16

# 4. 上线
wrangler deploy
```

部署完终端会打印地址，形如 `https://tg-autoreply-bot.你的子域.workers.dev`。

```bash
# 5. 把 webhook 指过去（secret_token 必须和 WEBHOOK_SECRET 一模一样）
curl "https://api.telegram.org/bot<你的token>/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
        "url": "https://tg-autoreply-bot.你的子域.workers.dev",
        "secret_token": "<WEBHOOK_SECRET>",
        "allowed_updates": ["message", "callback_query", "guest_message"]
      }'
```

`allowed_updates` 里的 `guest_message` 是 Guest Mode 用的，不写进去这类消息会被丢掉。

检查是否接上：

```bash
curl "https://api.telegram.org/bot<你的token>/getWebhookInfo"
```

`pending_update_count` 应该接近 0、`last_error_message` 为空。浏览器打开 Worker 地址有个状态页，能看到 token / 文案 / 图片 / 按钮 / secret 各自配没配好。

---

## 五、改内容：文案、图片、按钮

全在 `wrangler.toml` 的 `[vars]` 里，改完 `wrangler deploy` 生效。

```toml
# 固定回复的文案，支持换行，纯文本上限 4096 字
REPLY_TEXT = """
第一段……

第二段……
"""

# 配图。三种写法：
#   1) 公网直链  https://example.com/a.jpg
#   2) 相对路径  /meme.jpg      —— 图放 public/ 里，自动挂在自己域名下（不用另找图床）
#   3) Telegram file_id（只在同一个 bot 下有效）
# 留空 = 只发文字
IMAGE_URL = "/meme.jpg"

# 按钮：一维数组 = 每个按钮独占一行；二维数组 = 按行分组
BUTTONS = '["【一键封杀】", "【全网通缉】", "【祖宗查水表】"]'
BUTTONS = '[["【一键封杀】", "【全网通缉】"], ["【退朝禁言】"]]'
BUTTONS = '[{"text": "打开链接", "url": "https://example.com"}]'

# 每个按钮点了弹什么（key 就是按钮文字）
CALLBACKS = '{"【一键封杀】": {"text": "网线物理掐断！", "alert": true}}'

COOLDOWN_MS = "3000"   # 同人同群限流，0 = 关掉
PARSE_MODE = ""        # 留空 = 纯文本；要用 <b> 之类标签才填 HTML
```

两个字数限制值得记一下：

- 文案 **≤ 1024 字** → 图文一条，图在下面挂文案和按钮；
- 文案 **> 1024 字** → 自动拆成「正文一条 + 图一条」，按钮在正文那条上；
- 文案 **> 4096 字** → Telegram 直接拒收，发不出去。

---

## 六、改了代码怎么发布

```bash
npx wrangler deploy
```

配置项（文案/按钮/图）改动只需重新 deploy；`BOT_TOKEN`、`WEBHOOK_SECRET` 改了要重新 `wrangler secret put`，`WEBHOOK_SECRET` 变了还必须重新 `setWebhook`（secret 对不上，Worker 会返回 403 把消息全拒掉）。

---

## 七、它不回复了？按这个顺序查

1. **它进群了吗？** 没进群的群里，普通 @ 是收不到的（要不把机器人加进去，要么开 Guest Mode）。
2. **那个群里它被 @ 的方式对吗？** 从输入 `@` 后的候选列表点成蓝色可点的那种才算 mention。手打错一个字母就什么都不会发生。
3. **隐私模式开了没？** 见第三节，`getMe` 里 `can_read_all_group_messages` 是 `false` 就说明还开着。
4. **群允许它发言吗？** 广播群 / 仅管理员可发言的群，机器人进得去但发不出。
5. **看日志。** 开着 `npx wrangler tail` 再去群里 @ 一次，两种结果一看便知：
   - 出现 `[update] {...}` 且 `shouldReply: true` → 消息收到了，问题在发送端（权限、被禁言）；
   - 什么都没有 → Telegram 压根没转给它（第 1/2/3 条）；
   - 出现 `[guest] {...}` → 走的是 Guest Mode，看 `ok` 字段和上面的 `[tg:answerGuestQuery]` 报错。
6. **webhook 还指得对吗？** `getWebhookInfo`，换过地址要重新 `setWebhook`。

常见报错对照：

| 日志里的报错 | 含义 |
| --- | --- |
| `chat not found` | 机器人不在那个会话里（或群号是假的） |
| `not enough rights` / `chat_write_forbidden` | 在群里没有发言权限，设为管理员 |
| `can't parse entities` | 开了 `PARSE_MODE` 但文案里有未转义的 `<` `&` |
| `message is too long` | 文案超过 4096 字 |
| `PHOTO_INVALID_DIMENSIONS` / 图片相关 | `IMAGE_URL` 不是可访问的公网图片，会退回纯文字 |
| `QUERY_ID_EMPTY` / guest 相关 | Guest Mode 还没在 BotFather 打开，或 query 过期 |

---

## 八、本地调试

```bash
wrangler dev            # 起在 http://localhost:8787
```

本地要收真实 update 得开内网穿透（`cloudflared tunnel`、ngrok），再把 webhook 指到穿透地址。也可以直接伪造请求测逻辑：

```bash
curl -X POST http://localhost:8787 \
  -H 'content-type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>' \
  -d '{"update_id":1,"message":{"message_id":10,"chat":{"id":123,"type":"supergroup"},"from":{"id":456,"first_name":"test","is_bot":false},"text":"@你的bot 在吗"}}'
```

伪造的 `guest_message`（测 Guest Mode 分支）：

```bash
curl -X POST http://localhost:8787 \
  -H 'content-type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: <WEBHOOK_SECRET>' \
  -d '{"update_id":2,"guest_message":{"message_id":1,"date":1770000000,"chat":{"id":-1001234567890,"type":"supergroup"},"guest_query_id":"test","text":"@你的bot"}}'
```

---

## 九、文件

```
src/worker.js   全部逻辑：触发判断、引用回复、按钮回调、Guest Mode、webhook 校验
wrangler.toml   部署配置 + 全部文案/图片/按钮
public/         静态资源（放图片）；IMAGE_URL 写 /xxx.jpg 就走这里
.dev.vars       本地调试用的 BOT_TOKEN / WEBHOOK_SECRET（不要提交，已在 .gitignore）
```

---

## 十、安全提醒

- `BOT_TOKEN` 等于机器人的完整控制权，泄露了就丢给 BotFather 用 `/revoke` 换新的，然后重新 `wrangler secret put BOT_TOKEN`。
- `WEBHOOK_SECRET` 一定别省：没有它，任何人知道你的 Worker 地址就能伪造 update，让机器人乱回。
- 这两个值都只放 secret / `.dev.vars`，不要写进 `wrangler.toml`，也不要贴到聊天记录里。
- 本仓库的 `.gitignore` 已经把 `.dev.vars`、`.wrangler/`、`node_modules/` 排除掉了。
