# me.mcp

Turn yourself into an MCP server. Cloudflare Worker + D1, Hono JSX (server-rendered), `@modelcontextprotocol/sdk` (stateless Streamable HTTP). See README.md for what it does.

Hard constraints:
- **Zero running cost.** Everything must fit Cloudflare's free tier (Workers: 10 ms CPU/request, 100k req/day; D1: 5M reads, 100k writes/day). Never add server-side LLM calls or paid APIs.
- **Profile text is untrusted.** It is shown to other people's AI agents. Keep length caps, http(s)-only URLs, and the self-published-data label on every MCP response.
- Base path comes from `PUBLIC_URL` (default `/me`). Build links with `url(env, path)` / `ctx.base`, never hardcode `/me`.

Layout: `src/worker.ts` (entry: request-wide concerns), `src/index.tsx` (routes), `src/mcp.ts` (MCP servers), `src/db.ts` (D1 + validation), `src/auth.ts` (GitHub OAuth, sessions), `src/views/*` (pages, CSS, client JS).

Parallel work rules: `docs/parallel-sessions.md`.
