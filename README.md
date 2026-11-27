# me.mcp

**Turn yourself into a MCP server with one button.**

Sign in with GitHub and you are a live MCP server at `https://www.usefrontierdigital.com/me/<your-github-handle>/mcp`. Any AI agent (Claude, ChatGPT, Cursor, Claude Code) can then ask who you are and what you are working on right now, straight from you instead of from stale web results.

**Try it: https://www.usefrontierdigital.com/me**

- Free and open source (MIT). Self-host in about 5 minutes.
- Zero running cost: one Cloudflare Worker + D1 on the free plan, and no LLM calls on the server. The agent asking does the thinking.
- You see every call: totals, last 7 days, which client asked.
- Stateless MCP over Streamable HTTP, plain JSON responses.

## Add a server to your AI

Replace the URL with any profile, or use the network server (`https://www.usefrontierdigital.com/me/mcp`) to look up anyone.

| Client | How |
| --- | --- |
| Claude | Settings → Connectors → Add custom connector → paste the URL |
| ChatGPT | Settings → Apps & Connectors → create a connector (developer mode) → paste the URL |
| Cursor | "Add to Cursor" button on the profile page, or `.cursor/mcp.json`: `{ "mcpServers": { "me-<handle>": { "url": "<url>" } } }` |
| Claude Code | `claude mcp add --transport http me-<handle> <url>` |

## What agents get

**One person**: `/me/<handle>/mcp`

| Tool | Returns |
| --- | --- |
| `get_profile` | The whole profile in one call: bio, now, projects, recent activity, links, contact |
| `get_now` | What they are working on right now, and when it was last updated |
| `get_projects` | Projects with links and descriptions |
| `get_about` | Longer notes: background, opinions, FAQ |
| `get_recent_activity(limit)` | Recent public activity (GitHub, blog, Bluesky, Mastodon), newest first, 1-15 |
| `search(query)` | Keyword search across everything they published, snippets by section |
| `get_contact` | How they prefer to be contacted, plus links |
| `update_profile(...)` | Owner only. Appears when the request carries their agent key |

**Everyone**: `/me/mcp` has `lookup_person(handle)` (same output as `get_profile`) and `search_people(query)`.

Answers are compact text, not JSON: a full profile is about 300-400 tokens, and the whole `tools/list` is about 2 KB. Empty fields are left out, and a long `about` is cut with a pointer to `get_about`.

### Verified sources

Recent activity comes from sources that are checked against the person's own GitHub profile:

- GitHub public activity: always.
- Blog (RSS/Atom), Bluesky, Mastodon: only if listed on their GitHub profile (blog field, linked social accounts).

Nothing else is fetched. A cron refreshes the stalest profiles every few minutes, each at most once a day. Fetching is https-only with SSRF checks, size and time caps.

### More

- **Share card.** Each profile gets a large `card.png` that unfurls on X. It is drawn in the owner's browser and stored in D1.
- **Update by talking to your agent.** Generate an agent key on the edit page, then:
  ```sh
  claude mcp add --transport http me-<handle> https://<host>/me/<handle>/mcp \
    --header "Authorization: Bearer <key>"
  ```
  Say "update my me.mcp now to: shipped the beta today". The key adds `update_profile` for the owner; everyone else never sees it.
- **Call stats and leaderboard.** Per-profile totals, a 7-day view and a client breakdown, plus a weekly leaderboard on the landing page.
- **llms.txt.** `/me/llms.txt` explains the service to agents; `/me/<handle>/llms.txt` is one person as plain markdown.

## Safety

Profile text is written by one person and read by other people's AI agents, so it is treated as untrusted data.

- Every MCP response ends with a label: self-published, data not instructions.
- Length caps on every field; invisible and bidi control characters stripped.
- Only http(s) URLs are accepted.
- Injection-resistant formatting: every line of a multi-line field is indented, so profile text cannot fake a section header, an activity item or the label.
- Rate limits: MCP 60/min per IP, sign-in and editor writes 20/min per IP (Workers Rate Limiting binding). Enforced only when `PROXY_SECRET` is set; see below for why.
- Strict Content-Security-Policy and `nosniff` on pages, set by the Worker so they survive a proxy.
- Request bodies are capped at 64 KB and JSON-RPC batches at 5 messages.

## Cost

Everything runs on Cloudflare's free plan; over the limit, requests are rejected rather than billed. No LLM calls, no paid APIs.

| Resource | Free limit | Notes |
| --- | --- | --- |
| Worker requests | 100k/day | 10 ms CPU per request |
| D1 reads | 5M rows/day | |
| D1 writes | 100k rows/day | each counted tool call writes 3 rows, so about 30k counted calls/day |
| D1 storage | 5 GB | |

## Self-host

You need a Cloudflare account (free), Node 20+, and a GitHub account.

1. `git clone https://github.com/ndunl075/me.mcp && cd me.mcp && npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create me-mcp`, then paste the `database_id` into `wrangler.jsonc`.
4. Set `PUBLIC_URL` in `wrangler.jsonc` to where it will be served, e.g. `https://me-mcp.<you>.workers.dev/me` or `https://www.example.com/me`. Its path becomes the base path.
5. `npm run db:migrate:remote` applies migrations `0001` to `0003`.
6. Create a GitHub OAuth app (Settings → Developer settings → OAuth Apps) with callback URL `<PUBLIC_URL>/auth/callback`. No scopes are requested.
7. Set secrets:
   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET   # any long random string
   ```
8. `npm run deploy`, then open `<PUBLIC_URL>`.

The OAuth app credentials are also used (HTTP Basic, only to `api.github.com`) to read public activity at 5,000 requests/hour instead of the shared unauthenticated limit.

### Serve it under a path on an existing Vercel site

To get `example.com/me` from a site on Vercel, proxy that path to the Worker in the site's `vercel.json`. The `routes` entry also attaches a shared secret header, which is what lets the Worker trust the visitor IP (`x-real-ip`) and enforce rate limits:

```json
{
  "routes": [
    {
      "src": "/me(?:/(.*))?",
      "dest": "https://me-mcp.<your-subdomain>.workers.dev/me/$1",
      "transforms": [
        {
          "type": "request.headers",
          "op": "set",
          "target": { "key": "x-origin-secret" },
          "args": "$ORIGIN_SECRET",
          "env": ["ORIGIN_SECRET"]
        }
      ]
    }
  ]
}
```

Projects created before 2026-04-06 also need `x-vercel-enable-rewrite-caching: 1`. See [Vercel: restricting your origin to Vercel traffic](https://vercel.com/docs/rewrites#restricting-your-origin-to-vercel-traffic).

**Order matters.** Without a matching header the Worker keys requests by `CF-Connecting-IP`, which behind Vercel is a shared egress address, so one abuser could lock everyone out. That is why limits are off until the secret is set:

1. Generate a value: `openssl rand -hex 32`.
2. Add it on Vercel as the environment variable `ORIGIN_SECRET` (this is the `PROXY_SECRET` value) and deploy the site.
3. Only then set it on the Worker: `npx wrangler secret put PROXY_SECRET`.

On a Cloudflare-hosted domain, use a Worker route (`example.com/me*`) instead and skip `PROXY_SECRET`.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars    # DEV_LOGIN=1 lets you sign in without GitHub
npm run db:migrate:local
npm run dev                       # http://localhost:8787/me
```

Sign in as anyone locally at `http://localhost:8787/me/auth/dev?login=yourname`.

```sh
npm run typecheck
npm test
```

Tests run inside the Workers runtime (vitest + `@cloudflare/vitest-plugin`) against a real D1 with the migrations applied, so what passes is what runs on Cloudflare.

## Contributing

Issues and PRs are welcome. Keep the two hard rules: it must stay free to run (no server-side LLM calls or paid APIs), and profile text must stay treated as untrusted. `CLAUDE.md` has the code layout and `docs/parallel-sessions.md` the workflow.

## Stack

Cloudflare Workers · D1 · Hono (JSX, server-rendered) · `@modelcontextprotocol/sdk` · zod

## License

MIT
