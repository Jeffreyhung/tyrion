# 使用 Cloudflare Turnstile 防护机器人

[English](CAPTCHA.md)

Tyrion 使用 [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) 防止机器人批量创建短链接。默认采用**自适应**策略：普通访问者不会看到验证，只有看起来像自动化程序的请求才需要通过。

## 如何判定"可疑"

每次创建短链接（如开启，访问短链接时也一样）都会计算风险分数，来源如下：

| 信号 | 分数 |
| --- | :---: |
| Cloudflare Bot Management 分数低于 30（仅 Enterprise 套餐，其他套餐忽略） | 3 |
| 该 IP 超出软性频率限制 `CHALLENGE_LIMITER` | 3 |
| 缺少 `User-Agent` | 3 |
| `User-Agent` 属于 HTTP 库、命令行工具或无头浏览器（curl、python、Go、axios、puppeteer 等） | 2 |
| 浏览器 `User-Agent` 但缺少真实浏览器必带的 `Sec-Fetch-*` 头 | 2 |
| 缺少 `Accept-Language` | 1 |
| JSON POST 既无 `Origin` 也无 `Referer`（浏览器 POST 时一定带 `Origin`） | 1 |
| 使用 TLS 1.0 或 1.1 | 1 |

分数达到 `SUSPICION_THRESHOLD`（默认 3）的请求必须提供 Turnstile token。Bot Management 标记的已验证爬虫分数始终为零。每次要求验证时都会记录分数和原因，可在 Workers Logs 中据此调整阈值。

如果没有配置 `CHALLENGE_LIMITER` 绑定，模仿浏览器请求头的脚本仍可大量创建链接。在 `wrangler.toml` 中启用该绑定后，同一 IP 每分钟超过设定次数即会被要求验证。

## 配置步骤

1. 在 Cloudflare 控制台打开 **Turnstile**，为短链服务的域名新建一个 widget，推荐 **Managed** 类型。若想在本地用真实密钥测试，可同时加入 `localhost`。
2. 把 **site key** 填入 `wrangler.toml` 的 `TURNSTILE_SITE_KEY`（公开值，会出现在网页中）。
3. 把 **secret key** 存为 Worker secret：

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

4. 部署。如果需要验证时密钥缺失，请求会被拒绝并返回 HTTP 503，同时记录错误，配置问题因此可见而不会悄悄放行。

本地开发可在 `.dev.vars`（已在 .gitignore 中）放入 Cloudflare 的测试密钥，它们总是通过：

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

## 设置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | 空 | 公开的 widget key。 |
| `TURNSTILE_SECRET_KEY` | 空 | 密钥，用 `wrangler secret put` 设置。 |
| `CHALLENGE_ON_CREATE` | `suspicious` | `off`、`suspicious` 或 `always`。 |
| `CHALLENGE_ON_ACCESS` | `off` | 同上，用于访问短链接。默认关闭，因为链接预览和爬虫是正常的自动化访问。 |
| `SUSPICION_THRESHOLD` | `3` | `suspicious` 模式下触发验证的分数。 |
| `CHALLENGE_TIMEOUT` | `5000` | 校验请求超时（毫秒）。 |
| `CHALLENGE_MAX_RETRIES` | `2` | 网络错误或 5xx 时的重试次数（0–5）。 |
| `CHALLENGE_FALLBACK_ON_ERROR_CREATE` | `false` | Cloudflare 校验接口不可用时仍允许创建。 |
| `CHALLENGE_FALLBACK_ON_ERROR_ACCESS` | `true` | 校验接口不可用时仍允许访问。 |
| `API_TOKEN` | 空 | 可选密钥。携带 `Authorization: Bearer <token>` 的请求完全跳过验证。 |

## 访问者看到的流程

首页先直接提交网址。若服务器返回 `403` 且 `captcha_required: true`，页面才按需加载 Turnstile 脚本，在弹窗中显示验证组件，完成后带 token 重新提交。不可疑的访问者根本不会加载任何 Turnstile 代码。

当 `CHALLENGE_ON_ACCESS` 要求验证时，`GET /<key>` 返回带组件的 `403` 页面。验证完成后页面以 `?captcha_token=...` 重新加载，Worker 校验 token，将其从转发的查询参数中去掉后跳转。

## 脚本与集成

脚本无法完成 Turnstile，而且通常会被判定为可疑。请改用 API token：

```bash
npx wrangler secret put API_TOKEN
```

```bash
curl -X POST https://your-worker.workers.dev/ \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/very/long/url"}'
```

其他域名的网页也可以传入自己 Turnstile 组件获得的 token，前提是使用相同的 site key 且域名在允许列表内。字段名可为 `captcha_token`、`turnstile_token` 或 `cf-turnstile-response`。

## 校验细节

1. 长度小于 10 或大于 2048 的 token 直接拒绝，不发起网络请求。
2. Worker 向 `https://challenges.cloudflare.com/turnstile/v0/siteverify` 提交 `{ secret, response, remoteip }`。
3. `success: true` 通过；`success: false` 且错误码属于访问者一侧（过期、重复、无效）立即失败。
4. 返回 `invalid-input-secret` 时记录为配置错误，并按 fallback 设置处理。
5. 网络错误和 5xx 按指数退避重试，之后由 fallback 设置决定。

Turnstile token 一次性有效，五分钟后过期。

## 日志

```
Challenge demanded for create (automation user-agent, no accept-language, no origin or referer)
Turnstile verification attempt 1 failed: Timeout
Turnstile degraded (HTTP 503); allowing operation per fallback policy
```

真实用户频繁出现 "Challenge demanded" 说明阈值过低；频繁出现 "degraded" 说明校验接口不稳定或 `CHALLENGE_TIMEOUT` 过短。
