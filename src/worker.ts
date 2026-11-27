import { createApp } from "./index";
import { type Env, basePathOf, url } from "./env";
import { rateLimit, withSecurityHeaders } from "./security";

// Worker entry point. Request-wide concerns (headers, rate limits) belong here; routes live in index.tsx.
let cached: { base: string; app: ReturnType<typeof createApp> } | undefined;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const base = basePathOf(env);
    const limited = await rateLimit(req, env, base);
    if (limited) return withSecurityHeaders(limited, env);
    if (!cached || cached.base !== base) cached = { base, app: createApp(base) };
    // Served at the root of a workers.dev URL: send visitors to the app's base path.
    if (base && new URL(req.url).pathname === "/") return withSecurityHeaders(Response.redirect(url(env, "/"), 302), env);
    return withSecurityHeaders(await cached.app.fetch(req, env, ctx), env);
  },
} satisfies ExportedHandler<Env>;
