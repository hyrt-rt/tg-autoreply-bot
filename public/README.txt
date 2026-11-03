把要发的图放进这个文件夹，文件名跟 wrangler.toml 里的 IMAGE_URL 对上（默认是 meme.jpg）。

放好后 `npx wrangler deploy`，图片会挂在这个 Worker 自己的域名下，例如
https://tg-autoreply-bot.你的子域.workers.dev/meme.jpg
Telegram 直接就能下载，不需要图床。
