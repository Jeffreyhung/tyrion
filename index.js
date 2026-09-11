/**
 * Tyrion - a URL shortener running on Cloudflare Workers.
 *
 * Bindings (see wrangler.toml):
 *   LINKS         KV namespace (required)
 *   ASSETS        Static assets from ./public (optional, serves the homepage)
 *   RATE_LIMITER  Rate limiting binding (optional, throttles link creation per IP)
 *
 * All settings are read from environment variables so nothing sensitive lives in
 * source. See DEFAULTS below for the list and the README for how to set them.
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
  captcha: {
    enabled: true,
    // Cap server (https://capjs.js.org). Self-host it to remove the third party.
    api_endpoint: "https://captcha.gurl.eu.org/api",
    widget_script_url: "https://captcha.gurl.eu.org/cap.min.js",
    // Extra origins the widget loads code from (space separated). The stock
    // widget fetches its WebAssembly solver from jsdelivr.
    asset_hosts: "https://cdn.jsdelivr.net",
    require_on_create: true,
    require_on_access: false,
    timeout: 5000,
    max_retries: 2,
    // When the Cap server cannot be reached: allow the operation anyway?
    // Creation fails closed by default so an outage does not open the door to
    // bulk link creation. Access fails open so existing links keep working.
    fallback_on_error_create: false,
    fallback_on_error_access: true,
  },
};

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
  CAPTCHA_ENABLED: ["captcha.enabled", "bool"],
  CAPTCHA_API_ENDPOINT: ["captcha.api_endpoint", "string"],
  CAPTCHA_WIDGET_SCRIPT_URL: ["captcha.widget_script_url", "string"],
  CAPTCHA_ASSET_HOSTS: ["captcha.asset_hosts", "string"],
  CAPTCHA_REQUIRE_ON_CREATE: ["captcha.require_on_create", "bool"],
  CAPTCHA_REQUIRE_ON_ACCESS: ["captcha.require_on_access", "bool"],
  CAPTCHA_TIMEOUT: ["captcha.timeout", "int"],
  CAPTCHA_MAX_RETRIES: ["captcha.max_retries", "int"],
  CAPTCHA_FALLBACK_ON_ERROR_CREATE: ["captcha.fallback_on_error_create", "bool"],
  CAPTCHA_FALLBACK_ON_ERROR_ACCESS: ["captcha.fallback_on_error_access", "bool"],
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

/**
 * Builds the effective configuration from DEFAULTS overlaid with environment
 * variables. Unknown or malformed values fall back to the default.
 */
export function loadConfig(env = {}) {
  const cfg = { ...DEFAULTS, captcha: { ...DEFAULTS.captcha } };
  for (const [envName, [path, type]] of Object.entries(ENV_MAP)) {
    if (env[envName] === undefined || env[envName] === null) continue;
    const [head, tail] = path.split(".");
    const target = tail ? cfg[head] : cfg;
    const prop = tail || head;
    const current = target[prop];
    if (type === "bool") target[prop] = parseBool(env[envName], current);
    else if (type === "int") target[prop] = parseInteger(env[envName], current);
    else target[prop] = String(env[envName]);
  }
  cfg.key_length = Math.min(Math.max(cfg.key_length, 4), 32);
  cfg.max_url_length = Math.max(cfg.max_url_length, 32);
  cfg.captcha.timeout = Math.max(cfg.captcha.timeout, 500);
  cfg.captcha.max_retries = Math.min(Math.max(cfg.captcha.max_retries, 0), 5);
  return cfg;
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
 * this service (the CAPTCHA token) are never forwarded.
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
// Responses and headers
// ---------------------------------------------------------------------------

const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Pages fully generated by this worker carry no scripts unless stated otherwise.
const STRICT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function corsHeaders(cfg) {
  if (!cfg.cors) return {};
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

/** CSP for pages that embed the Cap CAPTCHA widget. */
function captchaCsp(cfg, extraScriptSrc = []) {
  const widgetOrigin = safeOrigin(cfg.captcha.widget_script_url);
  const apiOrigin = safeOrigin(cfg.captcha.api_endpoint);
  const assetHosts = cfg.captcha.asset_hosts.split(/\s+/).map(safeOrigin).filter(Boolean);
  // The widget's blob: worker inherits this policy and compiles WebAssembly, so
  // the asset hosts must be allowed for scripts, fetches and the default.
  const scriptSrc = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", widgetOrigin, ...assetHosts, ...extraScriptSrc].filter(Boolean).join(" ");
  const connectSrc = ["'self'", apiOrigin, ...assetHosts].filter(Boolean).join(" ");
  return [
    `default-src 'self' ${assetHosts.join(" ")}`.trim(),
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc}`,
    "worker-src 'self' blob:",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "frame-src https://challenges.cloudflare.com",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Page templates (all interpolated values are escaped)
// ---------------------------------------------------------------------------

const PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; background: #f5f5f7; color: #1d1d1f; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,.08); padding: 2rem; max-width: 480px; width: calc(100% - 2rem); text-align: center; }
  h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
  p { color: #6e6e73; margin: 0 0 1rem; line-height: 1.5; }
  code { word-break: break-all; }
  a.button { display: inline-block; background: #007aff; color: #fff; text-decoration: none; padding: .6rem 1.2rem; border-radius: 8px; }
  a.button.danger { background: #ff3b30; }
  .url { word-break: break-all; font-family: ui-monospace, monospace; font-size: .9rem; background: #f5f5f7; padding: .75rem; border-radius: 8px; margin-bottom: 1.25rem; }
  @media (prefers-color-scheme: dark) { body { background: #000; color: #f5f5f7; } .card { background: #1c1c1e; } .url { background: #2c2c2e; } p { color: #a1a1a6; } }
`;

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="card">
${body}
</div>
</body>
</html>`;
}

function notFoundPage() {
  return page("404 Not Found", `<h1>404 Not Found</h1><p>The short link you requested does not exist or has expired.</p>`);
}

function errorPage() {
  return page("Something went wrong", `<h1>Something went wrong</h1><p>The request could not be completed. Please try again later.</p>`);
}

function unsafeUrlPage(destination) {
  const safe = escapeHtml(destination);
  return page(
    "Warning: risky destination",
    `<h1>&#9888; This link looks dangerous</h1>
<p>Google Safe Browsing flagged the destination as malware, phishing or unwanted software. Proceed only if you trust it.</p>
<div class="url">${safe}</div>
<a class="button danger" href="${safe}" rel="noreferrer noopener">Continue anyway</a>`,
  );
}

function captchaChallengePage(cfg) {
  const body = `
<h1>&#128274; Verification required</h1>
<p>Please complete the check below to continue to the link.</p>
<cap-widget id="cap" data-cap-api-endpoint="${escapeHtml(cfg.captcha.api_endpoint.replace(/\/?$/, "/"))}"></cap-widget>
<p id="status" hidden>Verifying and redirecting&hellip;</p>
<script src="${escapeHtml(cfg.captcha.widget_script_url)}"></script>
<script>
  document.getElementById("cap").addEventListener("solve", function (e) {
    document.getElementById("status").hidden = false;
    var next = new URL(window.location.href);
    next.searchParams.set("captcha_token", e.detail.token);
    window.location.replace(next.href);
  });
</script>`;
  return page("Verification required", body);
}

function captchaFailedPage(message, retryPath) {
  return page(
    "Verification failed",
    `<h1>&#10060; Verification failed</h1><p>${escapeHtml(message)}</p><a class="button" href="${escapeHtml(retryPath)}">Try again</a>`,
  );
}

/** Minimal homepage used when neither ASSETS nor HOMEPAGE_URL is configured. */
function fallbackHomepage(cfg) {
  const widget = cfg.captcha.enabled && cfg.captcha.require_on_create
    ? `<cap-widget id="cap" data-cap-api-endpoint="${escapeHtml(cfg.captcha.api_endpoint.replace(/\/?$/, "/"))}"></cap-widget>
<script src="${escapeHtml(cfg.captcha.widget_script_url)}"></script>`
    : "";
  const body = `
<h1>Tyrion URL Shortener</h1>
<form id="f">
  <p><input id="url" type="url" required placeholder="https://example.com/very/long/link" style="width:100%;padding:.6rem;border:1px solid #ccc;border-radius:8px;box-sizing:border-box"></p>
  ${widget}
  <p><button type="submit" style="padding:.6rem 1.2rem;border:0;border-radius:8px;background:#007aff;color:#fff">Shorten</button></p>
</form>
<p id="out"></p>
<script>
  var token = null;
  var cap = document.getElementById("cap");
  if (cap) cap.addEventListener("solve", function (e) { token = e.detail.token; });
  document.getElementById("f").addEventListener("submit", async function (e) {
    e.preventDefault();
    var out = document.getElementById("out");
    out.textContent = "Working...";
    try {
      var res = await fetch("/", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: document.getElementById("url").value, captcha_token: token }) });
      var data = await res.json();
      if (data.status === 200) { out.textContent = ""; var a = document.createElement("a"); a.href = data.key; a.textContent = location.origin + data.key; out.appendChild(a); }
      else { out.textContent = data.error || "Request failed"; if (cap && cap.reset) cap.reset(); token = null; }
    } catch (err) { out.textContent = "Network error"; }
  });
</script>`;
  return page("Tyrion URL Shortener", body);
}

// ---------------------------------------------------------------------------
// External services
// ---------------------------------------------------------------------------

/**
 * Validates a Cap token. Returns { success, degraded, error? }.
 * `fallback` decides what happens when the Cap server cannot be reached.
 */
export async function validateCaptchaToken(token, cfg, { fallback = false, fetchImpl = fetch } = {}) {
  if (!cfg.captcha.enabled) return { success: true, degraded: false };
  if (!token || typeof token !== "string" || token.length < 10 || token.length > 512) {
    return { success: false, degraded: false, error: "Invalid token format" };
  }

  let lastError = null;
  for (let attempt = 0; attempt <= cfg.captcha.max_retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.captcha.timeout);
    try {
      const response = await fetchImpl(`${cfg.captcha.api_endpoint.replace(/\/$/, "")}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Tyrion-Url-Shortener/2.0" },
        body: JSON.stringify({ token, keepToken: false }),
        signal: controller.signal,
      });
      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        return { success: result.success === true, degraded: false, error: result.success === true ? undefined : "Invalid or expired token" };
      }
      if ([400, 401, 403, 404, 409, 410].includes(response.status)) {
        return { success: false, degraded: false, error: "Invalid or expired token" };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error && error.name === "AbortError" ? "Timeout" : String(error && error.message);
    } finally {
      clearTimeout(timer);
    }
    console.error(`CAPTCHA validation attempt ${attempt + 1} failed: ${lastError}`);
    if (attempt < cfg.captcha.max_retries) {
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100));
    }
  }

  if (fallback) {
    console.warn(`CAPTCHA service degraded (${lastError}); allowing operation per fallback policy`);
    return { success: true, degraded: true };
  }
  return { success: false, degraded: false, error: "CAPTCHA service unavailable, please try again later" };
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
  if (!body || typeof body !== "object") {
    return jsonResponse({ status: 400, error: "Request body must be a JSON object" }, 400, cfg);
  }

  const requestUrl = new URL(request.url);
  const check = validateTargetUrl(body.url, { maxLength: cfg.max_url_length, selfHostname: requestUrl.hostname });
  if (!check.ok) return jsonResponse({ status: 400, error: check.error }, 400, cfg);

  if (cfg.captcha.enabled && cfg.captcha.require_on_create) {
    const token = body.captcha_token || body.captchaToken || body.token;
    if (!token) {
      return jsonResponse({ status: 403, error: "CAPTCHA token required", captcha_required: true }, 403, cfg);
    }
    const validation = await validateCaptchaToken(token, cfg, { fallback: cfg.captcha.fallback_on_error_create });
    if (!validation.success) {
      return jsonResponse({ status: 403, error: validation.error || "CAPTCHA verification failed", captcha_required: true }, 403, cfg);
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
    "Content-Security-Policy": captchaCsp(cfg, ["https://cdn.tailwindcss.com"]),
    "Cache-Control": "public, max-age=300",
    ...BASE_SECURITY_HEADERS,
  };

  if (env.ASSETS) {
    const asset = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url), { method: "GET" }));
    if (asset.ok) {
      const res = new Response(asset.body, asset);
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    }
  }

  if (cfg.homepage_url && cfg.homepage_url.startsWith("https://")) {
    try {
      const upstream = await fetch(cfg.homepage_url, { cf: { cacheTtl: 300, cacheEverything: true } });
      if (upstream.ok) {
        return new Response(await upstream.text(), {
          headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
        });
      }
      console.error(`Homepage fetch failed: HTTP ${upstream.status}`);
    } catch (error) {
      console.error(`Homepage fetch failed: ${error && error.message}`);
    }
  }

  return new Response(fallbackHomepage(cfg), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers, "Cache-Control": "no-store" },
  });
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

  if (cfg.captcha.enabled && cfg.captcha.require_on_access) {
    const token = requestUrl.searchParams.get("captcha_token");
    const challengeHeaders = { "Content-Security-Policy": captchaCsp(cfg) };
    if (!token) return htmlResponse(captchaChallengePage(cfg), 403, challengeHeaders);

    const validation = await validateCaptchaToken(token, cfg, { fallback: cfg.captcha.fallback_on_error_access });
    if (!validation.success) {
      const retry = new URL(requestUrl.href);
      retry.searchParams.delete("captcha_token");
      return htmlResponse(captchaFailedPage(validation.error || "CAPTCHA verification failed", retry.pathname + retry.search), 403);
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
  if (url.pathname === "/favicon.ico" || url.pathname === "/robots.txt") {
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
