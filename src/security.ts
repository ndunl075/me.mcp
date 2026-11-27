import { getPath } from "hono/utils/url";
import type { Env } from "./env";
import { corsHeaders } from "./mcp";

// Request-wide security middleware, wired from worker.ts. Kept out of index.tsx so route code stays unaware of it.

// ---- response headers -------------------------------------------------------

// What the pages actually load: inline <style>/<script> (no external scripts), Google Fonts (css + font files),
// GitHub avatars (github.com/<user>.png redirects to avatars.githubusercontent.com), a data: favicon.
// Links can point anywhere; CSP doesn't restrict navigation. 'unsafe-inline' for scripts is needed because pages ship
// inline <script>s (views/client.ts, the welcome-flag cleanup) and an inline onsubmit; nothing user-written is rendered as HTML.
// form-action also lists PUBLIC_URL's origin and github.com: Chrome applies it to the whole redirect chain of a form POST,
// and an expired session on POST /edit redirects to /auth/github, which redirects on to github.com.
const cspCache = new Map<string, string>();
function csp(env: Env): string {
  const origin = new URL(env.PUBLIC_URL).origin;
  let v = cspCache.get(origin);
  if (!v) {
    v = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      `form-action 'self' ${origin} https://github.com`,
      "frame-ancestors 'none'",
    ].join("; ");
    cspCache.set(origin, v);
  }
  return v;
}

/**
 * Adds security headers on the Worker's own response, so they survive a proxy (e.g. a Vercel rewrite) in front.
 * CSP only on HTML: it means nothing for JSON, and MCP responses keep their CORS headers untouched.
 */
export function withSecurityHeaders(res: Response, env: Env): Response {
  const out = new Response(res.body, res); // copies: Response.redirect() and fetch() responses have immutable headers
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if ((out.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/html")) {
    out.headers.set("Content-Security-Policy", csp(env));
  }
  return out;
}

// ---- rate limiting ------------------------------------------------------------
// Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc): local to a Cloudflare location and approximate,
// which is fine for abuse control. It protects the free-plan budgets (each counted MCP call writes 3 D1 rows).

const MCP_PATH = /^\/(?:[^/]+\/)?mcp$/i; // /mcp and /<handle>/mcp, relative to the base path
const AUTH_PATH = /^\/auth(?:\/|$)/i;
const EDIT_PATH = /^\/edit(?:\/|$)/i;

type Kind = "mcp" | "web";

function classify(req: Request, base: string): Kind | null {
  if (req.method === "OPTIONS") return null; // CORS preflight: cheap, and must not eat the budget
  // Classify the path the router will see: Hono decodes %XX before matching, so /me/%6Dcp is the MCP endpoint.
  // Its own getPath is used so the two can't disagree. (It never throws: bad escapes are skipped.)
  let path = getPath(req);
  if (base && path.startsWith(base)) path = path.slice(base.length);
  path = path.replace(/\/+$/, "") || "/";
  if (MCP_PATH.test(path)) return "mcp";
  // Tighter bucket for sign-in and for anything that writes (POST /edit, /edit/key, /edit/delete). Page views of /edit are free.
  if (AUTH_PATH.test(path) || (req.method === "POST" && EDIT_PATH.test(path))) return "web";
  return null;
}

/** True when the request carries the shared secret that the Vercel rewrite adds (see PROXY_SECRET in wrangler.jsonc). */
function cameThroughProxy(req: Request, env: Env): boolean {
  const secret = env.PROXY_SECRET;
  const got = req.headers.get("x-origin-secret");
  if (!secret || !got) return false;
  const enc = new TextEncoder();
  const a = enc.encode(secret);
  const b = enc.encode(got);
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i]; // constant-time over equal lengths
  return diff === 0;
}

/** "1.2.3.4" as two hex groups ("102", "304"), or null if it is not a plain dotted quad. */
function quadToGroups(q: string): [string, string] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(q);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
}

/**
 * IPv6 clients control a whole /64, so they are keyed by it. IPv4-mapped (::ffff:a.b.c.d or ::ffff:102:304), the
 * deprecated IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and SIIT (::ffff:0:a.b.c.d) forms are keyed as the embedded IPv4 address, so they share a bucket with the
 * same client's plain IPv4 and don't all collapse into 0:0:0:0::/64. IPv4 and anything unparseable are used as-is.
 */
export function ipKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  let addr = ip.toLowerCase();
  if (addr.includes(".")) {
    const at = addr.lastIndexOf(":");
    const g = quadToGroups(addr.slice(at + 1));
    if (!g) return ip;
    addr = `${addr.slice(0, at + 1)}${g[0]}:${g[1]}`;
  }
  const [head, tail, extra] = addr.split("::");
  if (extra !== undefined) return ip;
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  const n = groups.map((g) => parseInt(g, 16));
  const zeros5 = n.slice(0, 5).every((v) => v === 0);
  const embedded =
    (zeros5 && (n[5] === 0xffff || (n[5] === 0 && n[6] !== 0))) || // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible)
    (n[0] === 0x64 && n[1] === 0xff9b && n.slice(2, 6).every((v) => v === 0)) || // 64:ff9b::a.b.c.d (NAT64)
    (n.slice(0, 4).every((v) => v === 0) && n[4] === 0xffff && n[5] === 0); // ::ffff:0:a.b.c.d (SIIT)
  if (embedded) return `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
  return n.slice(0, 4).map((v) => v.toString(16)).join(":") + "::/64";
}

/**
 * The visitor's IP for rate limiting. Behind the Vercel rewrite CF-Connecting-IP is a Vercel egress address shared by
 * everyone, so there we use x-real-ip (Vercel overwrites it with the visitor's IP; x-forwarded-for is not used because
 * a client can control its first entry). x-real-ip is trusted only when the proxy secret matches; direct hits on the
 * workers.dev URL fall back to CF-Connecting-IP, which can't be spoofed.
 */
export function clientIp(req: Request, env: Env): string {
  const real = cameThroughProxy(req, env) ? req.headers.get("x-real-ip")?.trim() : "";
  return ipKey(real || req.headers.get("cf-connecting-ip") || "unknown");
}

/**
 * Returns a 429 response when the caller is over its limit, otherwise null. Fails open if the binding is missing or errors.
 * Enforced only when PROXY_SECRET is set: without it, behind the Vercel rewrite every visitor would share one egress IP
 * and a single abuser could lock everyone out. Set PROXY_SECRET together with the Vercel header transform (README).
 */
export async function rateLimit(req: Request, env: Env, base: string): Promise<Response | null> {
  if (!env.PROXY_SECRET) return null;
  const kind = classify(req, base);
  if (!kind) return null;
  const limiter = kind === "mcp" ? env.MCP_RATE_LIMIT : env.WEB_RATE_LIMIT;
  if (!limiter) return null;
  try {
    const { success } = await limiter.limit({ key: clientIp(req, env) });
    if (success) return null;
  } catch {
    return null;
  }
  const retry = { "Retry-After": "60", "Cache-Control": "no-store" };
  if (kind === "mcp") {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32029, message: "Rate limit exceeded. Retry in about a minute." }, id: null }),
      { status: 429, headers: { "Content-Type": "application/json", ...retry, ...corsHeaders() } },
    );
  }
  return new Response("Too many requests. Please wait a minute and try again.", {
    status: 429,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...retry },
  });
}
