import type { Profile, Stats } from "../db";
import { isCleanUrl } from "../db";
import { SOURCE_DISABLE_AFTER, type ActivityRow, type SourceRow } from "../activity";
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

const SOURCE_NAMES: Record<string, string> = { github: "GitHub", blog: "Blog", bluesky: "Bluesky", mastodon: "Mastodon" };

/** "today", "yesterday", "3d ago", "2w ago", then "Oct 4" / "Oct 4, 2025". Input is an ISO-8601 UTC timestamp. */
export function relativeDay(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.floor((now - t) / 86400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

function ActivityList({ items }: { items: ActivityRow[] }) {
  return (
    <ul class="act">
      {items.map((it) => (
        <li>
          <time datetime={it.ts} title={it.ts.replace("T", " ").replace("Z", " UTC")}>
            {relativeDay(it.ts)}
          </time>
          <span class="src">{SOURCE_NAMES[it.source] ?? it.source}</span>
          {/* Titles come from other sites: link only http(s) URLs, and nofollow them like every other user-supplied link. */}
          {/^https?:\/\//i.test(it.url) && isCleanUrl(it.url) ? (
            <a href={it.url} rel="nofollow noopener" target="_blank">
              {it.title}
            </a>
          ) : (
            <span>{it.title}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Owner-only: which of the sources found on their GitHub profile feed the activity list. A plain form, no JS needed. */
function SourcesCard({ ctx, sources }: { ctx: Ctx; sources: SourceRow[] }) {
  const toggles = sources.filter((s) => s.source !== "github");
  const github = sources.find((s) => s.source === "github");
  return (
    <div class="card sources" id="sources">
      <h2>Sources</h2>
      <p class="hint">
        Activity comes from what's listed on your GitHub profile: your public GitHub activity, plus your blog, Bluesky or Mastodon if you've added
        them there.
      </p>
      <form method="post" action={`${ctx.base}/edit/sources`} data-autosubmit>
        <div class="src-row static">
          <span class="src-name">
            GitHub <small>{github?.label || `@${ctx.session?.login ?? ""}`}</small>
          </span>
          <span class="src-state">Always on</span>
        </div>
        {toggles.map((s) => {
          const broken = !s.enabled && s.failures >= SOURCE_DISABLE_AFTER;
          return (
            <label class="src-row">
              <span class="src-name">
                {SOURCE_NAMES[s.source] ?? s.source} {s.label && <small>{s.label}</small>}
                {broken && <em>Turned off after repeated failures</em>}
              </span>
              <span class="switch">
                <input type="checkbox" name="on" value={s.source} checked={s.enabled} aria-label={`Include ${SOURCE_NAMES[s.source] ?? s.source}`} />
                <i aria-hidden="true"></i>
              </span>
            </label>
          );
        })}
        {toggles.length === 0 && <p class="hint" style="margin:12px 0 0">No blog, Bluesky or Mastodon found on your GitHub profile yet.</p>}
        {toggles.length > 0 && (
          <div class="actions" style="margin-top:14px">
            <button class="btn btn-sm btn-light" type="submit">
              Save
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

export function ProfilePage({
  ctx,
  p,
  stats,
  isOwner,
  welcome = false,
  cardVersion = null,
  drawVersion = null,
  activity = [],
  sources,
  fetchActivity = false,
}: {
  ctx: Ctx;
  p: Profile;
  stats: Stats;
  isOwner: boolean;
  welcome?: boolean;
  /** Version (hash of the drawn fields) of the stored share card, or null when the profile has no card yet. */
  cardVersion?: string | null;
  /** Set only when the owner's browser should draw and upload a card: the version it will be stamped with. */
  drawVersion?: string | null;
  /** Newest first. The section is left out when empty. */
  activity?: ActivityRow[];
  /** Passed only to the owner: their activity sources, for the on/off card. */
  sources?: SourceRow[];
  /** Owner only: the activity was never fetched, so the page asks POST /edit/refresh for it and swaps it in. */
  fetchActivity?: boolean;
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
    encodeURIComponent(`I'm an MCP server now 🤖\n\nAsk your AI about me — add this to Claude, ChatGPT or Cursor:\n${mcp}`) +
    // The profile page is the last link in the tweet, so X unfurls its share card.
    "&url=" +
    encodeURIComponent(page);
  // Share card (X / Open Graph unfurl image). The URL carries the stored card's version, so each new card gets a new URL.
  const cardUrl = `${page}/card.png?v=${cardVersion ?? "0"}`;
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

            {/* One container, so the fetch script can swap in fresh activity and sources without a reload (welcome bar stays). */}
            <div id="activity-area">
              {fetchActivity && (
                <p class="fetching" id="fetching" role="status">
                  Fetching your activity…
                </p>
              )}
              {activity.length > 0 && (
                <div class="block">
                  <h2>Recent activity</h2>
                  <ActivityList items={activity} />
                </div>
              )}
              {isOwner && sources && (
                <div class="block">
                  <SourcesCard ctx={ctx} sources={sources} />
                </div>
              )}
            </div>

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
      {fetchActivity && (
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){var a=document.getElementById('activity-area');if(!a)return;" +
              "var done=function(){var n=document.getElementById('fetching');if(n)n.remove()};" +
              `fetch(${JSON.stringify(ctx.base + "/edit/refresh")},{method:'POST',credentials:'same-origin'})` +
              ".then(function(r){return r.ok?r.json():null})" +
              ".then(function(j){if(!j||!j.changed){done();return}" +
              "return fetch(location.pathname+location.search,{credentials:'same-origin'}).then(function(r){return r.text()}).then(function(t){" +
              "var d=new DOMParser().parseFromString(t,'text/html').getElementById('activity-area');if(d)a.innerHTML=d.innerHTML;else done()})})" +
              ".catch(done)})();",
          }}
        />
      )}
      {drawVersion && (
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
                post: `${ctx.base}/edit/card?v=${drawVersion}`,
              }),
            }}
          />
          <script dangerouslySetInnerHTML={{ __html: SHARE_CARD_JS }} />
        </>
      )}
    </Layout>
  );
}
