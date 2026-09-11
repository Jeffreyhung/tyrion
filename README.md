# Tyrion

A URL shortener running on Cloudflare Workers, with optional CAPTCHA (via [Cap](https://capjs.js.org)) and Google Safe Browsing checks.

- Short links are stored in Workers KV and served with a plain `302` redirect.
- The homepage is a static file in [`public/`](public/) served through Workers Static Assets. No HTML is fetched from third-party sites at request time.
- Every setting is an environment variable. Secrets are Worker secrets, never source code.
- Redirects carry `Referrer-Policy: no-referrer` (configurable) so destinations do not learn where visitors came from.
- Submitted URLs are validated with the URL parser; anything that is not a plain absolute `http`/`https` URL is refused.

📚 [API documentation](docs/API.md) · [CAPTCHA documentation](docs/CAPTCHA.md) · [中文文档](docs/API_zh-hans.md)

## Deploy with Wrangler (recommended)

```bash
npm install
```

Create the KV namespace and paste the returned `id` into [`wrangler.toml`](wrangler.toml):

```bash
npx wrangler kv namespace create LINKS
```

Optional: enable Safe Browsing checks by storing your Google API key as a secret.

```bash
npx wrangler secret put SAFE_BROWSING_API_KEY
```

Run locally, then deploy:

```bash
npm run dev
```

```bash
npm run deploy
```

Optional: rate-limit link creation per IP by uncommenting the `[[ratelimits]]` block in `wrangler.toml`. The worker uses the `RATE_LIMITER` binding automatically when it exists.

## Deploy from the Cloudflare dashboard

1. Create a Worker and paste the contents of [`index.js`](index.js) into the editor.
2. Under **Settings → Bindings**, add a KV namespace binding named `LINKS`.
3. Under **Settings → Variables**, add any settings you want to change (see below) and add `SAFE_BROWSING_API_KEY` as a secret if you use it.
4. Deploy.

Without the `ASSETS` binding the worker serves a small built-in homepage. To use the full theme instead, host [`public/index.html`](public/index.html) somewhere over HTTPS and set `HOMEPAGE_URL` to its address.

## Settings

All values are strings. Booleans accept `true`/`false` (also `on`/`off`, `1`/`0`).

| Variable | Default | Description |
| --- | --- | --- |
| `NO_REF` | `true` | Send `Referrer-Policy: no-referrer` on redirects so the destination cannot see the referrer. |
| `CORS` | `true` | Send CORS headers so other origins may call the JSON API. |
| `UNIQUE_LINK` | `true` | Reuse the same short key when the same URL is submitted again. |
| `FORWARD_QUERY_PARAMS` | `true` | Append query parameters given to the short link on to the destination. |
| `EXPIRATION_TTL` | `0` | Seconds until a link expires (minimum `60`). `0` keeps links forever. |
| `MAX_URL_LENGTH` | `2048` | Longest URL accepted. |
| `KEY_LENGTH` | `6` | Length of generated short keys (4–32). |
| `HOMEPAGE_URL` | empty | HTTPS URL of a homepage to serve when there is no `ASSETS` binding. |
| `SAFE_BROWSING_API_KEY` | empty | Google Safe Browsing key. Store as a **secret**. Enables checks at creation and on access. |
| `CAPTCHA_ENABLED` | `true` | Master switch for CAPTCHA. |
| `CAPTCHA_API_ENDPOINT` | `https://captcha.gurl.eu.org/api` | Cap server API. Self-host Cap to remove the third-party dependency. |
| `CAPTCHA_WIDGET_SCRIPT_URL` | `https://captcha.gurl.eu.org/cap.min.js` | Cap widget script loaded by the challenge pages. |
| `CAPTCHA_ASSET_HOSTS` | `https://cdn.jsdelivr.net` | Extra origins allowed by the Content Security Policy for widget code. The stock widget loads its WebAssembly solver from jsdelivr. |
| `CAPTCHA_REQUIRE_ON_CREATE` | `true` | Require a solved CAPTCHA to create a link. |
| `CAPTCHA_REQUIRE_ON_ACCESS` | `false` | Require a solved CAPTCHA to follow a link. |
| `CAPTCHA_TIMEOUT` | `5000` | Cap API timeout in milliseconds. |
| `CAPTCHA_MAX_RETRIES` | `2` | Retries against the Cap API (0–5). |
| `CAPTCHA_FALLBACK_ON_ERROR_CREATE` | `false` | If the Cap server is unreachable, still allow link creation. Off by default so an outage cannot be used for bulk creation. |
| `CAPTCHA_FALLBACK_ON_ERROR_ACCESS` | `true` | If the Cap server is unreachable, still allow following links. |

## Development

```bash
npm test
```

The tests run on Node's built-in test runner and cover validation, redirects, CAPTCHA gating, Safe Browsing handling and error paths without needing a Cloudflare account.

## Notes on the CAPTCHA

Cap is a proof-of-work CAPTCHA: it makes automated abuse expensive rather than impossible. Combine it with the rate limiter for meaningful protection, and consider self-hosting a Cap server so link creation does not depend on a third party being reachable.

## Upstream

This project is a fork of [xyTom/Url-Shorten-Worker](https://github.com/xyTom/Url-Shorten-Worker).
