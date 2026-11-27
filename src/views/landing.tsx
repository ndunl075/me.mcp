import type { LeaderRow } from "../db";
import { type Ctx, Layout, GithubIcon, CopyIcon, XIcon } from "./layout";

const GRADS = ["grad-1", "grad-2", "grad-3"];

export function Landing({ ctx, top, fresh }: { ctx: Ctx; top: LeaderRow[]; fresh: LeaderRow[] }) {
  const b = ctx.base;
  const host = ctx.publicUrl.replace(/^https?:\/\//, "");
  const start = ctx.session ? `${b}/edit` : `${b}/auth/github`;
  const example = top[0]?.handle ?? fresh[0]?.handle;

  // Hero chip: signed in → your own avatar + handle. Otherwise → real people who just joined, cycling.
  const me = ctx.session?.login;
  const recent = fresh.slice(0, 3);
  const chipHandles = me ? [`@${me}`] : ["@you", ...recent.filter((p) => p.handle.length <= 12).map((p) => `@${p.handle}`)];

  return (
    <Layout
      ctx={ctx}
      title="me.mcp: turn yourself into an MCP server"
      description="One link that lets every AI agent know the up-to-date you. Free and open source."
      canonical={ctx.publicUrl + "/"}
    >
      <section class="hero wrap">
        <h1 class="display">
          <span class="row">
            <span>Turn</span>
            <span class="chip chip-avatars" aria-hidden="true">
              {me ? (
                <img src={`https://github.com/${me}.png?size=96`} alt="" />
              ) : (
                [0, 1, 2].map((i) =>
                  recent[i] ? <img src={recent[i].avatar_url} alt="" /> : <i class={GRADS[i]}></i>,
                )
              )}
              <span class="at" data-cycle={JSON.stringify(chipHandles)}>
                {chipHandles[0]}
              </span>
            </span>
            <span>yourself</span>
          </span>
          <span class="row">
            <span>into an MCP</span>
            <span class="chip chip-tool" aria-hidden="true">
              <span class="t1">get_now()</span>
              <span class="t2">✓ 200 OK</span>
            </span>
            <span>server</span>
          </span>
        </h1>

        <p class="sub">One link that lets every AI agent know the up-to-date you, straight from the source.</p>

        <div class="ctas">
          <a class="btn btn-dark btn-lg" href={start}>
            <GithubIcon size={22} /> {ctx.session ? "Edit your server" : "Create my MCP server"}
          </a>
          {example && (
            <a class="btn btn-light btn-lg" href={`${b}/${example}`}>
              See a live server
            </a>
          )}
        </div>
        {!ctx.session && <p class="consent">Uses your public GitHub profile. Edit or delete anytime.</p>}
      </section>

      {/* ---------- demo: an agent calling someone's server ---------- */}
      <div class="stage">
        <div class="stage-bg">
          <div class="window">
            <div class="window-bar">
              <div class="dots">
                <i></i>
                <i></i>
                <i></i>
              </div>
              <div class="urlbar">your AI agent · connected to {host}/ada/mcp</div>
            </div>
            <div class="window-body">
              <div class="chat">
                <div class="msg-user">what's @ada working on this week? she DM'd me about a collab</div>
                <div class="toolcall">
                  <div class="toolcall-h">
                    <span class="srv">me.mcp/ada ›</span>
                    <span class="fn">get_now</span>
                    <span class="ok">200</span>
                  </div>
                  <pre>
                    {"{\n  "}
                    <span class="k">"now"</span>
                    {": "}
                    <span class="s">"Shipping v2 of Lattice (local-first notes). Looking for a design partner for the sync engine."</span>
                    {",\n  "}
                    <span class="k">"last_updated"</span>
                    {": "}
                    <span class="s">"2 hours ago"</span>
                    {"\n}"}
                  </pre>
                </div>
                <div class="msg-ai">
                  <b>Ada</b> is shipping <b>v2 of Lattice</b>, her local-first notes app, and she's looking for a{" "}
                  <b>design partner for the sync engine</b>, so the collab is probably about that. This is from her own
                  server, updated 2 hours ago. Want me to check how she prefers to be contacted?
                </div>
              </div>
              <div class="side">
                <AdaCard />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---------- visual 1: how it connects ---------- */}
      <section class="section wrap">
        <div class="section-head">
          <h2 class="display">You write it once. Every AI can read it.</h2>
          <p>Your profile becomes a live MCP server at one link. Any assistant that supports MCP can call it.</p>
        </div>
        <div class="flow">
          <div class="flow-col">
            <div class="flow-card">
              <div class="who">
                <div class="avatar grad-1 avatar-sm">A</div>
                <div>
                  <div class="nm">Ada Lin</div>
                  <div class="hd">@ada</div>
                </div>
              </div>
              <div class="kv">
                <span>Now</span>Shipping Lattice v2
              </div>
              <div class="kv">
                <span>Projects</span>Lattice, TinySync
              </div>
              <div class="kv">
                <span>Contact</span>DM on X
              </div>
            </div>
            <div class="flow-cap">
              <b>1. Your profile</b>
              <span>What you're doing now, projects, how to reach you</span>
            </div>
          </div>

          <div class="flow-wire" aria-hidden="true">
            <i></i>
          </div>

          <div class="flow-col">
            <div class="flow-server">
              <div class="srv-url">{host}/ada/mcp</div>
              <div class="srv-tools">
                {["get_profile", "get_now", "get_projects", "search", "get_contact"].map((t) => (
                  <code>{t}</code>
                ))}
              </div>
              <div class="srv-live">
                <i></i> live
              </div>
            </div>
            <div class="flow-cap">
              <b>2. Your MCP server</b>
              <span>One link. Updates the moment you do.</span>
            </div>
          </div>

          <div class="flow-wire" aria-hidden="true">
            <i></i>
          </div>

          <div class="flow-col">
            <div class="flow-clients">
              {[
                ["Claude", "get_now"],
                ["ChatGPT", "get_profile"],
                ["Cursor", "search"],
              ].map(([c, t]) => (
                <div class="client">
                  <span class="cn">{c}</span>
                  <span class="ct">
                    {t} <em>✓</em>
                  </span>
                </div>
              ))}
            </div>
            <div class="flow-cap">
              <b>3. Anyone's AI</b>
              <span>Asks about you and gets the real answer</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- visual 2: without vs with ---------- */}
      <section class="section wrap">
        <div class="section-head">
          <h2 class="display">Stop letting AI guess who you are</h2>
          <p>Same question, same AI. The difference is whether it can ask you.</p>
        </div>
        <div class="versus">
          <div class="vs-card vs-bad">
            <div class="vs-label">
              <span class="vs-x">✕</span> Without me.mcp
            </div>
            <div class="msg-user">what's @ada working on right now?</div>
            <div class="vs-ai">
              I don't have current information about @ada. Based on older data, she may have worked at a sync startup
              around 2023. I'd suggest checking her social profiles for anything recent.
            </div>
            <div class="vs-foot">Stale training data · no date · a guess</div>
          </div>
          <div class="vs-card vs-good">
            <div class="vs-label">
              <span class="vs-check">✓</span> With me.mcp
            </div>
            <div class="msg-user">what's @ada working on right now?</div>
            <div class="vs-tool">
              <span class="mono">me.mcp/ada › get_now</span>
              <span class="ok">200</span>
            </div>
            <div class="vs-ai">
              She's <b>shipping Lattice v2</b> and looking for a <b>design partner for the sync engine</b>. She prefers a
              DM on X.
            </div>
            <div class="vs-foot">From Ada herself · updated 2 hours ago</div>
          </div>
        </div>
      </section>

      {/* ---------- visual 3: setup steps as mini UI ---------- */}
      <section class="section wrap" id="how">
        <div class="section-head">
          <h2 class="display">An MCP server in about a minute</h2>
          <p>No code, no hosting, no API keys. Your own AI does the writing.</p>
        </div>
        <div class="steps">
          <div class="step">
            <span class="n">01</span>
            <h3>Sign in with GitHub</h3>
            <p>Your handle is your GitHub username. We pull your bio, links and top repos to start you off.</p>
            <div class="demo">
              <div class="ui-btn dark">
                <GithubIcon size={14} /> Continue with GitHub
              </div>
              <div class="ui-list">
                <div>
                  <em>✓</em> Bio
                </div>
                <div>
                  <em>✓</em> 3 links
                </div>
                <div>
                  <em>✓</em> 5 repos
                </div>
              </div>
            </div>
          </div>
          <div class="step">
            <span class="n">02</span>
            <h3>Let your AI write it</h3>
            <p>One click opens ChatGPT or Claude with a ready-made prompt. It interviews you, you paste the result back.</p>
            <div class="demo">
              <div class="ui-row">
                <div class="ui-btn">Open in ChatGPT</div>
                <div class="ui-btn">Open in Claude</div>
              </div>
              <div class="ui-paste">
                <span class="mono">{'{ "now": "Shipping Lattice v2…" }'}</span>
              </div>
              <div class="ui-ok">✓ Filled 9 fields</div>
            </div>
          </div>
          <div class="step">
            <span class="n">03</span>
            <h3>Share one link</h3>
            <p>Put it in your bio. Anyone can add you to their AI in one click, and you see every call.</p>
            <div class="demo">
              <div class="ui-url">
                <span class="mono">{host}/you/mcp</span>
                <CopyIcon />
              </div>
              <div class="ui-row">
                <div class="ui-btn dark">
                  <XIcon /> Share on X
                </div>
                <div class="ui-stat">
                  <b>214</b> calls this week
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="section wrap">
        <div class="feature-grid">
          <div class="feature">
            <h3>Update by talking</h3>
            <p>
              Generate a private key and your own agent gets an <code>update_profile</code> tool. Say “set my now to:
              shipped the beta” and it's live.
            </p>
          </div>
          <div class="feature">
            <h3>Free, open source, self-hostable</h3>
            <p>
              No AI runs on our side. The agent asking does the thinking. It runs on Cloudflare's free tier, and you can
              host your own.
            </p>
          </div>
        </div>
      </section>

      <section class="section wrap" id="people">
        <div class="section-head">
          <h2 class="display">Most-called this week</h2>
        </div>
        {top.length ? (
          <div class="people">
            {top.map((p, i) => (
              <PersonRow ctx={ctx} p={p} rank={i + 1} />
            ))}
          </div>
        ) : (
          <div class="empty">No calls yet this week. Be the first server on the board.</div>
        )}
        {fresh.length > 0 && (
          <>
            <h3 style="margin:40px 0 14px;font-size:15px;color:var(--muted);font-weight:500">Just joined</h3>
            <div class="people">
              {fresh.map((p) => (
                <PersonRow ctx={ctx} p={p} />
              ))}
            </div>
          </>
        )}
      </section>

      <section class="section wrap" id="agents">
        <div class="section-head">
          <h2 class="display">Add everyone at once</h2>
          <p>One network server looks up anyone on me.mcp by handle, or add a single person's server directly.</p>
        </div>
        <div class="feature-grid">
          <div class="feature">
            <h3>Network server</h3>
            <p>
              Tools: <code>lookup_person</code>, <code>search_people</code>
            </p>
            <div class="codeblock">
              {ctx.publicUrl}/mcp
              <button class="btn btn-sm" data-copy={`${ctx.publicUrl}/mcp`} aria-label="Copy">
                <CopyIcon />
              </button>
            </div>
          </div>
          <div class="feature">
            <h3>One person</h3>
            <p>
              Tools: <code>get_profile</code>, <code>get_now</code>, <code>get_projects</code>, <code>get_about</code>,{" "}
              <code>search</code>, <code>get_contact</code>
            </p>
            <div class="codeblock">{ctx.publicUrl}/&lt;handle&gt;/mcp</div>
          </div>
        </div>
      </section>

      <div class="wrap">
        <div class="cta-band">
          <h2 class="display">Become an MCP server</h2>
          <p>Takes about a minute. Costs nothing. Ever.</p>
          <a class="btn btn-light btn-lg" href={start}>
            <GithubIcon size={22} /> {ctx.session ? "Edit your server" : "Create my MCP server"}
          </a>
        </div>
      </div>
    </Layout>
  );
}

function AdaCard() {
  return (
    <div class="pcard">
      <div class="who">
        <div class="avatar grad-1" style="display:grid;place-items:center;color:#fff;font-weight:600">
          A
        </div>
        <div>
          <h3>Ada Lin</h3>
          <div class="handle">@ada · Lisbon</div>
        </div>
      </div>
      <div class="label">Now</div>
      <p>Shipping v2 of Lattice. Looking for a sync-engine design partner.</p>
      <div class="label">Tools agents can call</div>
      <div class="tools">
        {["get_profile", "get_now", "get_projects", "get_about", "search", "get_contact"].map((t) => (
          <code>{t}</code>
        ))}
      </div>
      <div class="label">This week</div>
      <p>
        <b style="font-family:var(--display);font-weight:400;font-size:22px">214</b> calls from agents
      </p>
    </div>
  );
}

function PersonRow({ ctx, p, rank }: { ctx: Ctx; p: LeaderRow; rank?: number }) {
  return (
    <a class="person" href={`${ctx.base}/${p.handle}`}>
      {rank !== undefined && <span class="rank">{rank}</span>}
      <img class="avatar" src={p.avatar_url} alt="" loading="lazy" />
      <div class="meta">
        <div class="nm">{p.name || p.handle}</div>
        <div class="hl">
          @{p.handle}
          {p.headline ? ` · ${p.headline}` : ""}
        </div>
      </div>
      {rank !== undefined && <span class="calls">{p.week} calls</span>}
    </a>
  );
}
