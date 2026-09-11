# Tyrion

A URL shortener running on Cloudflare Workers, with adaptive bot protection via [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) and optional Google Safe Browsing checks.

- Short links are stored in Workers KV and served with a plain `302` redirect.
- Bot protection is adaptive: requests are risk-scored and only suspicious ones (tool user agents, missing browser headers, too many creations per minute) have to pass a Turnstile challenge. Ordinary visitors never see it.
- The homepage is a single dependency-free file in [`public/`](public/) served through Workers Static Assets. It loads no third-party code unless a Turnstile check is required, supports dark mode, and keeps a per-browser list of recent links.
- Every setting is an environment variable. Secrets are Worker secrets, never source code.
- Redirects carry `Referrer-Policy: no-referrer` (configurable) so destinations do not learn where visitors came from.
- Submitted URLs are validated with the URL parser; anything that is not a plain absolute `http`/`https` URL is refused.

📚 [API documentation](docs/API.md) · [Bot protection documentation](docs/CAPTCHA.md) · [中文文档](docs/API_zh-hans.md)

## Deploy with Wrangler (recommended)

```bash
npm install
```

Create the KV namespace and paste the returned `id` into [`wrangler.toml`](wrangler.toml):

```bash
npx wrangler kv namespace create LINKS
```

Create a Turnstile widget for your hostname in the Cloudflare dashboard (**Turnstile → Add widget**, type *Managed*). Put its site key in `wrangler.toml` as `TURNSTILE_SITE_KEY` and store the secret key:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Optional: enable Safe Browsing checks by storing your Google API key as a secret.

```bash
npx wrangler secret put SAFE_BROWSING_API_KEY
```

Optional: let your own scripts create links without a challenge.

```bash
npx wrangler secret put API_TOKEN
```

Run locally, then deploy:

```bash
npm run dev
```

```bash
npm run deploy
```

Recommended: uncomment the `CHALLENGE_LIMITER` block in `wrangler.toml`. It is a soft per-IP limit on link creation; going over it does not block anyone, it just makes the request "suspicious" so a Turnstile check is required. The `RATE_LIMITER` block is a hard cap that answers `429`.

For local development, put Cloudflare's always-passing Turnstile test keys in a git-ignored `.dev.vars` file:

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

## Deploy from the Cloudflare dashboard

1. Create a Worker and paste the contents of [`index.js`](index.js) into the editor.
2. Under **Settings → Bindings**, add a KV namespace binding named `LINKS`.
3. Under **Settings → Variables**, add `TURNSTILE_SITE_KEY`, add `TURNSTILE_SECRET_KEY` as a secret, and any other settings you want to change (see below).
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
| `API_TOKEN` | empty | Optional **secret**. Requests with `Authorization: Bearer <token>` skip the challenge, for your own scripts. |
| `TURNSTILE_SITE_KEY` | empty | Public Turnstile widget key. |
| `TURNSTILE_SECRET_KEY` | empty | Turnstile secret. Store as a **secret**. |
| `CHALLENGE_ON_CREATE` | `suspicious` | When to demand a Turnstile check for link creation: `off`, `suspicious` or `always`. |
| `CHALLENGE_ON_ACCESS` | `off` | Same, for following links. Off by default so link previews and crawlers keep working. |
| `SUSPICION_THRESHOLD` | `3` | Risk score at which a request counts as suspicious. See the [bot protection docs](docs/CAPTCHA.md) for the signals. |
| `CHALLENGE_TIMEOUT` | `5000` | Turnstile verification timeout in milliseconds. |
| `CHALLENGE_MAX_RETRIES` | `2` | Retries against the verification API (0–5). |
| `CHALLENGE_FALLBACK_ON_ERROR_CREATE` | `false` | If the verification API is unreachable, still allow link creation. Off by default so an outage cannot be used for bulk creation. |
| `CHALLENGE_FALLBACK_ON_ERROR_ACCESS` | `true` | If the verification API is unreachable, still allow following links. |

## Development

```bash
npm test
```

The tests run on Node's built-in test runner and cover validation, redirects, risk scoring, Turnstile gating, Safe Browsing handling and error paths without needing a Cloudflare account.

## Notes on bot protection

Header heuristics alone can be imitated by a determined script. The soft rate limit closes that gap by challenging anyone who creates more than a handful of links per minute, and Bot Management scores are used automatically on Enterprise plans. Scripts you trust should use `API_TOKEN` rather than trying to pass the challenge.

## Upstream

This project is a fork of [xyTom/Url-Shorten-Worker](https://github.com/xyTom/Url-Shorten-Worker).
