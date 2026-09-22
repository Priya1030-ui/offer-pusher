# 部署成公网网络应用

这个项目是标准 Node Web 应用，可以部署到 Render、Railway、Fly.io、VPS、公司服务器等平台。当前目录已包含 `Dockerfile`、`.dockerignore` 和 `render.yaml`，推荐先用 Render。

## 必填环境变量

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_APP_TOKEN=多维表格 app_token
FEISHU_TABLE_ID=多维表格 table_id
FEISHU_VIEW_ID=多维表格 view_id
FEISHU_PREVIEW_OPEN_ID=ou_xxx
FEISHU_GROUP_CHAT_ID=oc_xxx
```

如果要用飞书账号保护访问，额外配置：

```text
FEISHU_LOGIN_REQUIRED=true
PUBLIC_BASE_URL=https://你的公网域名
SESSION_SECRET=生成一串随机长密码
FEISHU_ALLOWED_TENANT_KEYS=tenant_key_xxx
```

`FEISHU_ALLOWED_TENANT_KEYS` 用来限制只允许你公司的飞书组织成员访问。公网部署时不要留空；如果留空，系统会拒绝登录，避免变成“任何飞书账号都能用”。

如果只想给少数人使用，也可以额外配置 `FEISHU_ALLOWED_OPEN_IDS`。

可选：

```text
OFFER_TITLE_PREFIX=校招Offer开奖参考
OFFER_SOURCE_TEXT=整理自Offershow等校招薪资分享中高可信度及热门案例
PORT=8787
```

## 飞书权限

飞书应用需要具备：

- 读取多维表格记录
- 读取 Wiki 节点或直接配置 `FEISHU_APP_TOKEN`
- 发送消息
- 机器人能力启用，并在目标群聊里

## 本地验证

```powershell
node server.mjs
```

打开：

```text
http://localhost:8787
```

## Docker 部署

```powershell
docker build -t offer-pusher .
docker run -p 8787:8787 --env-file .env offer-pusher
```

服务器放开端口后，访问：

```text
http://服务器地址:8787
```

生产环境建议放在 HTTPS 反向代理后面，并限制访问范围，避免陌生人拿到链接后给你的群乱发消息。

## Render 部署

1. 把本目录推到 GitHub 仓库。
2. 在 Render 选择 `New` -> `Blueprint`，连接这个仓库。Render 会读取 `render.yaml`。
3. 在 Render 环境变量里补齐所有 `sync: false` 的值：
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
   - `FEISHU_PREVIEW_OPEN_ID`
   - `FEISHU_GROUP_CHAT_ID`
   - `SESSION_SECRET`
   - `FEISHU_ALLOWED_TENANT_KEYS`
4. 首次部署完成后拿到 Render 的 HTTPS 地址，例如：

```text
https://offer-pusher.onrender.com
```

5. 到飞书开放平台把回调地址添加为：

```text
https://offer-pusher.onrender.com/auth/callback
```

6. 如果 Render 没有自动提供 `RENDER_EXTERNAL_URL`，就在环境变量里手动设置：

```text
PUBLIC_BASE_URL=https://offer-pusher.onrender.com
```

## 飞书登录回调

启用 `FEISHU_LOGIN_REQUIRED=true` 后，需要在飞书开放平台的应用配置里添加网页应用重定向地址：

```text
https://你的公网域名/auth/callback
```

应用同时需要开启网页应用登录相关权限，以及读取多维表格和发送消息权限。

## Cloudflare Pages 部署

本项目已包含 `functions/[[path]].js` 和 `wrangler.toml`，可部署到 Cloudflare Pages。

必填环境变量同上，另需设置：

```text
FEISHU_LOGIN_REQUIRED=true
PUBLIC_BASE_URL=https://你的 Cloudflare Pages 域名
SESSION_SECRET=生成一串随机长密码
FEISHU_ALLOWED_TENANT_KEYS=tenant_key_xxx
ALLOW_CONFIG_EDIT=false
```

首次部署后，将飞书开放平台的网页应用重定向地址设置为：

```text
https://你的 Cloudflare Pages 域名/auth/callback
```
