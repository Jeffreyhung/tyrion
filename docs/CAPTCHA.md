# CAPTCHA integration

[简体中文](CAPTCHA_zh-hans.md)

Tyrion uses [Cap](https://capjs.js.org), a proof-of-work CAPTCHA. Visitors solve a small computational puzzle in the browser and receive a token; the Worker validates that token against the Cap server before creating a link or, optionally, before following one.

Proof-of-work makes automated abuse **expensive**, not impossible. Pair it with the rate limiter binding described in the README for real protection.

## Configuration

All settings are environment variables (see [`wrangler.toml`](../wrangler.toml) or the Worker's dashboard settings).

| Variable | Default | Description |
| --- | --- | --- |
| `CAPTCHA_ENABLED` | `true` | Master switch. |
| `CAPTCHA_API_ENDPOINT` | `https://captcha.gurl.eu.org/api` | Cap server API used for validation. |
| `CAPTCHA_WIDGET_SCRIPT_URL` | `https://captcha.gurl.eu.org/cap.min.js` | Widget script for the challenge pages. |
| `CAPTCHA_ASSET_HOSTS` | `https://cdn.jsdelivr.net` | Extra origins the Content Security Policy allows for widget code. |
| `CAPTCHA_REQUIRE_ON_CREATE` | `true` | Require a token to create links. |
| `CAPTCHA_REQUIRE_ON_ACCESS` | `false` | Require a token to follow links. |
| `CAPTCHA_TIMEOUT` | `5000` | Validation request timeout in milliseconds. |
| `CAPTCHA_MAX_RETRIES` | `2` | Retries on network errors or 5xx responses (0–5). |
| `CAPTCHA_FALLBACK_ON_ERROR_CREATE` | `false` | Allow creation when the Cap server is unreachable. |
| `CAPTCHA_FALLBACK_ON_ERROR_ACCESS` | `true` | Allow access when the Cap server is unreachable. |

### Scenarios

**Default:** CAPTCHA on creation only. An outage of the Cap server blocks new links but existing links keep working.

**Strict:** set `CAPTCHA_REQUIRE_ON_ACCESS=true` and `CAPTCHA_FALLBACK_ON_ERROR_ACCESS=false`. Every visit needs a solved challenge, and nothing is allowed while the Cap server is down.

**Access protection only:** set `CAPTCHA_REQUIRE_ON_CREATE=false` and `CAPTCHA_REQUIRE_ON_ACCESS=true`.

**Disabled:** set `CAPTCHA_ENABLED=false`.

## Self-hosting the Cap server

The default endpoint is a public third-party service. Anyone operating it, or anyone who can make it unreachable, affects your shortener. Deploy your own [Cap server](https://capjs.js.org/guide/server.html) and point `CAPTCHA_API_ENDPOINT` and `CAPTCHA_WIDGET_SCRIPT_URL` at it. Update the two hardcoded URLs in [`public/index.html`](../public/index.html) as well.

## Creating a link with a token

Browser page using the widget:

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

Tokens are single-use and expire; obtain a fresh one for every request.

## How validation behaves

1. Tokens shorter than 10 or longer than 512 characters are rejected without contacting the server.
2. The Worker calls `POST <endpoint>/validate` with `{ token, keepToken: false }`.
3. `200` with `success: true` passes. `200` with `success: false` and the client errors `400`, `401`, `403`, `404`, `409`, `410` fail immediately.
4. Other statuses, timeouts and network errors are retried with exponential backoff (100 ms, 200 ms, 400 ms).
5. When all attempts fail, the relevant fallback setting decides. The outcome is logged as a warning so you can alert on degradation.

## Access flow

When `CAPTCHA_REQUIRE_ON_ACCESS` is on, `GET /<key>` first returns a `403` page with the widget. After solving, the page reloads itself with `?captcha_token=...`; the Worker validates the token, strips it from the forwarded query string, and redirects. A failed validation shows a retry page that preserves the original query parameters.

## Logging

```
CAPTCHA validation attempt 1 failed: Timeout
CAPTCHA service degraded (HTTP 503); allowing operation per fallback policy
```

Watch for the second line in Workers Logs. Frequent occurrences mean the Cap server is unhealthy or `CAPTCHA_TIMEOUT` is too low.
