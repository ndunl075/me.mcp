export interface Env {
  DB: D1Database;
  PUBLIC_URL: string;
  GITHUB_REPO_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  DEV_LOGIN?: string;
  // Rate limiting (wrangler.jsonc `ratelimits`). Optional so the Worker still runs where they aren't bound.
  MCP_RATE_LIMIT?: RateLimit;
  WEB_RATE_LIMIT?: RateLimit;
  // Shared secret the Vercel rewrite sets in `x-origin-secret`; lets us trust x-real-ip. Rate limits are enforced only when it is set.
  PROXY_SECRET?: string;
}

export interface Session {
  login: string;
  id: number;
  exp: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { session: Session | null; base: string };
};

/** Base path derived from PUBLIC_URL, e.g. "/me" (or "" when served at the root). */
export function basePathOf(env: Env): string {
  return new URL(env.PUBLIC_URL).pathname.replace(/\/+$/, "");
}

/** Absolute public URL for a path under the app, e.g. url(env, "/nico/mcp"). */
export function url(env: Env, path = ""): string {
  return env.PUBLIC_URL.replace(/\/+$/, "") + path;
}
