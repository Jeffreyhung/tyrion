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
  "captcha_token": "Turnstile token, only when the server asked for one"
}
```

| Parameter | Type | Required | Description |
| :---: | :---: | :---: | --- |
| `url` | string | yes | Absolute `http://` or `https://` URL, at most `MAX_URL_LENGTH` characters (2048 by default). Whitespace, control characters, `<`, `>`, `"`, `` ` ``, embedded credentials and links back to the shortener itself are rejected. |
| `captcha_token` | string | only after a `403` with `captcha_required` | A solved Cloudflare Turnstile token. `turnstile_token` and `cf-turnstile-response` are accepted as aliases. See the [bot protection documentation](CAPTCHA.md). |

### Authentication for scripts

Requests from scripts and HTTP libraries are usually classified as suspicious and asked for a Turnstile token, which a script cannot produce. If the operator has configured `API_TOKEN`, send it as a bearer token to skip the challenge:

```
Authorization: Bearer YOUR_API_TOKEN
```

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
| `403` | The request looks automated and must include a valid Turnstile token. The body includes `"captcha_required": true`. |
| `429` | Rate limit exceeded (only when the `RATE_LIMITER` binding is configured). |
| `500` | The link could not be stored. |
| `503` | A challenge was required but Turnstile is not configured on the server. |

```json
{
  "status": 403,
  "error": "Verification required",
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
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/very/long/url"}'
```
