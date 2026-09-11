import { test } from "node:test";
import assert from "node:assert/strict";
import worker, {
  loadConfig,
  validateTargetUrl,
  buildDestination,
  escapeHtml,
  randomKey,
  validateCaptchaToken,
  isUrlSafe,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FakeKV {
  constructor() {
    this.store = new Map();
    this.putOptions = [];
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value, options = {}) {
    this.store.set(key, value);
    this.putOptions.push({ key, options });
  }
}

function makeEnv(overrides = {}) {
  return { LINKS: new FakeKV(), CAPTCHA_ENABLED: "false", ...overrides };
}

function post(body, { path = "/", origin = "https://s.example" } = {}) {
  return new Request(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(path, origin = "https://s.example") {
  return new Request(origin + path, { method: "GET", redirect: "manual" });
}

async function create(env, url) {
  const res = await worker.fetch(post({ url }), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  return data.key.slice(1);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("loadConfig applies defaults and parses env overrides", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.no_ref, true);
  assert.equal(cfg.captcha.require_on_access, false);
  assert.equal(cfg.captcha.fallback_on_error_create, false);

  const custom = loadConfig({
    NO_REF: "off",
    EXPIRATION_TTL: "3600",
    CAPTCHA_REQUIRE_ON_ACCESS: "true",
    CAPTCHA_MAX_RETRIES: "99",
    KEY_LENGTH: "not-a-number",
    SAFE_BROWSING_API_KEY: "abc",
  });
  assert.equal(custom.no_ref, false);
  assert.equal(custom.expiration_ttl, 3600);
  assert.equal(custom.captcha.require_on_access, true);
  assert.equal(custom.captcha.max_retries, 5, "retries are clamped");
  assert.equal(custom.key_length, 6, "bad numbers keep the default");
  assert.equal(custom.safe_browsing_api_key, "abc");
});

test("validateTargetUrl accepts normal http(s) URLs and normalises them", () => {
  assert.deepEqual(validateTargetUrl("https://example.com"), { ok: true, url: "https://example.com/" });
  assert.deepEqual(validateTargetUrl("  http://example.com/a?b=1#c  "), { ok: true, url: "http://example.com/a?b=1#c" });
  assert.equal(validateTargetUrl("https://10.0.0.1/path").ok, true);
  assert.equal(validateTargetUrl("https://en.wikipedia.org/wiki/O'Reilly").ok, true);
  assert.equal(validateTargetUrl("https://a.b/x%22%3E").url, "https://a.b/x%22%3E", "already-encoded input is fine");
});

test("validateTargetUrl rejects everything that is not a plain absolute http(s) URL", () => {
  const bad = [
    undefined,
    null,
    42,
    "",
    "example.com",
    "ftp://example.com/file",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pass@example.com/",
    'https://a.b/x"><script>alert(1)</script>',
    "httpsX https://x.y",
    "https://example.com/a b",
    "https://example.com/\u0000",
    "https://example.com/?q=<b>",
    "https://example.com/`x`",
  ];
  for (const input of bad) {
    assert.equal(validateTargetUrl(input).ok, false, `should reject ${JSON.stringify(input)}`);
  }
});

test("validateTargetUrl enforces max length and blocks self references", () => {
  assert.equal(validateTargetUrl("https://example.com/" + "a".repeat(3000)).ok, false);
  assert.equal(validateTargetUrl("https://example.com/aaaa", { maxLength: 20 }).ok, false);
  assert.equal(validateTargetUrl("https://S.EXAMPLE/abc", { selfHostname: "s.example" }).ok, false);
  assert.equal(validateTargetUrl("https://other.example/abc", { selfHostname: "s.example" }).ok, true);
});

test("buildDestination merges query strings and strips the captcha token", () => {
  const params = new URLSearchParams("a=1&captcha_token=secret&b=x%20y");
  assert.equal(buildDestination("https://t.example/p", params), "https://t.example/p?a=1&b=x+y");
  assert.equal(buildDestination("https://t.example/p?z=9", params), "https://t.example/p?z=9&a=1&b=x+y");
  assert.equal(buildDestination("https://t.example/p?z=9", new URLSearchParams("captcha_token=only")), "https://t.example/p?z=9");
  assert.equal(buildDestination("https://t.example/p", params, { forward: false }), "https://t.example/p");
});

test("escapeHtml neutralises markup", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});

test("randomKey uses the confusable-free charset and requested length", () => {
  for (let i = 0; i < 200; i++) {
    const key = randomKey(6);
    assert.match(key, /^[ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678]{6}$/);
  }
  assert.equal(randomKey(12).length, 12);
});

// ---------------------------------------------------------------------------
// External service wrappers
// ---------------------------------------------------------------------------

test("validateCaptchaToken fails closed on outage unless fallback is allowed", async () => {
  const cfg = loadConfig({ CAPTCHA_MAX_RETRIES: "0", CAPTCHA_TIMEOUT: "500" });
  const down = async () => {
    throw new Error("connect failed");
  };
  const strict = await validateCaptchaToken("0123456789abcdef", cfg, { fallback: false, fetchImpl: down });
  assert.equal(strict.success, false);
  const lenient = await validateCaptchaToken("0123456789abcdef", cfg, { fallback: true, fetchImpl: down });
  assert.deepEqual(lenient, { success: true, degraded: true });
});

test("validateCaptchaToken honours the Cap server verdict and rejects malformed tokens", async () => {
  const cfg = loadConfig({});
  const ok = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  const no = async () => new Response(JSON.stringify({ success: false }), { status: 200 });
  const gone = async () => new Response("", { status: 410 });
  assert.equal((await validateCaptchaToken("0123456789abcdef", cfg, { fetchImpl: ok })).success, true);
  assert.equal((await validateCaptchaToken("0123456789abcdef", cfg, { fetchImpl: no })).success, false);
  assert.equal((await validateCaptchaToken("0123456789abcdef", cfg, { fetchImpl: gone })).success, false);
  assert.equal((await validateCaptchaToken("short", cfg, { fetchImpl: ok })).success, false);
  assert.equal((await validateCaptchaToken(12345, cfg, { fetchImpl: ok })).success, false);
});

test("isUrlSafe reads the matches array and fails open on API errors", async () => {
  const cfg = loadConfig({ SAFE_BROWSING_API_KEY: "k" });
  const flagged = async () => new Response(JSON.stringify({ matches: [{ threatType: "MALWARE" }] }), { status: 200 });
  const clean = async () => new Response("{}", { status: 200 });
  const broken = async () => new Response(JSON.stringify({ error: { code: 400 } }), { status: 400 });
  assert.equal((await isUrlSafe("https://bad.example", cfg, flagged)).safe, false);
  assert.equal((await isUrlSafe("https://good.example", cfg, clean)).safe, true);
  assert.equal((await isUrlSafe("https://good.example", cfg, broken)).safe, true);
  assert.equal((await isUrlSafe("https://good.example", loadConfig({}))).safe, true, "disabled without a key");
});

// ---------------------------------------------------------------------------
// HTTP flow
// ---------------------------------------------------------------------------

test("POST / creates a link and GET /<key> redirects with no-referrer", async () => {
  const env = makeEnv();
  const res = await worker.fetch(post({ url: "https://example.com/page?x=1" }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const data = await res.json();
  assert.match(data.key, /^\/[A-Za-z0-9]{6}$/);
  assert.equal(data.short_url, data.key);
  assert.equal(data.url, "https://s.example" + data.key);

  const hit = await worker.fetch(get(data.key), env);
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get("location"), "https://example.com/page?x=1");
  assert.equal(hit.headers.get("referrer-policy"), "no-referrer");
  assert.equal(hit.headers.get("cache-control"), "no-store");
});

test("query parameters are forwarded and the captcha token is dropped", async () => {
  const env = makeEnv();
  const key = await create(env, "https://example.com/p?a=1");
  const hit = await worker.fetch(get(`/${key}?b=2&captcha_token=zzz`), env);
  assert.equal(hit.headers.get("location"), "https://example.com/p?a=1&b=2");

  const off = makeEnv({ FORWARD_QUERY_PARAMS: "false" });
  const key2 = await create(off, "https://example.com/p?a=1");
  const hit2 = await worker.fetch(get(`/${key2}?b=2`), off);
  assert.equal(hit2.headers.get("location"), "https://example.com/p?a=1");
});

test("no_ref=false redirects without forcing a referrer policy", async () => {
  const env = makeEnv({ NO_REF: "false" });
  const key = await create(env, "https://example.com/");
  const hit = await worker.fetch(get(`/${key}`), env);
  assert.equal(hit.status, 302);
  assert.notEqual(hit.headers.get("referrer-policy"), "no-referrer");
});

test("unique_link reuses the key and stores the hash under a prefix that is never served", async () => {
  const env = makeEnv();
  const k1 = await create(env, "https://example.com/same");
  const k2 = await create(env, "https://example.com/same");
  assert.equal(k1, k2);
  const hashKeys = [...env.LINKS.store.keys()].filter((k) => k.startsWith("hash:"));
  assert.equal(hashKeys.length, 1);
  const res = await worker.fetch(get("/" + hashKeys[0]), env);
  assert.equal(res.status, 404);

  const nonUnique = makeEnv({ UNIQUE_LINK: "false" });
  const a = await create(nonUnique, "https://example.com/same");
  const b = await create(nonUnique, "https://example.com/same");
  assert.notEqual(a, b);
});

test("malicious URLs are rejected at creation and stored values are escaped on output", async () => {
  const env = makeEnv();
  const res = await worker.fetch(post({ url: 'https://a.b/x"><script>alert(1)</script>' }), env);
  assert.equal(res.status, 400);

  // Simulate a value written by an older, unvalidated deployment.
  env.LINKS.store.set("legacy", 'https://a.b/x"><script>alert(1)</script>');
  const hit = await worker.fetch(get("/legacy"), env);
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get("location"), 'https://a.b/x"><script>alert(1)</script>');

  env.LINKS.store.set("junk", "not a url");
  const bad = await worker.fetch(get("/junk"), env);
  assert.equal(bad.status, 404);
});

test("bad request bodies return JSON errors instead of crashing", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(post("{not json"), env)).status, 400);
  assert.equal((await worker.fetch(post("[]"), env)).status, 400);
  assert.equal((await worker.fetch(post({}), env)).status, 400);
  assert.equal((await worker.fetch(post({ url: "javascript:alert(1)" }), env)).status, 400);
  assert.equal((await worker.fetch(post({ url: "https://s.example/abc" }), env)).status, 400, "self reference");
  assert.equal((await worker.fetch(post({ url: "https://x.y" }, { path: "/elsewhere" }), env)).status, 404);
});

test("CAPTCHA is required for creation when enabled", async () => {
  const env = makeEnv({ CAPTCHA_ENABLED: "true" });
  const res = await worker.fetch(post({ url: "https://example.com" }), env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.captcha_required, true);
});

test("CAPTCHA on access shows a challenge page and rejects bad tokens", async () => {
  const env = makeEnv({
    CAPTCHA_ENABLED: "true",
    CAPTCHA_REQUIRE_ON_CREATE: "false",
    CAPTCHA_REQUIRE_ON_ACCESS: "true",
  });
  const key = await create(env, "https://example.com/");
  const challenge = await worker.fetch(get(`/${key}?keep=1`), env);
  assert.equal(challenge.status, 403);
  const html = await challenge.text();
  assert.match(html, /cap-widget/);
  assert.match(challenge.headers.get("content-security-policy"), /worker-src 'self' blob:/);
  assert.match(challenge.headers.get("content-security-policy"), /script-src [^;]*https:\/\/captcha\.gurl\.eu\.org/);

  const bad = await worker.fetch(get(`/${key}?keep=1&captcha_token=short`), env);
  assert.equal(bad.status, 403);
  const badHtml = await bad.text();
  assert.match(badHtml, /Verification failed/);
  assert.match(badHtml, /href="\/[A-Za-z0-9]{6}\?keep=1"/, "retry link keeps the original query");
});

test("rate limiter binding is honoured", async () => {
  const env = makeEnv({ RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const res = await worker.fetch(post({ url: "https://example.com" }), env);
  assert.equal(res.status, 429);
});

test("expiration_ttl is passed to KV when at least 60 seconds", async () => {
  const env = makeEnv({ EXPIRATION_TTL: "86400" });
  await create(env, "https://example.com/ttl");
  assert.ok(env.LINKS.putOptions.every((p) => p.options.expirationTtl === 86400));

  const tooShort = makeEnv({ EXPIRATION_TTL: "5" });
  await create(tooShort, "https://example.com/ttl");
  assert.ok(tooShort.LINKS.putOptions.every((p) => p.options.expirationTtl === undefined));
});

test("unknown keys, odd paths and unsupported methods are handled", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(get("/nope42"), env)).status, 404);
  assert.equal((await worker.fetch(get("/../etc"), env)).status, 404);
  assert.equal((await worker.fetch(get("/a:b"), env)).status, 404);
  const notFound = await worker.fetch(get("/nope42"), env);
  assert.equal(notFound.headers.get("x-content-type-options"), "nosniff");
  assert.match(notFound.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await worker.fetch(new Request("https://s.example/x", { method: "DELETE" }), env)).status, 405);
  const opts = await worker.fetch(new Request("https://s.example/", { method: "OPTIONS" }), env);
  assert.equal(opts.status, 204);
  assert.equal(opts.headers.get("access-control-allow-headers"), "Content-Type");
});

test("homepage is served from ASSETS when bound, otherwise a built-in page", async () => {
  const env = makeEnv({
    ASSETS: { fetch: async () => new Response("<h1>theme</h1>", { headers: { "content-type": "text/html" } }) },
  });
  const res = await worker.fetch(get("/"), env);
  assert.equal(await res.text(), "<h1>theme</h1>");
  assert.match(res.headers.get("content-security-policy"), /cdn\.tailwindcss\.com/);

  const bare = await worker.fetch(get("/"), makeEnv());
  assert.equal(bare.status, 200);
  assert.match(await bare.text(), /Tyrion URL Shortener/);
});

test("missing KV binding and unexpected errors produce a 500 instead of an unhandled exception", async () => {
  assert.equal((await worker.fetch(get("/abc"), {})).status, 500);
  const env = makeEnv();
  env.LINKS.get = async () => {
    throw new Error("kv exploded");
  };
  assert.equal((await worker.fetch(get("/abc123"), env)).status, 500);
  const res = await worker.fetch(post({ url: "https://example.com" }), env);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "Could not store the link, please try again");
});
