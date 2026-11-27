import type { CustomSourceRow } from "../activity";
import { type Profile, LIMITS, formatLinks, formatProjects } from "../db";
import { type Ctx, Layout, CopyIcon } from "./layout";
import { SourceForms } from "./source-form";

export function aiPrompt(p: Profile): string {
  const known = [
    p.name && `Name: ${p.name}`,
    p.headline && `Headline: ${p.headline}`,
    p.location && `Location: ${p.location}`,
    p.bio && `Bio: ${p.bio}`,
    p.links.length && `Links: ${p.links.map((l) => `${l.label} ${l.url}`).join(", ")}`,
    p.projects.length && `GitHub projects: ${p.projects.map((r) => `${r.name}${r.description ? ` (${r.description})` : ""}`).join("; ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `Help me write my me.mcp profile. It becomes an MCP server that AI agents read to learn about me, so it should be specific, current and in my own voice.

What I have so far (from GitHub):
${known || "(nothing yet)"}

First, ask me up to 6 short questions in ONE message (what I'm working on right now, what I want people to reach out about, background, opinions, how to contact me). If you already know me from earlier chats, use that too.

Then reply with ONLY a JSON object, no commentary:
{
  "name": "",
  "headline": "one line, max ${LIMITS.headline} chars",
  "location": "",
  "bio": "2-4 sentences, first person",
  "now": "what I'm working on / focused on right now, 1-3 sentences, first person",
  "about": "longer notes in first person: background, what I'm good at, opinions, FAQ, what I'm looking for. Short paragraphs. Max ${LIMITS.about} chars",
  "contact": "how I prefer to be contacted",
  "links": [{ "label": "", "url": "https://..." }],
  "projects": [{ "name": "", "url": "https://...", "description": "one line" }]
}

Keep it plain and specific. No hype, no emojis, nothing I didn't tell you.`;
}

export function EditorPage({
  ctx,
  p,
  notice,
  newKey,
  custom = [],
}: {
  ctx: Ctx;
  p: Profile;
  notice?: { kind: "ok" | "err" | "info"; text: string };
  newKey?: string;
  custom?: CustomSourceRow[];
}) {
  const b = ctx.base;
  const prompt = aiPrompt(p);
  const chatgpt = "https://chatgpt.com/?q=" + encodeURIComponent(prompt);
  const claude = "https://claude.ai/new?q=" + encodeURIComponent(prompt);
  const mcp = `${ctx.publicUrl}/${p.handle}/mcp`;
  const first = !p.published && !p.now && !p.about;

  return (
    <Layout ctx={ctx} title="Edit your server — me.mcp" description="Edit your me.mcp profile.">
      <div class="narrow page">
        <h1 class="display">{p.published ? "Make it better" : "Your server is offline"}</h1>
        <p class="lede">
          {p.published ? "You're live at " : "Publish to go live again at "}
          <a href={`${b}/${p.handle}`} style="text-decoration:underline">
            {ctx.publicUrl.replace(/^https?:\/\//, "")}/{p.handle}
          </a>
          {p.published
            ? ". Everything is optional: add a headline, what you're up to now, and more, so agents can answer better."
            : ". Everything here is public once you publish."}
        </p>

        <div style="height:28px"></div>
        {notice && <div class={`notice ${notice.kind}`}>{notice.text}</div>}

        {newKey && (
          <div class="card" style="border-color:#1c1c1c">
            <h2>Your agent key — copy it now</h2>
            <p class="hint">
              It's shown once. Anyone with it can edit your profile. Add it to an agent that supports headers, and that agent
              gets an <code>update_profile</code> tool.
            </p>
            <div class="codeblock">
              {`claude mcp add --transport http me-${p.handle} ${mcp} --header "Authorization: Bearer ${newKey}"`}
              <button
                class="btn btn-sm"
                data-copy={`claude mcp add --transport http me-${p.handle} ${mcp} --header "Authorization: Bearer ${newKey}"`}
                aria-label="Copy"
              >
                <CopyIcon />
              </button>
            </div>
            <p class="hint" style="margin:12px 0 0">
              Then just say: “update my me.mcp now to: shipped the beta today”.
            </p>
          </div>
        )}

        <details class="card ai" open={first || (p.published && !p.about)}>
          <summary>
            <h2>✨ Draft it with your AI</h2>
            <p class="hint" style="margin:0">
              Free — your own ChatGPT or Claude interviews you and writes the profile. Paste the result back here.
            </p>
          </summary>
          <div class="ai-box" style="margin-top:16px">
            <div class="actions" style="margin-top:0">
              <a class="btn btn-dark" href={chatgpt} target="_blank" rel="noopener">
                Open in ChatGPT
              </a>
              <a class="btn btn-dark" href={claude} target="_blank" rel="noopener">
                Open in Claude
              </a>
              <button class="btn btn-light" type="button" data-copy={prompt} data-toast="Prompt copied — paste it into any AI">
                <CopyIcon /> Copy prompt
              </button>
            </div>
            <label class="field">
              <span>Paste what your AI gave you</span>
              <textarea id="ai-paste" class="code" placeholder='{ "name": "...", "headline": "...", ... }'></textarea>
            </label>
            <div class="actions">
              <button class="btn btn-light" type="button" id="ai-fill">
                Fill the form
              </button>
            </div>
          </div>
        </details>

        <form id="profile-form" method="post" action={`${b}/edit`} class="card" style="margin-top:16px">
          <h2>Your profile</h2>
          <p class="hint">This is exactly what agents get back when they call your tools.</p>

          <div class="row2">
            <Field label="Name" name="name" value={p.name} max={LIMITS.name} />
            <Field label="Location" name="location" value={p.location} max={LIMITS.location} />
          </div>
          <Field label="Headline" name="headline" value={p.headline} max={LIMITS.headline} hint="One line. Shown everywhere." />
          <Area label="Now" name="now" value={p.now} max={LIMITS.now} hint="What you're working on right now → get_now" />
          <Area label="Bio" name="bio" value={p.bio} max={LIMITS.bio} />
          <Area
            label="Projects"
            name="projects"
            value={formatProjects(p.projects)}
            hint="One per line: Name | https://url | description"
            code
          />
          <Area label="Links" name="links" value={formatLinks(p.links)} hint="One per line: Label | https://url" code />
          <Area
            label="About"
            name="about"
            value={p.about}
            max={LIMITS.about}
            tall
            hint="Background, opinions, FAQ, what you're looking for → get_about + search"
          />
          <Area label="Contact" name="contact" value={p.contact} max={LIMITS.contact} hint="How should people reach you? → get_contact" />

          <div class="sticky-actions">
            <button class="btn btn-light" name="action" value="save" type="submit">
              {p.published ? "Save" : "Save draft"}
            </button>
            <button class="btn btn-dark" name="action" value="publish" type="submit">
              {p.published ? "Save & keep live" : "Publish my server"}
            </button>
          </div>
        </form>

        <div class="card sources" style="margin-top:16px" id="sources">
          <h2>Add a source</h2>
          <p class="hint">A feed, your site, Hacker News, dev.to or npm. Up to 6.</p>
          <SourceForms base={b} back="edit" sources={custom} />
        </div>

        <div class="card" style="margin-top:16px">
          <h2>Agent key</h2>
          <p class="hint">
            Let your own agent update your profile by talking to it. {p.has_key ? "You have a key. Generating a new one revokes the old one." : ""}
          </p>
          <form method="post" action={`${b}/edit/key`}>
            <button class="btn btn-light" type="submit">
              {p.has_key ? "Regenerate key" : "Generate key"}
            </button>
          </form>
        </div>

        <div class="card" style="margin-top:16px">
          <h2>Danger zone</h2>
          <p class="hint">Unpublishing hides your page and server. Deleting removes everything, including stats.</p>
          <div class="actions" style="margin-top:0">
            {p.published && (
              <form method="post" action={`${b}/edit`}>
                <button class="btn btn-light" name="action" value="unpublish" type="submit">
                  Unpublish
                </button>
              </form>
            )}
            <form method="post" action={`${b}/edit/delete`} onsubmit="return confirm('Delete your me.mcp profile and stats? This cannot be undone.')">
              <button class="btn btn-light" type="submit" style="color:#b91c1c">
                Delete my profile
              </button>
            </form>
          </div>
        </div>
      </div>
    </Layout>
  );
}

function Field(props: { label: string; name: string; value: string; max: number; hint?: string }) {
  return (
    <label class="field">
      <span>
        {props.label}
        <small data-count-for={props.name}></small>
      </span>
      <input type="text" name={props.name} value={props.value} data-max={String(props.max)} maxlength={props.max + 200} />
      {props.hint && <small class="muted" style="font-size:13px">{props.hint}</small>}
    </label>
  );
}

function Area(props: { label: string; name: string; value: string; max?: number; hint?: string; tall?: boolean; code?: boolean }) {
  return (
    <label class="field">
      <span>
        {props.label}
        {props.max && <small data-count-for={props.name}></small>}
      </span>
      <textarea
        name={props.name}
        class={[props.tall && "tall", props.code && "code"].filter(Boolean).join(" ") || undefined}
        data-max={props.max ? String(props.max) : undefined}
      >
        {props.value}
      </textarea>
      {props.hint && <small class="muted" style="font-size:13px">{props.hint}</small>}
    </label>
  );
}
