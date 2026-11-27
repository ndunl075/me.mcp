import type { Profile, Stats } from "../db";
import { type Ctx, Layout, CopyIcon, XIcon } from "./layout";
import { SHARE_CARD_JS, cardDataJson } from "./sharecard";

function ago(sqlite: string): string {
  const t = Date.parse(sqlite.replace(" ", "T") + "Z");
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} hours ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function ProfilePage({
  ctx,
  p,
  stats,
  isOwner,
  welcome = false,
  cardVersion = null,
}: {
  ctx: Ctx;
  p: Profile;
  stats: Stats;
  isOwner: boolean;
  welcome?: boolean;
  /** updated_at the stored share card was drawn from, or null when the profile has no card yet. */
  cardVersion?: string | null;
}) {
  const page = `${ctx.publicUrl}/${p.handle}`;
  const mcp = `${page}/mcp`;
  const name = p.name || p.handle;
  const cursorLink =
    "cursor://anysphere.cursor-deeplink/mcp/install?name=" +
    encodeURIComponent(`me-${p.handle}`) +
    "&config=" +
    encodeURIComponent(btoa(JSON.stringify({ url: mcp })));
  const tweet =
    "https://x.com/intent/post?text=" +
    encodeURIComponent(`I'm an MCP server now 🤖\n\nAsk your AI about me — add this to Claude, ChatGPT or Cursor:\n${mcp}\n\nMake yours:`) +
    "&url=" +
    encodeURIComponent(ctx.publicUrl + "/");
  // Share card (X / Open Graph unfurl image). Missing or older than the profile: the owner's browser draws and uploads a fresh one.
  const cardUrl = `${page}/card.png?v=${cardVersion ? cardVersion.replace(/\D/g, "") : "0"}`;
  const needsCard = isOwner && p.published && (!cardVersion || cardVersion < p.updated_at);
  const maxClient = Math.max(1, ...stats.clients.map((c) => c.count));

  return (
    <Layout
      ctx={ctx}
      title={`${name} (@${p.handle}) — me.mcp`}
      description={p.headline || `${name} is an MCP server. Add them to your AI.`}
      image={cardUrl}
      imageAlt={`${name} (@${p.handle}) on me.mcp`}
      twitterCard="summary_large_image"
      canonical={page}
      head={<link rel="alternate" type="text/markdown" href={`${page}/llms.txt`} />}
    >
      <div class="wrap page">
        {isOwner && welcome && (
          <div class="owner-bar welcome">
            <div class="wl-head">
              <b>You're live.</b> Anyone can now add you to their AI with this URL:
            </div>
            <div class="wl-url">
              <code>{mcp}</code>
              <button class="btn btn-sm btn-dark" data-copy={mcp} data-toast="Server URL copied">
                <CopyIcon /> Copy
              </button>
            </div>
            <div class="wl-actions">
              <a class="btn btn-sm btn-dark" href={tweet} target="_blank" rel="noopener">
                <XIcon /> Share on X
              </a>
              <a class="btn btn-sm btn-light" href={`${ctx.base}/edit`}>
                Make it better with your AI
              </a>
              <a class="btn btn-sm btn-light" href={`${ctx.base}/edit`}>
                Edit
              </a>
            </div>
            {/* One-time state: drop the flag so a reload shows the normal owner bar. */}
            <script
              dangerouslySetInnerHTML={{
                __html: "try{var u=new URL(location.href);u.searchParams.delete('welcome');history.replaceState(null,'',u.pathname+u.search+u.hash)}catch(e){}",
              }}
            />
          </div>
        )}
        {isOwner && !welcome && (
          <div class="owner-bar">
            {p.published ? <span>✓ Your server is live.</span> : <span>Draft — only you can see this page.</span>}
            <span class="sp"></span>
            <a class="btn btn-sm btn-light" href={`${ctx.base}/edit`}>
              Edit
            </a>
            {p.published && (
              <a class="btn btn-sm btn-dark" href={tweet} target="_blank" rel="noopener">
                <XIcon /> Share on X
              </a>
            )}
          </div>
        )}

        <div class="profile-grid">
          <article>
            <div class="profile-head">
              <img class="avatar avatar-lg" src={p.avatar_url} alt="" />
              <div>
                <h1 class="display">{name}</h1>
                <div class="handle">
                  @{p.handle}
                  {p.location ? ` · ${p.location}` : ""}
                </div>
              </div>
            </div>
            {p.headline && <p class="headline">{p.headline}</p>}

            {p.now && (
              <div class="block">
                <h2>Now</h2>
                <div class="now-card">
                  <div class="prose">{p.now}</div>
                  <div class="when">Updated {ago(p.updated_at)}</div>
                </div>
              </div>
            )}

            {p.bio && (
              <div class="block">
                <h2>Bio</h2>
                <div class="prose">{p.bio}</div>
              </div>
            )}

            {p.projects.length > 0 && (
              <div class="block">
                <h2>Projects</h2>
                {p.projects.map((pr) =>
                  pr.url ? (
                    <a class="proj" href={pr.url} rel="nofollow noopener" target="_blank">
                      <div class="pn">{pr.name} ↗</div>
                      {pr.description && <div class="pd">{pr.description}</div>}
                    </a>
                  ) : (
                    <div class="proj">
                      <div class="pn">{pr.name}</div>
                      {pr.description && <div class="pd">{pr.description}</div>}
                    </div>
                  ),
                )}
              </div>
            )}

            {p.about && (
              <div class="block">
                <h2>About</h2>
                <div class="prose">{p.about}</div>
              </div>
            )}

            {(p.links.length > 0 || p.contact) && (
              <div class="block">
                <h2>Contact & links</h2>
                {p.contact && (
                  <div class="prose" style="margin-bottom:12px">
                    {p.contact}
                  </div>
                )}
                <div class="links">
                  {p.links.map((l) => (
                    <a href={l.url} rel="nofollow noopener me" target="_blank">
                      {l.label}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </article>

          <aside class="install">
            <div class="card">
              <h2>Add {name.split(" ")[0]} to your AI</h2>
              <p class="hint" style="margin:0">Paste this MCP server URL into any MCP client.</p>
              <div class="endpoint">
                <code>{mcp}</code>
                <button class="btn btn-sm btn-dark" data-copy={mcp} data-toast="Server URL copied">
                  <CopyIcon /> Copy
                </button>
              </div>

              <div role="tablist" class="tabs" aria-label="Install instructions">
                <button role="tab" aria-selected="true" aria-controls="t-claude">
                  Claude
                </button>
                <button role="tab" aria-selected="false" aria-controls="t-chatgpt">
                  ChatGPT
                </button>
                <button role="tab" aria-selected="false" aria-controls="t-cursor">
                  Cursor
                </button>
                <button role="tab" aria-selected="false" aria-controls="t-code">
                  Claude Code
                </button>
              </div>
              <div role="tabpanel" id="t-claude" class="tabpanel">
                <ol>
                  <li>Open Claude → Settings → Connectors</li>
                  <li>Add custom connector, paste the URL above</li>
                  <li>Ask: “what is {name.split(" ")[0]} working on?”</li>
                </ol>
              </div>
              <div role="tabpanel" id="t-chatgpt" class="tabpanel" hidden>
                <ol>
                  <li>Open ChatGPT → Settings → Apps &amp; Connectors</li>
                  <li>Create a connector (developer mode), paste the URL above</li>
                  <li>Ask about @{p.handle} in a new chat</li>
                </ol>
              </div>
              <div role="tabpanel" id="t-cursor" class="tabpanel" hidden>
                <a class="btn btn-light" href={cursorLink}>
                  Add to Cursor
                </a>
                <div class="codeblock">
                  {`{ "mcpServers": { "me-${p.handle}": { "url": "${mcp}" } } }`}
                </div>
              </div>
              <div role="tabpanel" id="t-code" class="tabpanel" hidden>
                <div class="codeblock">
                  {`claude mcp add --transport http me-${p.handle} ${mcp}`}
                  <button class="btn btn-sm" data-copy={`claude mcp add --transport http me-${p.handle} ${mcp}`} aria-label="Copy">
                    <CopyIcon />
                  </button>
                </div>
              </div>

              <div class="stats">
                <div class="stat">
                  <b>{stats.week.toLocaleString("en-US")}</b>
                  <span>calls this week</span>
                </div>
                <div class="stat">
                  <b>{stats.total.toLocaleString("en-US")}</b>
                  <span>all time</span>
                </div>
              </div>
              {stats.clients.length > 0 && (
                <div class="bars" aria-label="Calls by client">
                  {stats.clients.slice(0, 5).map((c) => (
                    <div class="bar">
                      <span>{c.client}</span>
                      <span class="track">
                        <i style={`width:${Math.round((c.count / maxClient) * 100)}%`}></i>
                      </span>
                      <span>{c.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
      {needsCard && (
        <>
          <script
            type="application/json"
            id="share-card-data"
            dangerouslySetInnerHTML={{
              __html: cardDataJson({
                handle: p.handle,
                name: p.name,
                headline: p.headline,
                location: p.location,
                now: p.now,
                avatar: p.avatar_url,
                display: page.replace(/^https?:\/\//, ""),
                post: `${ctx.base}/edit/card?v=${encodeURIComponent(p.updated_at)}`,
              }),
            }}
          />
          <script dangerouslySetInnerHTML={{ __html: SHARE_CARD_JS }} />
        </>
      )}
    </Layout>
  );
}
