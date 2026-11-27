import { createApp } from "./index";
import { type Env, basePathOf, url } from "./env";

// Worker entry point. Request-wide concerns (headers, rate limits) belong here; routes live in index.tsx.
let cached: { base: string; app: ReturnType<typeof createApp> } | undefined;

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const base = basePathOf(env);
    if (!cached || cached.base !== base) cached = { base, app: createApp(base) };
    // Served at the root of a workers.dev URL: send visitors to the app's base path.
    if (base && new URL(req.url).pathname === "/") return Response.redirect(url(env, "/"), 302);
    return cached.app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
