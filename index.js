/**
 * Tyrion - a URL shortener running on Cloudflare Workers.
 *
 * Bindings (see wrangler.toml):
 *   LINKS              KV namespace (required)
 *   ASSETS             Static assets from ./public (optional, serves the homepage)
 *   RATE_LIMITER       Rate limiting binding (optional, hard cap: 429 on link creation)
 *   CHALLENGE_LIMITER  Rate limiting binding (optional, soft cap: exceeding it makes
 *                      a request "suspicious" so it must pass a Turnstile challenge)
 *
 * Bot protection uses Cloudflare Turnstile. By default the challenge is only
 * demanded when a request looks suspicious (see assessRisk). All settings are
 * read from environment variables so nothing sensitive lives in source.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // Strip the Referer header when redirecting so the destination cannot see the
  // short link or the page that linked to it.
  no_ref: true,
  // Send CORS headers so other origins can call the JSON API.
  cors: true,
  // Reuse the same short key when the same long URL is submitted again.
  unique_link: true,
  // Forward query parameters given to the short link on to the destination.
  forward_query_params: true,
  // Seconds until a link expires (minimum 60). 0 keeps links forever.
  expiration_ttl: 0,
  // Longest URL accepted for shortening.
  max_url_length: 2048,
  // Length of generated short keys.
  key_length: 6,
  // HTTPS URL of a homepage to serve when there is no ASSETS binding.
  homepage_url: "",
  // Google Safe Browsing API key. Empty disables the check. Set as a secret.
  safe_browsing_api_key: "",
  // Optional bearer token that lets scripts use the API without a challenge.
  // Set as a secret; clients send "Authorization: Bearer <token>".
  api_token: "",
  challenge: {
    // Turnstile keys from the Cloudflare dashboard. The site key is public and
    // ends up in the HTML; the secret key must be a Worker secret.
    site_key: "",
    secret_key: "",
    // "off": never challenge. "suspicious": challenge only when assessRisk
    // scores the request at or above `threshold`. "always": challenge everyone.
    on_create: "suspicious",
    // Access defaults to off because link previews and crawlers following
    // short links are legitimate automated traffic.
    on_access: "off",
    threshold: 3,
    // Turnstile verification request timeout and retries.
    timeout: 5000,
    max_retries: 2,
    // When Turnstile's verification API cannot be reached: allow the operation?
    // Creation fails closed so an outage cannot be used for bulk creation.
    fallback_on_error_create: false,
    fallback_on_error_access: true,
  },
};

const MODES = ["off", "suspicious", "always"];

const ENV_MAP = {
  NO_REF: ["no_ref", "bool"],
  CORS: ["cors", "bool"],
  UNIQUE_LINK: ["unique_link", "bool"],
  FORWARD_QUERY_PARAMS: ["forward_query_params", "bool"],
  EXPIRATION_TTL: ["expiration_ttl", "int"],
  MAX_URL_LENGTH: ["max_url_length", "int"],
  KEY_LENGTH: ["key_length", "int"],
  HOMEPAGE_URL: ["homepage_url", "string"],
  SAFE_BROWSING_API_KEY: ["safe_browsing_api_key", "string"],
  API_TOKEN: ["api_token", "string"],
  TURNSTILE_SITE_KEY: ["challenge.site_key", "string"],
  TURNSTILE_SECRET_KEY: ["challenge.secret_key", "string"],
  CHALLENGE_ON_CREATE: ["challenge.on_create", "mode"],
  CHALLENGE_ON_ACCESS: ["challenge.on_access", "mode"],
  SUSPICION_THRESHOLD: ["challenge.threshold", "int"],
  CHALLENGE_TIMEOUT: ["challenge.timeout", "int"],
  CHALLENGE_MAX_RETRIES: ["challenge.max_retries", "int"],
  CHALLENGE_FALLBACK_ON_ERROR_CREATE: ["challenge.fallback_on_error_create", "bool"],
  CHALLENGE_FALLBACK_ON_ERROR_ACCESS: ["challenge.fallback_on_error_access", "bool"],
};

function parseBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (["true", "1", "on", "yes"].includes(v)) return true;
  if (["false", "0", "off", "no", ""].includes(v)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function parseMode(value, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (["off", "false", "0", "no", "never"].includes(v)) return "off";
  if (["always", "true", "1", "yes", "on"].includes(v)) return "always";
  if (["suspicious", "auto", "risk", "smart"].includes(v)) return "suspicious";
  return fallback;
}

/**
 * Builds the effective configuration from DEFAULTS overlaid with environment
 * variables. Unknown or malformed values fall back to the default.
 */
export function loadConfig(env = {}) {
  const cfg = { ...DEFAULTS, challenge: { ...DEFAULTS.challenge } };
  for (const [envName, [path, type]] of Object.entries(ENV_MAP)) {
    if (env[envName] === undefined || env[envName] === null) continue;
    const [head, tail] = path.split(".");
    const target = tail ? cfg[head] : cfg;
    const prop = tail || head;
    const current = target[prop];
    if (type === "bool") target[prop] = parseBool(env[envName], current);
    else if (type === "int") target[prop] = parseInteger(env[envName], current);
    else if (type === "mode") target[prop] = parseMode(env[envName], current);
    else target[prop] = String(env[envName]);
  }
  cfg.key_length = Math.min(Math.max(cfg.key_length, 4), 32);
  cfg.max_url_length = Math.max(cfg.max_url_length, 32);
  cfg.challenge.threshold = Math.max(cfg.challenge.threshold, 1);
  cfg.challenge.timeout = Math.max(cfg.challenge.timeout, 500);
  cfg.challenge.max_retries = Math.min(Math.max(cfg.challenge.max_retries, 0), 5);
  return cfg;
}

function challengeConfigured(cfg) {
  return Boolean(cfg.challenge.site_key && cfg.challenge.secret_key);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Characters used in short keys. Confusable glyphs (0/O, 1/l/I, ...) are left out.
const KEY_CHARS = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
// Shape of a short key path segment. Long hashes and prefixed keys never match.
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_PREFIX = "hash:";

/** Generates a random key with unbiased sampling from KEY_CHARS. */
export function randomKey(length = 6) {
  const limit = 256 - (256 % KEY_CHARS.length);
  let out = "";
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= limit) continue; // rejection sampling avoids modulo bias
      out += KEY_CHARS[b % KEY_CHARS.length];
      if (out.length === length) break;
    }
  }
  return out;
}

async function sha512Hex(text) {
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for secrets. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Escapes a string for safe insertion into HTML text or attribute values. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Validates a URL submitted for shortening.
 * Returns { ok: true, url } with a normalised URL, or { ok: false, error }.
 */
export function validateTargetUrl(input, { maxLength = 2048, selfHostname = "" } = {}) {
  if (typeof input !== "string") return { ok: false, error: "url must be a string" };
  const raw = input.trim();
  if (raw.length === 0) return { ok: false, error: "url is required" };
  if (raw.length > maxLength) return { ok: false, error: `url is longer than ${maxLength} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(raw)) return { ok: false, error: "url contains whitespace or control characters" };
  // These are invalid in URLs and are what HTML/JS injection payloads rely on.
  if (/[<>"`]/.test(raw)) return { ok: false, error: "url contains characters that are not allowed" };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "url is not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "only http and https URLs are allowed" };
  }
  if (url.username || url.password) return { ok: false, error: "credentials in URLs are not allowed" };
  if (!url.hostname) return { ok: false, error: "url has no hostname" };
  if (selfHostname && url.hostname.toLowerCase() === selfHostname.toLowerCase()) {
    return { ok: false, error: "cannot shorten a link to this service" };
  }
  if (url.href.length > maxLength) return { ok: false, error: `url is longer than ${maxLength} characters` };
  return { ok: true, url: url.href };
}

/**
 * Appends the query parameters of the short-link request to the destination.
 * The destination's own query string is preserved verbatim; parameters used by
 * this service (the challenge token) are never forwarded.
 */
export function buildDestination(target, searchParams, { forward = true, strip = ["captcha_token"] } = {}) {
  if (!forward) return target;
  const extra = new URLSearchParams();
  for (const [k, v] of searchParams) {
    if (!strip.includes(k)) extra.append(k, v);
  }
  const extraString = extra.toString();
  if (!extraString) return target;
  const url = new URL(target);
  url.search = url.search ? `${url.search}&${extraString}` : `?${extraString}`;
  return url.href;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// ---------------------------------------------------------------------------
// Risk assessment: decides whether a request looks automated
// ---------------------------------------------------------------------------

// User-Agent fragments typical of HTTP libraries, CLI tools and headless browsers.
const AUTOMATION_UA =
  /curl|wget|python|httpx|aiohttp|go-http-client|okhttp|java\/|libwww|scrapy|node-fetch|undici|axios|postman|insomnia|headless|phantom|puppeteer|playwright|selenium|\bbot\b|spider|crawler/i;

/**
 * Scores how suspicious a request looks. Each signal adds points; the caller
 * compares the total against the configured threshold. Signals:
 *   - Cloudflare Bot Management score (Enterprise plans only; ignored elsewhere)
 *   - the soft rate limit (CHALLENGE_LIMITER) having been exceeded
 *   - missing or automation-style User-Agent
 *   - a browser User-Agent without the Sec-Fetch-* headers every real browser sends
 *   - missing Accept-Language
 *   - a JSON POST with neither Origin nor Referer (browsers always send Origin on POST)
 *   - obsolete TLS
 * Verified bots (Enterprise Bot Management) score zero.
 */
export function assessRisk(request, { operation = "create", softLimited = false } = {}) {
  const h = request.headers;
  const cf = request.cf || {};
  const reasons = [];
  let score = 0;
  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };

  const bm = cf.botManagement;
  if (bm && typeof bm === "object") {
    if (bm.verifiedBot) return { score: 0, reasons: ["verified bot"] };
    if (typeof bm.score === "number" && bm.score > 0 && bm.score < 30) add(3, `bot score ${bm.score}`);
  }
  if (softLimited) add(3, "creation rate exceeded");

  const ua = h.get("user-agent") || "";
  if (!ua) add(3, "no user-agent");
  else if (AUTOMATION_UA.test(ua)) add(2, "automation user-agent");
  if (/Mozilla\/5\.0/.test(ua) && !h.get("sec-fetch-mode")) add(2, "browser user-agent without sec-fetch headers");
  if (!h.get("accept-language")) add(1, "no accept-language");
  if (operation === "create" && !h.get("origin") && !h.get("referer")) add(1, "no origin or referer");
  if (typeof cf.tlsVersion === "string" && /^TLSv1(\.[01])?$/.test(cf.tlsVersion)) add(1, `obsolete ${cf.tlsVersion}`);

  return { score, reasons };
}

function needsChallenge(mode, risk, cfg) {
  if (mode === "off") return false;
  if (mode === "always") return true;
  return risk.score >= cfg.challenge.threshold;
}

// ---------------------------------------------------------------------------
// Responses and headers
// ---------------------------------------------------------------------------

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;
const TURNSTILE_VERIFY = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Pages fully generated by this worker carry no scripts unless stated otherwise.
const STRICT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** CSP for pages that may embed the Turnstile widget. */
function turnstileCsp(extraScriptSrc = []) {
  const scriptSrc = ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN, ...extraScriptSrc].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `frame-src ${TURNSTILE_ORIGIN}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function corsHeaders(cfg) {
  if (!cfg.cors) return {};
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body, status, cfg) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...BASE_SECURITY_HEADERS,
      ...corsHeaders(cfg),
    },
  });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": STRICT_CSP,
      ...BASE_SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function redirectResponse(location, cfg) {
  const headers = {
    Location: location,
    "Cache-Control": "no-store",
    ...BASE_SECURITY_HEADERS,
  };
  // A Referrer-Policy on the redirect response governs the redirected request,
  // so the destination never learns where the visitor came from.
  if (cfg.no_ref) headers["Referrer-Policy"] = "no-referrer";
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------
// Page templates (all interpolated values are escaped)
// ---------------------------------------------------------------------------

// Shares its design tokens with public/index.html so every page looks like one product.
const PAGE_STYLE = `
  :root { --bg:#f4f5f9; --card:#fff; --text:#14161f; --muted:#646b7a; --line:#e3e6ee; --field:#f8f9fc;
          --accent:#4f46e5; --accent-hover:#4338ca; --accent-soft:#eef0ff; --accent-text:#3730a3;
          --danger:#dc2626; --danger-soft:#fef2f2; --glow-a:rgba(79,70,229,.18); --glow-b:rgba(236,72,153,.12);
          --shadow:0 24px 60px -24px rgba(20,22,31,.28); --ring:0 0 0 4px rgba(79,70,229,.18); }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0e1017; --card:#161925; --text:#eef0f6; --muted:#9aa2b5; --line:#262a38; --field:#0f1219;
            --accent:#7c74ff; --accent-hover:#9089ff; --accent-soft:#1f1e3d; --accent-text:#c7c3ff;
            --danger:#f87171; --danger-soft:#2a1516; --glow-a:rgba(124,116,255,.22); --glow-b:rgba(236,72,153,.14);
            --shadow:0 24px 60px -24px rgba(0,0,0,.7); --ring:0 0 0 4px rgba(124,116,255,.28); }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 20px;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif; line-height: 1.5; color: var(--text);
         background: radial-gradient(60vw 60vw at 10% -10%, var(--glow-a), transparent 60%),
                     radial-gradient(50vw 50vw at 100% 110%, var(--glow-b), transparent 60%), var(--bg); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow);
          padding: 32px; max-width: 480px; width: 100%; text-align: center; }
  .mark { width: 44px; height: 44px; border-radius: 12px; background: var(--accent); margin: 0 auto 16px; display: flex; align-items: center; justify-content: center; }
  h1 { font-size: 1.35rem; letter-spacing: -.01em; margin: 0 0 .5rem; }
  p { color: var(--muted); margin: 0 0 1rem; }
  a { color: var(--accent-text); }
  .url { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; text-align: left;
         background: var(--field); border: 1px solid var(--line); padding: .75rem; border-radius: 10px; margin-bottom: 1.25rem; }
  .btn, a.button { display: inline-flex; align-items: center; justify-content: center; height: 46px; padding: 0 20px; font: inherit; font-weight: 600;
                   color: #fff; background: var(--accent); border: 0; border-radius: 10px; text-decoration: none; cursor: pointer; }
  .btn:hover, a.button:hover { background: var(--accent-hover); }
  .btn:focus-visible, a.button:focus-visible, .input:focus { outline: none; box-shadow: var(--ring); }
  a.button.danger { background: var(--danger); }
  a.button.ghost { color: var(--accent-text); background: var(--accent-soft); }
  .input { width: 100%; height: 50px; padding: 0 14px; font: inherit; color: var(--text); background: var(--field);
           border: 1.5px solid var(--line); border-radius: 10px; margin-bottom: 12px; }
  .input:focus { border-color: var(--accent); background: var(--card); }
  .widget { display: flex; justify-content: center; min-height: 65px; margin: 1rem 0; }
  .out { margin-top: 1rem; word-break: break-all; }
  @media (prefers-reduced-motion: no-preference) { .card { animation: rise .45s cubic-bezier(.2,.8,.2,1) both; } @keyframes rise { from { opacity: 0; transform: translateY(12px); } } }
`;

const PAGE_MARK = `<div class="mark" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 32 32" fill="none"><path d="M11 13.5a4.5 4.5 0 0 1 4.5-4.5h1a4.5 4.5 0 0 1 0 9h-1" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M21 18.5a4.5 4.5 0 0 1-4.5 4.5h-1a4.5 4.5 0 0 1 0-9h1" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg></div>`;

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="card">
${PAGE_MARK}
${body}
</div>
</body>
</html>`;
}

function notFoundPage() {
  return page("404 Not Found", `<h1>This link doesn't exist</h1><p>It may have expired or been typed incorrectly.</p><a class="button ghost" href="/">Create a short link</a>`);
}

function errorPage() {
  return page("Something went wrong", `<h1>Something went wrong</h1><p>The request could not be completed. Please try again later.</p>`);
}

function unsafeUrlPage(destination) {
  const safe = escapeHtml(destination);
  return page(
    "Warning: risky destination",
    `<h1>This link looks dangerous</h1>
<p>Google Safe Browsing flagged the destination as malware, phishing or unwanted software. Proceed only if you trust it.</p>
<div class="url">${safe}</div>
<a class="button danger" href="${safe}" rel="noreferrer noopener">Continue anyway</a>`,
  );
}

function siteKeyForHtml(cfg) {
  // Turnstile site keys are plain ASCII identifiers; strip anything else.
  return cfg.challenge.site_key.replace(/[^A-Za-z0-9_-]/g, "");
}

function challengePage(cfg) {
  const body = `
<h1>One quick check</h1>
<p>This link is protected. Complete the verification below and you'll be on your way.</p>
<div id="turnstile-box" class="widget"></div>
<p id="status" hidden>Verifying and redirecting&hellip;</p>
<script src="${TURNSTILE_SCRIPT}?onload=onTurnstileLoad&render=explicit" async defer></script>
<script>
  function onTurnstileLoad() {
    turnstile.render("#turnstile-box", {
      sitekey: "${siteKeyForHtml(cfg)}",
      callback: function (token) {
        document.getElementById("status").hidden = false;
        var next = new URL(window.location.href);
        next.searchParams.set("captcha_token", token);
        window.location.replace(next.href);
      }
    });
  }
</script>`;
  return page("Verification required", body);
}

function challengeFailedPage(message, retryPath) {
  return page(
    "Verification failed",
    `<h1>Verification failed</h1><p>${escapeHtml(message)}</p><a class="button" href="${escapeHtml(retryPath)}">Try again</a>`,
  );
}

function challengeUnavailablePage() {
  return page(
    "Verification unavailable",
    `<h1>Verification unavailable</h1><p>This link requires a verification step that is not configured. Please try again later.</p>`,
  );
}

/** Minimal homepage used when neither ASSETS nor HOMEPAGE_URL is configured. */
function fallbackHomepage(cfg) {
  const body = `
<h1>Tyrion URL Shortener</h1>
<form id="f">
  <input id="url" class="input" type="url" required placeholder="https://example.com/very/long/link" autofocus>
  <div id="turnstile-box" class="widget" hidden></div>
  <button type="submit" class="btn">Shorten</button>
</form>
<p id="out" class="out"></p>
<script>
  var SITE_KEY = "${siteKeyForHtml(cfg)}";
  var token = null, widgetId = null, pending = null;
  function loadTurnstile() {
    return new Promise(function (resolve, reject) {
      if (window.turnstile && typeof window.turnstile.render === "function") return resolve();
      var s = document.createElement("script");
      s.src = "${TURNSTILE_SCRIPT}?render=explicit";
      s.async = true; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  async function challenge() {
    var box = document.getElementById("turnstile-box");
    box.hidden = false;
    await loadTurnstile();
    if (widgetId !== null) { turnstile.reset(widgetId); return; }
    widgetId = turnstile.render(box, { sitekey: SITE_KEY, callback: function (t) { token = t; submit(pending); } });
  }
  async function submit(url) {
    var out = document.getElementById("out");
    out.textContent = "Working...";
    try {
      var res = await fetch("/", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url, captcha_token: token }) });
      var data = await res.json();
      token = null;
      if (data.status === 200) { out.textContent = ""; var a = document.createElement("a"); a.href = data.key; a.textContent = location.origin + data.key; out.appendChild(a); }
      else if (data.captcha_required) { pending = url; out.textContent = "Please complete the check below."; challenge(); }
      else { out.textContent = data.error || "Request failed"; }
    } catch (err) { out.textContent = "Network error"; }
  }
  document.getElementById("f").addEventListener("submit", function (e) { e.preventDefault(); submit(document.getElementById("url").value); });
</script>`;
  return page("Tyrion URL Shortener", body);
}

// ---------------------------------------------------------------------------
// External services
// ---------------------------------------------------------------------------

/**
 * Verifies a Turnstile token with Cloudflare. Returns { success, degraded, error? }.
 * `fallback` decides what happens when the verification API cannot be reached.
 */
export async function verifyTurnstile(token, cfg, { remoteip = "", fallback = false, fetchImpl = fetch } = {}) {
  if (!token || typeof token !== "string" || token.length < 10 || token.length > 2048) {
    return { success: false, degraded: false, error: "Invalid token format" };
  }
  if (!cfg.challenge.secret_key) {
    return { success: false, degraded: false, error: "Verification is not configured" };
  }

  let lastError = null;
  for (let attempt = 0; attempt <= cfg.challenge.max_retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.challenge.timeout);
    try {
      const response = await fetchImpl(TURNSTILE_VERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: cfg.challenge.secret_key, response: token, remoteip: remoteip || undefined }),
        signal: controller.signal,
      });
      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        if (result.success === true) return { success: true, degraded: false };
        const codes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
        // A bad secret is our misconfiguration, not the visitor's fault.
        if (codes.some((c) => /secret/.test(c))) {
          lastError = `misconfigured: ${codes.join(",")}`;
          console.error(`Turnstile ${lastError}`);
          break;
        }
        return { success: false, degraded: false, error: "Verification failed or expired, please try again" };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error && error.name === "AbortError" ? "Timeout" : String(error && error.message);
    } finally {
      clearTimeout(timer);
    }
    console.error(`Turnstile verification attempt ${attempt + 1} failed: ${lastError}`);
    if (attempt < cfg.challenge.max_retries) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100));
    }
  }

  if (fallback) {
    console.warn(`Turnstile degraded (${lastError}); allowing operation per fallback policy`);
    return { success: true, degraded: true };
  }
  return { success: false, degraded: false, error: "Verification service unavailable, please try again later" };
}

/** Google Safe Browsing lookup. Returns { safe, error? }; errors fail open. */
export async function isUrlSafe(url, cfg, fetchImpl = fetch) {
  if (!cfg.safe_browsing_api_key) return { safe: true };
  const body = {
    client: { clientId: "Tyrion-Url-Shortener", clientVersion: "2.0" },
    threatInfo: {
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "POTENTIALLY_HARMFUL_APPLICATION", "UNWANTED_SOFTWARE"],
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: [{ url }],
    },
  };
  try {
    const endpoint = new URL("https://safebrowsing.googleapis.com/v4/threatMatches:find");
    endpoint.searchParams.set("key", cfg.safe_browsing_api_key);
    const res = await fetchImpl(endpoint.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`Safe Browsing lookup failed: HTTP ${res.status}`);
      return { safe: true, error: `HTTP ${res.status}` };
    }
    const result = await res.json();
    return { safe: !(Array.isArray(result.matches) && result.matches.length > 0) };
  } catch (error) {
    console.error(`Safe Browsing lookup failed: ${error && error.message}`);
    return { safe: true, error: String(error && error.message) };
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function kvPutOptions(cfg) {
  return cfg.expiration_ttl >= 60 ? { expirationTtl: cfg.expiration_ttl } : {};
}

async function storeUrl(env, cfg, url) {
  const options = kvPutOptions(cfg);
  let hash = null;
  if (cfg.unique_link) {
    hash = HASH_PREFIX + (await sha512Hex(url));
    const existing = await env.LINKS.get(hash);
    if (existing && KEY_PATTERN.test(existing)) {
      // Make sure the stored key still resolves before reusing it.
      if ((await env.LINKS.get(existing)) === url) return existing;
    }
  }

  let length = cfg.key_length;
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = randomKey(length);
    if ((await env.LINKS.get(key)) !== null) {
      if (attempt >= 3) length += 1; // keyspace is getting crowded
      continue;
    }
    await env.LINKS.put(key, url, options);
    if (hash) await env.LINKS.put(hash, key, options);
    return key;
  }
  throw new Error("Could not allocate a unique short key");
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

function hasApiToken(request, cfg) {
  if (!cfg.api_token) return false;
  const auth = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return Boolean(match && safeEqual(match[1], cfg.api_token));
}

async function handleCreate(request, env, cfg) {
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: clientIp(request) });
    if (!success) return jsonResponse({ status: 429, error: "Too many requests, slow down" }, 429, cfg);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ status: 400, error: "Request body must be JSON" }, 400, cfg);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ status: 400, error: "Request body must be a JSON object" }, 400, cfg);
  }

  const requestUrl = new URL(request.url);
  const check = validateTargetUrl(body.url, { maxLength: cfg.max_url_length, selfHostname: requestUrl.hostname });
  if (!check.ok) return jsonResponse({ status: 400, error: check.error }, 400, cfg);

  const mode = cfg.challenge.on_create;
  if (mode !== "off" && !hasApiToken(request, cfg)) {
    let softLimited = false;
    if (env.CHALLENGE_LIMITER) {
      softLimited = !(await env.CHALLENGE_LIMITER.limit({ key: clientIp(request) })).success;
    }
    const risk = assessRisk(request, { operation: "create", softLimited });
    if (needsChallenge(mode, risk, cfg)) {
      const why = risk.reasons.join(", ") || "policy";
      if (!challengeConfigured(cfg)) {
        console.error(`Challenge required (${why}) but TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are not set`);
        return jsonResponse({ status: 503, error: "Verification is required but not configured on this server" }, 503, cfg);
      }
      const token = body.captcha_token || body.turnstile_token || body["cf-turnstile-response"];
      if (!token) {
        console.log(`Challenge demanded for create (${why})`);
        return jsonResponse({ status: 403, error: "Verification required", captcha_required: true }, 403, cfg);
      }
      const verdict = await verifyTurnstile(token, cfg, { remoteip: clientIp(request), fallback: cfg.challenge.fallback_on_error_create });
      if (!verdict.success) {
        return jsonResponse({ status: 403, error: verdict.error || "Verification failed", captcha_required: true }, 403, cfg);
      }
    }
  }

  const safety = await isUrlSafe(check.url, cfg);
  if (!safety.safe) return jsonResponse({ status: 400, error: "The URL was flagged as unsafe by Google Safe Browsing" }, 400, cfg);

  let key;
  try {
    key = await storeUrl(env, cfg, check.url);
  } catch (error) {
    console.error(`KV write failed: ${error && error.message}`);
    return jsonResponse({ status: 500, error: "Could not store the link, please try again" }, 500, cfg);
  }

  return jsonResponse(
    { status: 200, key: `/${key}`, short_url: `/${key}`, url: `${requestUrl.origin}/${key}` },
    200,
    cfg,
  );
}

async function serveHomepage(request, env, cfg) {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": turnstileCsp(),
    "Cache-Control": "public, max-age=300",
    ...BASE_SECURITY_HEADERS,
  };
  // The homepage template carries a placeholder for the public Turnstile site key.
  const inject = (html) => html.replace(/\{\{TURNSTILE_SITE_KEY\}\}/g, siteKeyForHtml(cfg));

  if (env.ASSETS) {
    const asset = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), { method: "GET" }));
    if (asset.ok) return new Response(inject(await asset.text()), { headers });
  }

  if (cfg.homepage_url && cfg.homepage_url.startsWith("https://")) {
    try {
      const upstream = await fetch(cfg.homepage_url, { cf: { cacheTtl: 300, cacheEverything: true } });
      if (upstream.ok) return new Response(inject(await upstream.text()), { headers });
      console.error(`Homepage fetch failed: HTTP ${upstream.status}`);
    } catch (error) {
      console.error(`Homepage fetch failed: ${error && error.message}`);
    }
  }

  return new Response(fallbackHomepage(cfg), { headers: { ...headers, "Cache-Control": "no-store" } });
}

async function handleAccess(request, env, cfg) {
  const requestUrl = new URL(request.url);
  const segments = requestUrl.pathname.split("/");
  const key = segments[1] || "";

  if (!KEY_PATTERN.test(key) || key.includes(":")) return htmlResponse(notFoundPage(), 404);

  const target = await env.LINKS.get(key);
  if (!target) return htmlResponse(notFoundPage(), 404);

  let destination;
  try {
    destination = buildDestination(target, requestUrl.searchParams, { forward: cfg.forward_query_params });
    new URL(destination); // stored values written by older versions might not be valid URLs
  } catch {
    console.error(`Stored value for key ${key} is not a valid URL`);
    return htmlResponse(notFoundPage(), 404);
  }

  const mode = cfg.challenge.on_access;
  if (mode !== "off") {
    const risk = assessRisk(request, { operation: "access" });
    if (needsChallenge(mode, risk, cfg)) {
      if (!challengeConfigured(cfg)) {
        console.error("Challenge required for access but TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY are not set");
        return htmlResponse(challengeUnavailablePage(), 503);
      }
      const token = requestUrl.searchParams.get("captcha_token");
      if (!token) {
        console.log(`Challenge demanded for access to ${key} (${risk.reasons.join(", ") || "policy"})`);
        return htmlResponse(challengePage(cfg), 403, { "Content-Security-Policy": turnstileCsp() });
      }
      const verdict = await verifyTurnstile(token, cfg, { remoteip: clientIp(request), fallback: cfg.challenge.fallback_on_error_access });
      if (!verdict.success) {
        const retry = new URL(requestUrl.href);
        retry.searchParams.delete("captcha_token");
        return htmlResponse(challengeFailedPage(verdict.error || "Verification failed", retry.pathname + retry.search), 403);
      }
    }
  }

  const safety = await isUrlSafe(destination, cfg);
  if (!safety.safe) return htmlResponse(unsafeUrlPage(destination), 200);

  return redirectResponse(destination, cfg);
}

async function route(request, env, cfg) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...corsHeaders(cfg), ...BASE_SECURITY_HEADERS } });
  }
  if (request.method === "POST") {
    if (url.pathname !== "/") return jsonResponse({ status: 404, error: "Not found. POST to / to create a link" }, 404, cfg);
    return handleCreate(request, env, cfg);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ status: 405, error: "Method not allowed" }, 405, cfg);
  }
  if (url.pathname === "/") return serveHomepage(request, env, cfg);
  if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico" || url.pathname === "/robots.txt") {
    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.ok) return asset;
    }
    return new Response(null, { status: 404, headers: BASE_SECURITY_HEADERS });
  }
  return handleAccess(request, env, cfg);
}

export default {
  async fetch(request, env) {
    const cfg = loadConfig(env);
    if (!env.LINKS) {
      console.error("KV binding LINKS is missing");
      return htmlResponse(errorPage(), 500);
    }
    try {
      return await route(request, env, cfg);
    } catch (error) {
      console.error(`Unhandled error for ${request.method} ${request.url}: ${error && error.stack ? error.stack : error}`);
      if (request.method === "POST") return jsonResponse({ status: 500, error: "Internal error" }, 500, cfg);
      return htmlResponse(errorPage(), 500);
    }
  },
};
