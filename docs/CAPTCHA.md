# Bot protection with Cloudflare Turnstile

[简体中文](CAPTCHA_zh-hans.md)

Tyrion uses [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) to keep bots from mass-creating links. By default the challenge is **adaptive**: ordinary visitors never see it, and only requests that look automated have to pass it.

## How "suspicious" is decided

Every link creation (and, if enabled, every link visit) gets a risk score. Points come from:

| Signal | Points |
| --- | :---: |
| Cloudflare Bot Management score below 30 (Enterprise plans only, ignored elsewhere) | 3 |
| The soft rate limit `CHALLENGE_LIMITER` exceeded for this IP | 3 |
| No `User-Agent` header | 3 |
| `User-Agent` of an HTTP library, CLI tool or headless browser (curl, python, Go, axios, puppeteer, ...) | 2 |
| A browser `User-Agent` without the `Sec-Fetch-*` headers real browsers always send | 2 |
| No `Accept-Language` header | 1 |
| A JSON POST with neither `Origin` nor `Referer` (browsers always send `Origin` on POST) | 1 |
| TLS 1.0 or 1.1 | 1 |

A request scoring at least `SUSPICION_THRESHOLD` (default 3) must present a Turnstile token. Verified bots reported by Bot Management always score zero. The score and reasons are logged whenever a challenge is demanded, so you can tune the threshold from Workers Logs.

Without the `CHALLENGE_LIMITER` binding, a well-behaved script that mimics browser headers can create links at volume. Enable the binding in `wrangler.toml` to close that gap: after the configured number of creations per minute, every further request from that IP is challenged.

## Setup

1. In the Cloudflare dashboard open **Turnstile** and add a widget for your shortener's hostname. The **Managed** widget type is recommended. Add `localhost` too if you want to test real keys locally.
2. Put the **site key** in `wrangler.toml` as `TURNSTILE_SITE_KEY` (it is public and ends up in the page).
3. Store the **secret key** as a Worker secret:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

4. Deploy. If a challenge is ever required while the keys are missing, the request is refused with HTTP 503 and an error is logged, so a misconfiguration is visible rather than silently open.

For local development, `.dev.vars` (git-ignored) can hold Cloudflare's test keys, which always pass:

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

## Settings

| Variable | Default | Description |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | empty | Public widget key. |
| `TURNSTILE_SECRET_KEY` | empty | Secret. Set with `wrangler secret put`. |
| `CHALLENGE_ON_CREATE` | `suspicious` | `off`, `suspicious` or `always`. |
| `CHALLENGE_ON_ACCESS` | `off` | Same values, for following links. Off by default because link previews and crawlers are legitimate automated visitors. |
| `SUSPICION_THRESHOLD` | `3` | Score at which a request is challenged in `suspicious` mode. |
| `CHALLENGE_TIMEOUT` | `5000` | Verification request timeout in milliseconds. |
| `CHALLENGE_MAX_RETRIES` | `2` | Retries on network errors or 5xx responses (0–5). |
| `CHALLENGE_FALLBACK_ON_ERROR_CREATE` | `false` | Allow creation when Cloudflare's verification API is unreachable. |
| `CHALLENGE_FALLBACK_ON_ERROR_ACCESS` | `true` | Allow access when the verification API is unreachable. |
| `API_TOKEN` | empty | Optional secret. Requests carrying `Authorization: Bearer <token>` skip the challenge entirely. |

## What the visitor sees

The homepage submits the URL first. If the server answers `403` with `captcha_required: true`, the page loads the Turnstile script on demand, shows the widget in a dialog, and resubmits with the token once it is solved. Visitors that are not suspicious never load any Turnstile code.

When `CHALLENGE_ON_ACCESS` demands a check, `GET /<key>` returns a `403` page with the widget. After solving, the page reloads itself with `?captcha_token=...`; the Worker verifies the token, strips it from the forwarded query string, and redirects.

## Scripts and integrations

Scripts cannot solve Turnstile, and their requests usually score as suspicious. Give them the API token instead:

```bash
npx wrangler secret put API_TOKEN
```

```bash
curl -X POST https://your-worker.workers.dev/ \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/very/long/url"}'
```

A browser page on another origin can also pass a token it obtained from its own Turnstile widget, as long as that widget uses the same site key and hostname allowlist. Send it as `captcha_token`, `turnstile_token` or `cf-turnstile-response`.

## Verification details

1. Tokens shorter than 10 or longer than 2048 characters are rejected without a network call.
2. The Worker posts `{ secret, response, remoteip }` to `https://challenges.cloudflare.com/turnstile/v0/siteverify`.
3. `success: true` passes. `success: false` with visitor-side error codes (expired, duplicate, invalid) fails immediately.
4. An `invalid-input-secret` response is logged as a misconfiguration and follows the fallback setting.
5. Network errors and 5xx responses are retried with exponential backoff, then the fallback setting decides.

Turnstile tokens are single-use and expire after five minutes.

## Logging

```
Challenge demanded for create (automation user-agent, no accept-language, no origin or referer)
Turnstile verification attempt 1 failed: Timeout
Turnstile degraded (HTTP 503); allowing operation per fallback policy
```

Frequent "Challenge demanded" lines for real users mean the threshold is too low. Frequent "degraded" lines mean the verification API is unhealthy or `CHALLENGE_TIMEOUT` is too short.
