# Offer 薪资推送恢复说明

这个目录里的文件是根据当前飞书多维表格和你给的历史推送截图恢复出的最小可运行版本。

## 已恢复

- 数据表字段：公司、序列、岗位、学历、薪资、备注
- 当前 16 条记录：见 `offers.tsv`
- 推送样式：飞书交互卡片，标题为“校招Offer开奖参考-YYYYMMDD期 本人预览”
- 正文格式：公司 · 岗位、序列、学历、薪资、备注，薪资红色加粗
- 推送方式：
  - 群机器人 Webhook
  - 飞书自建应用发送给本人 open_id 和群聊 chat_id

## 先本地预览

```powershell
node offer-push.mjs --dry-run
```

指定期号和条数：

```powershell
node offer-push.mjs --dry-run --date 20260911 --limit 2
```

## 恢复真实推送

复制配置样例：

```powershell
Copy-Item .env.example .env
```

然后填写 `.env`：

- 只发群机器人：填写 `FEISHU_WEBHOOK_URLS`
- 同时发本人预览和群聊：填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_PREVIEW_OPEN_ID`、`FEISHU_GROUP_CHAT_ID`

发送：

```powershell
node offer-push.mjs
```

## 使用网页控制台

启动：

```powershell
node server.mjs
```

然后打开：

```text
http://localhost:8787
```

页面里可以：

- 点击“同步表格”获取飞书多维表格里的实时数据
- 勾选任意行，右侧会显示要发送的卡片预览
- 点击“智能体发给本人预览”发送给配置的 `open_id`，发送者使用飞书智能体/机器人身份
- 填写 `chat_id` 后点击“发送到群组”
- 公网部署时可以开启飞书登录，并通过 `FEISHU_ALLOWED_TENANT_KEYS` 限制只允许公司飞书组织成员访问

日常使用不需要每次填写 `cli_xxx` 和本人 `open_id`。这些可以只在页面的“高级配置”里保存一次，或通过环境变量提供：

```powershell
$env:FEISHU_APP_ID="cli_xxx"
$env:FEISHU_APP_SECRET="xxx"
$env:FEISHU_PREVIEW_OPEN_ID="ou_xxx"
node server.mjs
```

飞书自建应用需要至少能读取多维表格记录，并开启机器人能力和消息发送权限。机器人还需要被拉入目标群聊，才能给群组发送消息。

## 仍需从旧环境补回的信息

- 飞书机器人 Webhook 或自建应用凭证
- 本人的 open_id
- 群聊 chat_id
- 原来的定时任务设置，例如每天几点运行

飞书多维表格页面和运行日志里没有显示这些密钥型信息，所以不能只靠表格记录完整恢复旧部署。
