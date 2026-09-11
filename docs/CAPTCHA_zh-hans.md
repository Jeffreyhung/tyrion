# 验证码集成说明

[English](CAPTCHA.md)

Tyrion 使用 [Cap](https://capjs.js.org) 工作量证明（proof-of-work）验证码。访问者在浏览器中完成一个小型计算题后获得 token，Worker 在创建短链接（或可选地在访问短链接）之前向 Cap 服务器校验该 token。

工作量证明只能让自动化滥用**变贵**，并不能完全阻止。请配合 README 中介绍的频率限制绑定一起使用。

## 配置

所有设置都是环境变量（见 [`wrangler.toml`](../wrangler.toml) 或 Worker 控制台的设置页面）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CAPTCHA_ENABLED` | `true` | 总开关。 |
| `CAPTCHA_API_ENDPOINT` | `https://captcha.gurl.eu.org/api` | 用于校验的 Cap 服务器 API。 |
| `CAPTCHA_WIDGET_SCRIPT_URL` | `https://captcha.gurl.eu.org/cap.min.js` | 验证页面加载的组件脚本。 |
| `CAPTCHA_ASSET_HOSTS` | `https://cdn.jsdelivr.net` | 内容安全策略额外允许的组件代码来源。 |
| `CAPTCHA_REQUIRE_ON_CREATE` | `true` | 创建短链接时要求验证。 |
| `CAPTCHA_REQUIRE_ON_ACCESS` | `false` | 访问短链接时要求验证。 |
| `CAPTCHA_TIMEOUT` | `5000` | 校验请求超时（毫秒）。 |
| `CAPTCHA_MAX_RETRIES` | `2` | 网络错误或 5xx 时的重试次数（0–5）。 |
| `CAPTCHA_FALLBACK_ON_ERROR_CREATE` | `false` | Cap 服务器不可用时仍允许创建。 |
| `CAPTCHA_FALLBACK_ON_ERROR_ACCESS` | `true` | Cap 服务器不可用时仍允许访问。 |

### 场景

**默认：** 仅创建时验证。Cap 服务器故障会阻止新建链接，但已有链接照常可用。

**严格模式：** 设置 `CAPTCHA_REQUIRE_ON_ACCESS=true` 和 `CAPTCHA_FALLBACK_ON_ERROR_ACCESS=false`。每次访问都需要验证，服务器故障时一律拒绝。

**仅访问保护：** 设置 `CAPTCHA_REQUIRE_ON_CREATE=false` 和 `CAPTCHA_REQUIRE_ON_ACCESS=true`。

**完全禁用：** 设置 `CAPTCHA_ENABLED=false`。

## 自建 Cap 服务器

默认端点是公共的第三方服务。运营方或任何能让它不可用的人都会影响你的短链服务。建议部署自己的 [Cap 服务器](https://capjs.js.org/guide/server.html)，并把 `CAPTCHA_API_ENDPOINT` 和 `CAPTCHA_WIDGET_SCRIPT_URL` 指向它，同时修改 [`public/index.html`](../public/index.html) 中写死的两个地址。

## 携带 token 创建短链接

使用组件的网页示例：

```html
<script src="https://captcha.gurl.eu.org/cap.min.js"></script>
<cap-widget id="cap" data-cap-api-endpoint="https://captcha.gurl.eu.org/api/"></cap-widget>
<script>
  document.getElementById("cap").addEventListener("solve", async (e) => {
    const res = await fetch("https://your-worker.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", captcha_token: e.detail.token }),
    });
    console.log(await res.json());
  });
</script>
```

token 一次性有效且会过期，每次请求都需要重新获取。

## 校验流程

1. 长度小于 10 或大于 512 的 token 直接拒绝，不请求服务器。
2. Worker 调用 `POST <endpoint>/validate`，请求体为 `{ token, keepToken: false }`。
3. `200` 且 `success: true` 通过；`200` 但 `success: false`，以及 `400`、`401`、`403`、`404`、`409`、`410` 立即失败。
4. 其他状态码、超时和网络错误按指数退避重试（100 ms、200 ms、400 ms）。
5. 全部失败后由对应的 fallback 设置决定结果，并记录警告日志以便监控降级情况。

## 访问流程

开启 `CAPTCHA_REQUIRE_ON_ACCESS` 后，`GET /<key>` 先返回带组件的 `403` 页面。验证完成后页面以 `?captcha_token=...` 重新加载，Worker 校验 token，将其从转发的查询参数中去掉后跳转。校验失败时显示重试页面，并保留原有的查询参数。

## 日志

```
CAPTCHA validation attempt 1 failed: Timeout
CAPTCHA service degraded (HTTP 503); allowing operation per fallback policy
```

在 Workers Logs 中关注第二行。频繁出现说明 Cap 服务器不健康或 `CAPTCHA_TIMEOUT` 过低。
