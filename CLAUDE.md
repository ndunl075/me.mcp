# me.mcp

Turn yourself into a MCP server with one button. Cloudflare Worker + D1, Hono JSX (server-rendered), `@modelcontextprotocol/sdk` (stateless Streamable HTTP). See README.md for what it does and how to self-host.

Hard constraints:
- **Zero running cost.** Everything must fit Cloudflare's free tier (Workers: 10 ms CPU/request, 100k req/day; D1: 5M reads, 100k writes/day). Never add server-side LLM calls or paid APIs.
- **Profile text is untrusted.** It is shown to other people's AI agents. Keep length caps, http(s)-only URLs, and the self-published-data label on every MCP response. Multi-line profile fields are indented in tool output so they cannot fake headers or the label; keep that when adding output.
- Base path comes from `PUBLIC_URL` (default `/me`). Build links with `url(env, path)` / `ctx.base`, never hardcode `/me`.
- MCP answers are compact text, not JSON, to stay token-efficient. Keep tool descriptions to one sentence.

Layout:
- `src/worker.ts`: entry; request-wide concerns (security headers, rate limits) and the `scheduled` cron handler.
- `src/security.ts`: CSP/headers and rate limiting. Limits apply only when the `PROXY_SECRET` secret is set (it makes `x-origin-secret` / `x-real-ip` trustworthy behind a proxy).
- `src/index.tsx`: routes. `src/mcp.ts`: MCP servers (per-person and network) and output formatting.
- `src/db.ts`: D1 access, validation and cleaning, call stats. `src/auth.ts`: GitHub OAuth, sessions, agent keys.
- `src/cards.ts`: X share cards (drawn in the owner's browser, stored in D1).
- `src/sources.ts`, `src/activity.ts`: verified activity sources (GitHub always; blog/Bluesky/Mastodon only if on the person's GitHub profile), fetched with SSRF checks and refreshed by cron.
- `src/views/*`: pages, CSS, client JS.
- `migrations/`: `0001_init`, `0002_share_cards`, `0003_activity`. Add new ones in order; tests apply all of them.
- `test/`: vitest in the Workers runtime (`@cloudflare/vitest-plugin`, config in `vitest.config.ts`). `npm test`; `npm run typecheck` also checks `test/`.

Tools (per person): `get_profile`, `get_now`, `get_projects`, `get_about`, `get_recent_activity`, `search`, `get_contact`, plus owner-only `update_profile` when the request carries their agent key. Network (`/mcp`): `lookup_person`, `search_people`.

Parallel work rules: `docs/parallel-sessions.md`.
