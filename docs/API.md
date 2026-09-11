# API documentation

[简体中文](API_zh-hans.md)

Short links can be created programmatically through the JSON API.

### Endpoint

`POST /` on your deployed Worker, for example `https://url.example.workers.dev/` or your custom domain. Requests to any other path return `404`.

### Request

`Content-Type: application/json`

```json
{
  "url": "https://example.com/some/long/path",
  "captcha_token": "token returned by the Cap widget"
}
```

| Parameter | Type | Required | Description |
| :---: | :---: | :---: | --- |
| `url` | string | yes | Absolute `http://` or `https://` URL, at most `MAX_URL_LENGTH` characters (2048 by default). Whitespace, control characters, `<`, `>`, `"`, `` ` ``, embedded credentials and links back to the shortener itself are rejected. |
| `captcha_token` | string | when `CAPTCHA_REQUIRE_ON_CREATE` is on (default) | A solved Cap token. `captchaToken` and `token` are accepted as aliases. See the [CAPTCHA documentation](CAPTCHA.md). |

### Successful response

```json
{
  "status": 200,
  "key": "/abc123",
  "short_url": "/abc123",
  "url": "https://url.example.workers.dev/abc123"
}
```

| Field | Type | Description |
| :---: | :---: | --- |
| `status` | int | `200` on success. |
| `key` | string | Path of the short link. Prefix it with your domain. |
| `short_url` | string | Same as `key`, kept for backwards compatibility. |
| `url` | string | The complete short link. |

### Error responses

Errors are JSON with an HTTP status matching the `status` field.

| HTTP | Meaning |
| :---: | --- |
| `400` | Body is not JSON, `url` is missing or invalid, or Safe Browsing flagged the URL. |
| `403` | CAPTCHA token missing or invalid. The body includes `"captcha_required": true`. |
| `429` | Rate limit exceeded (only when the `RATE_LIMITER` binding is configured). |
| `500` | The link could not be stored. |

```json
{
  "status": 403,
  "error": "CAPTCHA token required",
  "captcha_required": true
}
```

### Following a short link

`GET /<key>` answers with a `302` redirect. When `FORWARD_QUERY_PARAMS` is on, query parameters given to the short link are appended to the destination. When `NO_REF` is on, the response carries `Referrer-Policy: no-referrer`. Unknown or expired keys return `404`.

### CORS

When `CORS` is on (default), the API answers `OPTIONS` preflights and sends `Access-Control-Allow-Origin: *` so browser pages on other origins can call it.

### Example

```bash
curl -X POST https://url.example.workers.dev/ \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/very/long/url", "captcha_token": "..."}'
```
