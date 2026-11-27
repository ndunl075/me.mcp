import { cleanLine, isCleanUrl } from "./db";
import { normalizeHttpUrl } from "./auth";

/**
 * Fetches recent public activity for one person from sources they vouch for on their own GitHub profile:
 * GitHub itself (always), the `blog` field, and the Bluesky / Mastodon accounts GitHub lists. Nothing else is ever
 * fetched. Everything runs against a per-run subrequest budget (the free plan allows 50 per invocation) and reads at
 * most a few hundred KB, so a run stays inside the 10 ms CPU limit.
 */

export type SourceId = "github" | "blog" | "bluesky" | "mastodon";
export const SOURCE_IDS: readonly SourceId[] = ["github", "blog", "bluesky", "mastodon"];

export interface ActivityItem {
  source: string;
  kind: "push" | "release" | "repo" | "star" | "pr" | "post" | "package";
  title: string;
  url: string;
  /** ISO-8601 UTC, "2026-11-26T12:34:56Z". */
  ts: string;
  /** Set when the source claimed a future date and `ts` was clamped to the fetch time (not stored). */
  clamped?: boolean;
}

export const TITLE_MAX = 200;
/** Bytes read from any one response. */
export const MAX_BYTES = 128 * 1024;
/** GitHub event payloads (PR bodies) are large: 20 events can be ~90 KB, one huge PR body more. */
const GITHUB_EVENTS_MAX_BYTES = 192 * 1024;
/** Fewer events per page keeps the response inside the byte cap (PR payloads carry whole PR bodies); a cut-off response is still salvaged. */
const EVENTS_PER_PAGE = 15;
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 2;
/** Max subrequests spent on one blog (homepage, feed, one fallback path). */
const BLOG_BUDGET = 3;
const FEED_FALLBACK_PATHS = ["/feed.xml", "/rss.xml"];

// ---- SSRF guard -----------------------------------------------------------

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".onion", ".intranet", ".corp"];

/**
 * Returns the URL when it is safe to fetch from a Worker on behalf of a stranger, else null. https only, default
 * port, no credentials, and a public-looking DNS name: no IP literals (any notation), no localhost, no single-label
 * or internal-looking names. (Workers cannot reach private ranges anyway; this keeps the policy explicit and testable.)
 */
export function publicHttpsUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (u.port && u.port !== "443") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":") || host.startsWith("[")) return null; // IPv6 literal
  if (!host.includes(".")) return null; // "localhost", "intranet", ...
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return null;
  const labels = host.split(".");
  if (/^\d+$/.test(labels[labels.length - 1])) return null; // IPv4 literal (WHATWG URL normalizes 0x7f.1, 2130706433, ...)
  if (!/^[a-z0-9.-]+$/.test(host)) return null; // punycode is ASCII; anything else is odd
  return u;
}

// ---- Budgeted fetcher -----------------------------------------------------

export interface Fetched {
  status: number;
  url: string;
  contentType: string;
  text: string;
}

/** Counts every outgoing request (redirect hops included) against a budget. */
export class Fetcher {
  used = 0;
  constructor(
    readonly max: number,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  get remaining(): number {
    return this.max - this.used;
  }

  /**
   * GET a public https URL. Redirects are followed manually (each hop re-validated, counted, and kept on the requested host or its subdomains). `authHeader` is only
   * ever sent to api.github.com. Returns null when blocked, out of budget, or the request failed.
   */
  async get(
    raw: string,
    opts: { headers?: Record<string, string>; authHeader?: string; maxBytes?: number; maxRedirects?: number } = {},
  ): Promise<Fetched | null> {
    let current = raw;
    const hops = opts.maxRedirects ?? MAX_REDIRECTS;
    const verifiedHost = publicHttpsUrl(raw)?.hostname ?? "";
    for (let hop = 0; hop <= hops; hop++) {
      const u = publicHttpsUrl(current);
      // Every hop, not just the first, must be public https and stay on the host that was asked for (or below it).
      if (!u || !hostWithin(u.hostname, verifiedHost) || this.used >= this.max) return null;
      this.used++;
      const headers: Record<string, string> = { "User-Agent": "me.mcp", ...opts.headers };
      if (opts.authHeader && u.hostname === "api.github.com") headers.Authorization = opts.authHeader;
      let res: Response;
      try {
        res = await this.fetchFn(u.toString(), { headers, redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch {
        return null;
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) return null;
        try {
          current = new URL(loc, u).toString();
        } catch {
          return null;
        }
        continue;
      }
      const text = await readCapped(res, opts.maxBytes ?? MAX_BYTES);
      return { status: res.status, url: u.toString(), contentType: res.headers.get("content-type") ?? "", text };
    }
    return null;
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      parts.push(value.subarray(0, value.byteLength - (size - max)));
      await reader.cancel().catch(() => {});
      break;
    }
    parts.push(value);
  }
  const all = new Uint8Array(Math.min(size, max));
  let at = 0;
  for (const p of parts) (all.set(p, at), (at += p.byteLength));
  return new TextDecoder().decode(all);
}

// ---- Normalization --------------------------------------------------------

/**
 * Activity lines are "date · source · title · url". A title must not be able to fake that structure: URLs inside it
 * become "[link]" and the "·" separator becomes "-".
 */
export function neutralizeTitle(t: string): string {
  return t.replace(/https?:\/\/\S*/gi, "[link]").replace(/\u00b7/g, "-");
}

/** Cleans one item with the same rules as profile fields: one-line title <= 200 chars, http(s) URL only, valid date. */
export function cleanItem(raw: { source: string; kind: ActivityItem["kind"]; title: string; url: string; ts: string | number | Date }, now = Date.now()): ActivityItem | null {
  const title = neutralizeTitle(cleanLine(String(raw.title).slice(0, 1000))).slice(0, TITLE_MAX).trim();
  const url = String(raw.url).trim();
  if (!title || !isCleanUrl(url)) return null;
  const t = new Date(raw.ts).getTime();
  // Dates before 1970 (negative epoch) are never real activity, and years before 0 would format as "-000001-...".
  if (!Number.isFinite(t) || t < 0) return null;
  // A feed claiming a date in the future must not pin itself to the top forever.
  const ts = new Date(Math.min(t, now)).toISOString().slice(0, 19) + "Z";
  return { source: raw.source, kind: raw.kind, title, url, ts, ...(t > now ? { clamped: true } : {}) };
}

function tryJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** JSON array parse that tolerates a response cut off by the byte cap: keeps the complete leading elements. */
export function parseJsonArrayLenient<T>(text: string): T[] | null {
  const whole = tryJson<unknown>(text);
  if (whole !== null) return Array.isArray(whole) ? (whole as T[]) : null;
  const start = text.indexOf("[");
  if (start < 0 || text.slice(0, start).trim()) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastEnd = -1;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inStr = false;
    } else if (c === 34) inStr = true;
    else if (c === 91 || c === 123) depth++;
    else if (c === 93 || c === 125) {
      depth--;
      if (depth === 1) lastEnd = i;
      else if (depth <= 0) break;
    }
  }
  return lastEnd < 0 ? null : tryJson<T[]>(text.slice(start, lastEnd + 1) + "]");
}

const firstLine = (s: string) => s.split("\n")[0] ?? "";

// ---- GitHub ---------------------------------------------------------------

export interface GithubCtx {
  /** Value for the Authorization header ("Basic ..."), when the OAuth app's credentials are configured. */
  auth?: string;
}

export function githubBasicAuth(env: { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string }): string | undefined {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return undefined;
  return "Basic " + btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
}

/**
 * GET api.github.com/<path> as JSON. With OAuth-app credentials the request counts against the app's 5,000/hour
 * (instead of the shared 60/hour per egress IP). If GitHub rejects the credentials (401) it retries once without
 * them rather than failing the profile.
 */
async function ghJson<T>(f: Fetcher, gh: GithubCtx, path: string, maxBytes = MAX_BYTES, lenientArray = false): Promise<T | null> {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const url = `https://api.github.com${path}`;
  const sent = gh.auth; // captured: concurrent calls may already have cleared gh.auth by the time this one's 401 arrives
  let res = await f.get(url, { headers, authHeader: sent, maxBytes, maxRedirects: 0 });
  if (res?.status === 401 && sent) {
    gh.auth = undefined;
    res = await f.get(url, { headers, maxBytes, maxRedirects: 0 });
  }
  if (!res || res.status !== 200) return null;
  return lenientArray ? (parseJsonArrayLenient<unknown>(res.text) as T | null) : tryJson<T>(res.text);
}

interface GhEvent {
  type?: string;
  created_at?: string;
  repo?: { name?: string };
  payload?: {
    action?: string;
    ref?: string;
    ref_type?: string;
    commits?: { message?: string }[];
    release?: { html_url?: string; tag_name?: string; name?: string };
    pull_request?: { html_url?: string; title?: string; number?: number; merged?: boolean; user?: { login?: string } };
  };
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** Maps GitHub public events to activity items. Pushes collapse per repo; PRs per PR; `login` is the person. Newest event wins per URL. */
export function githubEventsToItems(events: GhEvent[], login: string, now = Date.now()): ActivityItem[] {
  const out: ActivityItem[] = [];
  const seen = new Set<string>();
  const add = (kind: ActivityItem["kind"], title: string, url: string, ts: string | undefined) => {
    if (!ts || seen.has(url)) return;
    const item = cleanItem({ source: "github", kind, title, url, ts }, now);
    if (!item) return;
    seen.add(url);
    out.push(item);
  };
  for (const e of events.slice(0, 40)) {
    const repo = e.repo?.name ?? "";
    if (!REPO_NAME.test(repo)) continue;
    const repoUrl = `https://github.com/${repo}`;
    const p = e.payload ?? {};
    switch (e.type) {
      case "PushEvent": {
        // GitHub no longer includes commits in public PushEvent payloads; use the first message when present.
        const msg = firstLine(p.commits?.[0]?.message ?? "");
        add("push", msg ? `Pushed to ${repo}: ${msg}` : `Pushed to ${repo}`, repoUrl, e.created_at);
        break;
      }
      case "ReleaseEvent":
        if (p.action === "published" && p.release?.html_url) {
          add("release", `Released ${p.release.name || p.release.tag_name || "a new version"} of ${repo}`, p.release.html_url, e.created_at);
        }
        break;
      case "CreateEvent":
        if (p.ref_type === "repository") add("repo", `Created repo ${repo}`, repoUrl, e.created_at);
        break;
      case "WatchEvent":
        add("star", `Starred ${repo}`, repoUrl, e.created_at);
        break;
      case "PullRequestEvent": {
        const pr = p.pull_request;
        if (!pr?.html_url) break;
        const verb = p.action === "opened" ? "Opened" : p.action === "closed" && pr.merged ? "Merged" : null;
        // The title is the PR author's text. Only show it when that is this person; a PR by someone else that they
        // merged gets the repo name only.
        const own = pr.user?.login?.toLowerCase() === login.toLowerCase();
        if (verb) add("pr", `${verb} PR #${pr.number ?? ""} in ${repo}${own && pr.title ? `: ${pr.title}` : ""}`, pr.html_url, e.created_at);
        break;
      }
    }
  }
  return out;
}

export interface GithubProfile {
  blog: string | null;
  bluesky: string | null; // handle or DID
  mastodon: { host: string; user: string } | null;
}

/** Bluesky and Mastodon accounts as listed in GitHub's social_accounts. Only these two providers are ever used. */
export function parseSocialAccounts(list: { provider?: string; url?: string }[]): Pick<GithubProfile, "bluesky" | "mastodon"> {
  let bluesky: string | null = null;
  let mastodon: GithubProfile["mastodon"] = null;
  for (const a of list.slice(0, 20)) {
    if (typeof a?.url !== "string") continue;
    const u = publicHttpsUrl(a.url);
    if (!u) continue;
    if (a.provider === "bluesky" && !bluesky) {
      const m = u.pathname.match(/^\/profile\/([A-Za-z0-9.:-]{1,253})\/?$/);
      if (u.hostname === "bsky.app" && m) bluesky = m[1];
    } else if (a.provider === "mastodon" && !mastodon) {
      const m = u.pathname.match(/^\/@([A-Za-z0-9_.-]{1,64})\/?$/);
      if (m) mastodon = { host: u.hostname.toLowerCase(), user: m[1] };
    }
  }
  return { bluesky, mastodon };
}

// ---- Bluesky --------------------------------------------------------------

interface BskyFeed {
  feed?: { post?: { uri?: string; author?: { handle?: string }; record?: { text?: string; createdAt?: string }; indexedAt?: string }; reason?: unknown }[];
}

export function blueskyToItems(data: BskyFeed, actor: string, now = Date.now()): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const entry of (data.feed ?? []).slice(0, 20)) {
    if (entry.reason) continue; // reposts and pins are not their own words
    const post = entry.post;
    const rkey = post?.uri?.match(/\/app\.bsky\.feed\.post\/([A-Za-z0-9]{1,40})$/)?.[1];
    if (!post || !rkey) continue;
    const who = post.author?.handle || actor;
    const item = cleanItem(
      { source: "bluesky", kind: "post", title: post.record?.text ?? "", url: `https://bsky.app/profile/${who}/post/${rkey}`, ts: post.record?.createdAt ?? post.indexedAt ?? "" },
      now,
    );
    if (item) out.push(item);
  }
  return out;
}

export async function fetchBluesky(f: Fetcher, actor: string, now = Date.now()): Promise<ActivityItem[] | null> {
  const u = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=10&filter=posts_no_replies`;
  const res = await f.get(u, { headers: { Accept: "application/json" } });
  if (!res || res.status !== 200) return null;
  const data = tryJson<BskyFeed>(res.text);
  return data ? blueskyToItems(data, actor, now) : null;
}

// ---- Mastodon -------------------------------------------------------------

interface MastoStatus {
  id?: string;
  url?: string;
  content?: string;
  spoiler_text?: string;
  created_at?: string;
}

export function mastodonToItems(statuses: MastoStatus[], host: string, now = Date.now()): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const s of statuses.slice(0, 20)) {
    if (typeof s?.url !== "string") continue;
    const link = publicHttpsUrl(s.url);
    if (!link || link.hostname.toLowerCase() !== host) continue; // statuses link to the instance they were fetched from
    const body = decodeEntities(stripTags(String(s.content ?? "").replace(/<br\s*\/?>|<\/p>/gi, " ")));
    const item = cleanItem({ source: "mastodon", kind: "post", title: s.spoiler_text || body, url: link.toString(), ts: s.created_at ?? "" }, now);
    if (item) out.push(item);
  }
  return out;
}

export async function fetchMastodon(f: Fetcher, acct: { host: string; user: string }, now = Date.now()): Promise<ActivityItem[] | null> {
  const lookup = await f.get(`https://${acct.host}/api/v1/accounts/lookup?acct=${encodeURIComponent(acct.user)}`, { headers: { Accept: "application/json" } });
  if (!lookup || lookup.status !== 200) return null;
  const id = tryJson<{ id?: string }>(lookup.text)?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(id)) return null;
  const res = await f.get(`https://${acct.host}/api/v1/accounts/${id}/statuses?limit=8&exclude_replies=true&exclude_reblogs=true`, {
    headers: { Accept: "application/json" },
  });
  if (!res || res.status !== 200) return null;
  const data = parseJsonArrayLenient<MastoStatus>(res.text);
  return data ? mastodonToItems(data, acct.host, now) : null;
}

// ---- Blog feeds (RSS / Atom) ----------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Everything below scans with indexOf and bounded windows, never with a regex whose repeat can rescan the rest of an
// attacker-sized document ("<<<<..." or "<link <link ..." without ">" made `<[^>]*>` quadratic).

/** Removes <...> runs. A "<" with no later ">" is text, so the whole pass is linear. */
export function stripTags(s: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt < 0) break;
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break;
    out += s.slice(i, lt);
    i = gt + 1;
  }
  return out + s.slice(i);
}

/** <![CDATA[x]]> -> x. An unclosed section is left as text. */
function unCdata(s: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = s.indexOf("<![CDATA[", i);
    if (open < 0) break;
    const close = s.indexOf("]]>", open + 9);
    if (close < 0) break;
    out += s.slice(i, open) + s.slice(open + 9, close);
    i = close + 3;
  }
  return out + s.slice(i);
}

const MAX_TAG_LEN = 500;

/** Source text of up to `max` opening tags named `name` (`<link ...>`), skipping any longer than MAX_TAG_LEN. */
export function findTags(src: string, name: string, max = 50): string[] {
  const out: string[] = [];
  const open = "<" + name;
  let from = 0;
  let gt = -1;
  while (out.length < max) {
    const i = src.indexOf(open, from);
    if (i < 0) break;
    from = i + 1;
    const c = src.charCodeAt(i + open.length);
    if (!(c === 62 || c === 32 || c === 9 || c === 10 || c === 13 || c === 47)) continue; // <linkfoo is another tag
    if (gt < i) {
      gt = src.indexOf(">", i); // cached: later candidates reuse it until they pass it
      if (gt < 0) break;
    }
    if (gt - i <= MAX_TAG_LEN) out.push(src.slice(i, gt + 1));
  }
  return out;
}

/** Text content of the first `<tag ...>text</tag>` in `block`, decoded; null when absent, self-closing or unclosed. */
function tagText(block: string, tag: string): string | null {
  const open = "<" + tag;
  let from = 0;
  for (;;) {
    const i = block.indexOf(open, from);
    if (i < 0) return null;
    from = i + 1;
    const c = block.charCodeAt(i + open.length);
    if (!(c === 62 || c === 32 || c === 9 || c === 10 || c === 13)) continue;
    const gt = block.indexOf(">", i);
    if (gt < 0) return null;
    if (block.charCodeAt(gt - 1) === 47) continue; // <tag/>
    const end = block.indexOf(`</${tag}>`, gt);
    if (end < 0) return null;
    return decodeEntities(stripTags(unCdata(block.slice(gt + 1, end)))).trim();
  }
}

/** Attribute value from one tag's source (at most MAX_TAG_LEN chars, so the regex cannot blow up). */
function attr(tagSrc: string, name: string): string | null {
  const m = tagSrc.slice(0, MAX_TAG_LEN).match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : null;
}

const MAX_FEED_ITEMS = 15;
const MAX_FEED_BLOCKS = 100; // blocks examined, valid or not
const MAX_BLOCK = 30_000;

/** Tiny regex extraction of <item> (RSS 2.0) and <entry> (Atom) blocks. Not an XML parser, by design (CPU). */
export function parseFeed(xml: string, baseUrl: string): { title: string; url: string; ts: string }[] {
  const out: { title: string; url: string; ts: string }[] = [];
  const re = /<(item|entry)[\s>]/g; // XML is case-sensitive; also avoids lower-casing the whole document per item
  let m: RegExpExecArray | null;
  for (let blocks = 0; blocks < MAX_FEED_BLOCKS && out.length < MAX_FEED_ITEMS && (m = re.exec(xml)); blocks++) {
    const end = xml.indexOf(`</${m[1]}>`, m.index);
    if (end < 0) break; // truncated by the byte cap
    const block = xml.slice(m.index, Math.min(end, m.index + MAX_BLOCK));
    re.lastIndex = end;

    let link = tagText(block, "link");
    if (!link) {
      for (const l of findTags(block, "link", 10)) {
        const rel = attr(l, "rel");
        if (rel && rel.toLowerCase() !== "alternate") continue;
        link = attr(l, "href");
        if (link) break;
      }
    }
    let title = tagText(block, "title");
    // Atom <title type="html">: the text is escaped markup, so strip the tags that decoding just revealed.
    if (title && /^x?html$/i.test(attr(findTags(block, "title", 1)[0] ?? "", "type") ?? "")) title = stripTags(title).trim();
    const date = tagText(block, "pubDate") ?? tagText(block, "published") ?? tagText(block, "updated") ?? tagText(block, "dc:date");
    if (!link || !title || !date) continue;
    let abs: string;
    try {
      abs = new URL(link, baseUrl).toString();
    } catch {
      continue;
    }
    out.push({ title, url: abs, ts: date });
  }
  return out;
}

/** <link rel="alternate" type="application/rss+xml|atom+xml" href="..."> from a page's HTML, resolved against `base`. */
export function discoverFeedLink(html: string, base: string): string | null {
  for (const tag of findTags(html.slice(0, MAX_BYTES), "link")) {
    const rel = attr(tag, "rel");
    const type = attr(tag, "type");
    const href = attr(tag, "href");
    if (!href || !rel || !type || !/\balternate\b/i.test(rel) || !/(rss|atom)\+xml/i.test(type)) continue;
    try {
      return new URL(href, base).toString();
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Title and meta description from an HTML page. Bounded window, same linear tag scan as feeds. */
export function pageSummary(html: string): { title: string; description: string } {
  const head = html.slice(0, 48_000);
  const title = (tagText(head, "title") ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  let description = "";
  for (const tag of findTags(head, "meta", 30)) {
    const key = (attr(tag, "name") || attr(tag, "property") || "").toLowerCase();
    if (key !== "description" && key !== "og:description") continue;
    description = (attr(tag, "content") ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    break;
  }
  return { title, description };
}

/** Site URL a feed points at (RSS channel link, or the feed-level Atom alternate), resolved against the feed URL. */
export function channelLink(xml: string, base: string): string | null {
  const itemAt = xml.indexOf("<item");
  const entryAt = xml.indexOf("<entry");
  const cuts = [itemAt, entryAt].filter((n) => n >= 0);
  const head = xml.slice(0, cuts.length ? Math.min(...cuts, 8000) : Math.min(xml.length, 8000));
  const text = tagText(head, "link");
  if (text) {
    try {
      return new URL(text.trim(), base).toString();
    } catch {
      return null;
    }
  }
  for (const l of findTags(head, "link", 8)) {
    const rel = attr(l, "rel");
    if (rel && rel.toLowerCase() !== "alternate") continue;
    const href = attr(l, "href");
    if (!href) continue;
    try {
      return new URL(href, base).toString();
    } catch {
      /* next */
    }
  }
  return null;
}

const looksLikeFeed = (r: Fetched) => r.status === 200 && /<(rss|feed|rdf:RDF)[\s>]/i.test(r.text.slice(0, 2000));

/**
 * True when `host` is the verified host or a subdomain of it. "www." is equivalent to the bare host only for those two
 * exact names: a verified `www.example.com` allows `example.com` and `*.www.example.com`, never `evil.example.com`,
 * and a verified `example.com` allows `www.example.com` and `*.example.com`. Never a parent domain.
 */
export function hostWithin(host: string, verified: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const v = verified.toLowerCase().replace(/\.$/, "");
  if (h === v || h.endsWith("." + v)) return true;
  return v.startsWith("www.") && h === v.slice(4);
}

/** A URL found on a verified site (a discovered feed) must stay on that site or below it. */
export function sameSite(candidateUrl: string, verifiedUrl: string): boolean {
  try {
    return hostWithin(new URL(candidateUrl).hostname, new URL(verifiedUrl).hostname);
  } catch {
    return false;
  }
}

/** Blog homepage -> feed (via <link rel=alternate> or a common path) -> items. At most BLOG_BUDGET subrequests. */
export async function fetchBlog(f: Fetcher, blogUrl: string, now = Date.now()): Promise<ActivityItem[] | null> {
  // Own counter, not f.used: other sources of the same profile are fetched concurrently through the same Fetcher.
  let spent = 0;
  const get = (u: string) => (spent++, f.get(u, { headers: { Accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/html;q=0.5" } }));

  const home = await get(blogUrl);
  if (!home || home.status !== 200) return null;
  let feed: Fetched | null = looksLikeFeed(home) ? home : null; // the "blog" field may itself be a feed URL

  if (!feed) {
    const link = discoverFeedLink(home.text, home.url);
    if (link && sameSite(link, blogUrl) && spent < BLOG_BUDGET) {
      const r = await get(link);
      if (r && looksLikeFeed(r)) feed = r;
    }
  }
  if (!feed) {
    for (const path of FEED_FALLBACK_PATHS) {
      if (spent >= BLOG_BUDGET) break;
      const r = await get(new URL(path, home.url).toString());
      if (r && looksLikeFeed(r)) {
        feed = r;
        break;
      }
    }
  }
  if (!feed) return null;
  const items: ActivityItem[] = [];
  for (const e of parseFeed(feed.text, feed.url)) {
    const item = cleanItem({ source: "blog", kind: "post", ...e }, now);
    if (item) items.push(item);
  }
  return items;
}

// ---- One profile ----------------------------------------------------------

export interface FetchedSources {
  /** What GitHub lists for this person; null when GitHub could not be reached (then nothing may be concluded). */
  profile: GithubProfile | null;
  /** Items per source. A source is absent when its fetch failed (so its stored rows are left alone). */
  items: Partial<Record<SourceId, ActivityItem[]>>;
  /** Short display label per discovered source. */
  labels: Partial<Record<SourceId, string>>;
  githubOk: boolean;
  /** False when GitHub's social_accounts call failed: Bluesky/Mastodon then say nothing about those sources. */
  socialKnown: boolean;
}

/**
 * Collects activity for `login`: GitHub events plus whichever of blog / Bluesky / Mastodon the person lists on GitHub.
 * `skip` holds sources the owner switched off. Worst case ~9 subrequests (3 GitHub + 3 blog + 1 Bluesky + 2 Mastodon).
 */
export async function fetchProfileSources(f: Fetcher, gh: GithubCtx, login: string, skip: ReadonlySet<SourceId> = new Set(), now = Date.now()): Promise<FetchedSources> {
  const enc = encodeURIComponent(login);
  const wantEvents = !skip.has("github");
  const [user, social, events] = await Promise.all([
    ghJson<{ blog?: string | null }>(f, gh, `/users/${enc}`),
    ghJson<{ provider?: string; url?: string }[]>(f, gh, `/users/${enc}/social_accounts`),
    wantEvents ? ghJson<GhEvent[]>(f, gh, `/users/${enc}/events/public?per_page=${EVENTS_PER_PAGE}`, GITHUB_EVENTS_MAX_BYTES, true) : Promise.resolve(null),
  ]);

  const result: FetchedSources = { profile: null, items: {}, labels: { github: `@${login}` }, githubOk: !!user, socialKnown: Array.isArray(social) };
  if (Array.isArray(events)) result.items.github = githubEventsToItems(events, login, now);
  if (!user) return result;

  // `blog` is free text on GitHub: accept an http(s) URL or bare host, then require a public https host.
  const blogRaw = typeof user.blog === "string" ? normalizeHttpUrl(user.blog) : null;
  const blogUrl = blogRaw && publicHttpsUrl(blogRaw.replace(/^http:\/\//i, "https://")) ? blogRaw.replace(/^http:\/\//i, "https://") : null;
  const accounts = Array.isArray(social) ? parseSocialAccounts(social) : { bluesky: null, mastodon: null };
  result.profile = { blog: blogUrl, ...accounts };

  const jobs: Promise<void>[] = [];
  const run = (id: SourceId, label: string, job: () => Promise<ActivityItem[] | null>) => {
    result.labels[id] = label;
    if (skip.has(id)) return;
    jobs.push(
      job()
        .then((items) => {
          if (items) result.items[id] = items;
        })
        .catch(() => {}),
    );
  };
  if (blogUrl) run("blog", new URL(blogUrl).hostname.replace(/^www\./, ""), () => fetchBlog(f, blogUrl, now));
  if (result.profile.bluesky) run("bluesky", result.profile.bluesky, () => fetchBluesky(f, result.profile!.bluesky!, now));
  if (result.profile.mastodon) {
    const m = result.profile.mastodon;
    run("mastodon", `@${m.user}@${m.host}`, () => fetchMastodon(f, m, now));
  }
  await Promise.all(jobs);
  return result;
}
