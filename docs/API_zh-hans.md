# API 接口文档

[English](API.md)

可以通过 JSON API 以编程方式生成短链接。

### 接口地址

向已部署的 Worker 发送 `POST /`，例如 `https://url.example.workers.dev/` 或自行绑定的域名。其他路径返回 `404`。

### 请求

`Content-Type: application/json`

```json
{
  "url": "https://example.com/some/long/path",
  "captcha_token": "Cap 验证组件返回的 token"
}
```

| 参数名 | 类型 | 是否必须 | 说明 |
| :---: | :---: | :---: | --- |
| `url` | string | 必须 | 以 `http://` 或 `https://` 开头的完整网址，长度不超过 `MAX_URL_LENGTH`（默认 2048）。含有空白字符、控制字符、`<`、`>`、`"`、`` ` ``、用户名密码，或指向本服务自身的网址会被拒绝。 |
| `captcha_token` | string | 开启 `CAPTCHA_REQUIRE_ON_CREATE` 时必须（默认开启） | 已通过验证的 Cap token，也可使用 `captchaToken` 或 `token` 字段名。详见[验证码文档](CAPTCHA_zh-hans.md)。 |

### 成功响应

```json
{
  "status": 200,
  "key": "/abc123",
  "short_url": "/abc123",
  "url": "https://url.example.workers.dev/abc123"
}
```

| 字段 | 类型 | 说明 |
| :---: | :---: | --- |
| `status` | int | 成功时为 `200`。 |
| `key` | string | 短链接路径，需自行添加域名前缀。 |
| `short_url` | string | 与 `key` 相同，为兼容旧版本保留。 |
| `url` | string | 完整的短链接。 |

### 错误响应

错误以 JSON 返回，HTTP 状态码与 `status` 字段一致。

| HTTP | 含义 |
| :---: | --- |
| `400` | 请求体不是 JSON、`url` 缺失或无效、或被 Safe Browsing 标记为危险。 |
| `403` | 缺少或无效的验证码 token，响应中包含 `"captcha_required": true`。 |
| `429` | 超出频率限制（仅在配置了 `RATE_LIMITER` 绑定时出现）。 |
| `500` | 链接保存失败。 |

```json
{
  "status": 403,
  "error": "CAPTCHA token required",
  "captcha_required": true
}
```

### 访问短链接

`GET /<key>` 返回 `302` 跳转。开启 `FORWARD_QUERY_PARAMS` 时，访问短链接时附带的查询参数会追加到目标网址。开启 `NO_REF` 时，响应携带 `Referrer-Policy: no-referrer`。不存在或已过期的 key 返回 `404`。

### 跨域

`CORS` 开启时（默认），接口会响应 `OPTIONS` 预检请求并返回 `Access-Control-Allow-Origin: *`，其他域名的网页可直接调用。

### 示例

```bash
curl -X POST https://url.example.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/very/long/url", "captcha_token": "..."}'
```
