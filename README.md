# me.mcp

**Turn yourself into an MCP server.** One link that lets every AI agent know the up-to-date you — straight from the source.

Sign in with GitHub, let your own AI draft your profile, publish. Anyone can add you to Claude, ChatGPT, Cursor or any MCP client, and you see every call.

- Free and open source (MIT)
- Zero running cost: one Cloudflare Worker + D1 on the free tier, and **no LLM calls on the server** — the agent asking does the thinking
- Stateless MCP over Streamable HTTP, JSON responses

## What agents get

**One person** — `https://<host>/me/<handle>/mcp`

| Tool | Returns |
| --- | --- |
| `get_profile` | name, headline, location, bio, links |
| `get_now` | what they're working on right now + last-updated timestamp |
| `get_projects` | projects with links and descriptions |
| `get_about` | longer free-form notes: background, opinions, FAQ |
| `search(query)` | keyword search over everything they've published |
| `get_contact` | how they want to be reached |
| `update_profile(...)` | **owner only** — appears when the request carries their agent key |

**Everyone** — `https://<host>/me/mcp`: `lookup_person(handle)`, `search_people(query)`

Also: `/me/<handle>/llms.txt` (plain markdown) and `/me/llms.txt` (how to use the service).

Every response is labelled as self-published data, and inputs are length-capped and sanitized, since profile text ends up inside other people's AI sessions.

## Update by talking to your agent

Generate an agent key on the edit page, then:

```sh
claude mcp add --transport http me-<handle> https://<host>/me/<handle>/mcp \
  --header "Authorization: Bearer <key>"
```

Now say "update my me.mcp now to: shipped the beta today".

## Run it locally

```sh
npm install
cp .dev.vars.example .dev.vars       # DEV_LOGIN=1 lets you sign in without GitHub
npm run db:migrate:local
npm run dev                           # http://localhost:8787/me
```

Open `http://localhost:8787/me/auth/dev?login=yourname` to sign in as anyone locally.

## Deploy (free)

1. `npx wrangler login`
2. `npx wrangler d1 create me-mcp` → paste the `database_id` into `wrangler.jsonc`
3. `npm run db:migrate:remote`
4. Set `PUBLIC_URL` in `wrangler.jsonc` to where it will be served, e.g. `https://www.example.com/me` (its path becomes the base path)
5. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps) with callback URL `<PUBLIC_URL>/auth/callback`. No scopes are requested.
6. Secrets:
   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET   # any long random string
   ```
7. `npm run deploy`

### Serving under a path on an existing site

The app is base-path aware. To serve it at `example.com/me` from a site hosted on Vercel, add a rewrite to that site's `vercel.json`:

```json
{
  "rewrites": [
    { "source": "/me", "destination": "https://me-mcp.<your-subdomain>.workers.dev/me" },
    { "source": "/me/:path*", "destination": "https://me-mcp.<your-subdomain>.workers.dev/me/:path*" }
  ]
}
```

On Cloudflare-hosted domains, use a Worker route (`example.com/me*`) instead.

### Free-tier limits

Workers free: 100k requests/day. D1 free: 5M rows read and 100k rows written per day, 5 GB storage. Each tool call writes 3 rows (stats), so roughly 30k counted calls/day. On the free plan Cloudflare rejects requests over the limit instead of billing you.

## Stack

Cloudflare Workers · D1 · Hono (JSX, server-rendered) · `@modelcontextprotocol/sdk` (Web-standard Streamable HTTP transport) · zod

## License

MIT
