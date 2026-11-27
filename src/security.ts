import type { Env } from "./env";
import { corsHeaders } from "./mcp";

// Request-wide security middleware, wired from worker.ts. Kept out of index.tsx so route code stays unaware of it.

// ---- response headers -------------------------------------------------------

// What the pages actually load: inline <style>/<script> (no external scripts), Google Fonts (css + font files),
// GitHub avatars (github.com/<user>.png redirects to avatars.githubusercontent.com), a data: favicon.
// Links can point anywhere; CSP doesn't restrict navigation. 'unsafe-inline' for scripts is needed because the
// page ships one inline <script> (views/client.ts); nothing user-written is rendered as HTML.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Adds security headers on the Worker's own response, so they survive a proxy (e.g. a Vercel rewrite) in front.
 * CSP only on HTML: it means nothing for JSON, and MCP responses keep their CORS headers untouched.
 */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res); // copies: Response.redirect() and fetch() responses have immutable headers
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if ((out.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/html")) {
    out.headers.set("Content-Security-Policy", CSP);
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
  let path = new URL(req.url).pathname;
  if (base && path.startsWith(base)) path = path.slice(base.length);
  path = path.replace(/\/+$/, "") || "/";
  if (MCP_PATH.test(path)) return "mcp";
  // Tighter bucket for sign-in and for anything that writes (POST /edit, /edit/key, /edit/delete). Page views of /edit are free.
  if (AUTH_PATH.test(path) || (req.method === "POST" && EDIT_PATH.test(path))) return "web";
  return null;
}

/** True when the request carries the shared secret that the Vercel rewrite adds (see PROXY_SECRET in README/wrangler). */
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

/**
 * The visitor's IP for rate limiting. Behind the Vercel rewrite CF-Connecting-IP is a Vercel egress address shared by
 * everyone, so there we use x-real-ip (Vercel overwrites it with the visitor's IP). Those headers are trusted only when
 * the proxy secret matches; direct hits on the workers.dev URL fall back to CF-Connecting-IP, which can't be spoofed.
 */
export function clientIp(req: Request, env: Env): string {
  if (cameThroughProxy(req, env)) {
    const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0];
    if (ip?.trim()) return ip.trim();
  }
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Returns a 429 response when the caller is over its limit, otherwise null. Fails open if the binding is missing or errors. */
export async function rateLimit(req: Request, env: Env, base: string): Promise<Response | null> {
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
