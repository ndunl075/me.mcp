import { cleanLine } from "./db";
import {
  Fetcher,
  channelLink,
  cleanItem,
  discoverFeedLink,
  pageSummary,
  parseFeed,
  publicHttpsUrl,
  sameSite,
  type ActivityItem,
} from "./sources";

/**
 * Owner-added activity sources. Every fetch goes through Fetcher (https only, SSRF checks, redirect host checks,
 * byte cap). Verification is a backlink to the person's GitHub profile or their me.mcp page, checked when they add
 * the source and again on refresh.
 */

export const CUSTOM_KINDS = ["feed", "website", "hn", "devto", "npm"] as const;
export type CustomKind = (typeof CUSTOM_KINDS)[number];

/** GETs per custom source on a cron refresh (an add request may use one more). Each GET may follow one redirect. */
export const CUSTOM_GETS = 2;
export const CUSTOM_MAX_REDIRECTS = 1;
/** Counted subrequests one custom source can spend on a cron run: 2 GETs, each with one redirect hop. */
export const CUSTOM_SUBREQUESTS = CUSTOM_GETS * (1 + CUSTOM_MAX_REDIRECTS);

export const CUSTOM_SOURCE_CAP = 6;

export const KIND_NAME: Record<CustomKind, string> = {
  feed: "feed",
  website: "website",
  hn: "hn",
  devto: "dev.to",
  npm: "npm",
};

const USER_RE: Record<"hn" | "devto" | "npm", RegExp> = {
  hn: /^[A-Za-z0-9_-]{2,32}$/,
  devto: /^[A-Za-z0-9]{1,30}$/,
  npm: /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/i,
};

const NPM_NAME = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;

export function isCustomKind(k: string): k is CustomKind {
  return (CUSTOM_KINDS as readonly string[]).includes(k);
}

/** Accept a URL or username for `kind`, or null when it is not something we will fetch. */
export function normalizeTarget(kind: string, raw: string): { kind: CustomKind; target: string } | null {
  if (kind === "feed" || kind === "website") {
    let s = raw.trim();
    if (!s || s.length > 300) return null;
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    s = s.replace(/^http:\/\//i, "https://");
    const u = publicHttpsUrl(s);
    if (!u) return null;
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    return { kind, target: u.toString() };
  }
  if (kind !== "hn" && kind !== "devto" && kind !== "npm") return null;
  const user = raw.trim().replace(/^@/, "");
  if (!USER_RE[kind].test(user)) return null;
  return { kind, target: kind === "hn" ? user : user.toLowerCase() };
}

export function newSourceId(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function loginChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c === 45;
}

/** True when `needle` occurs in `hay` and the next character is not a login character (so `zoe` does not match `zoe-evil`). */
function hasToken(hay: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const next = hay.charCodeAt(i + needle.length);
    if (Number.isNaN(next) || !loginChar(next)) return true;
    from = i + needle.length;
  }
}

/**
 * True when `text` links to https://github.com/<login> (exact login, not a longer name) or to the person's me.mcp page.
 * Linear scan. `pageUrl` is matched with and without a trailing slash.
 */
export function hasBacklink(text: string, login: string, pageUrl: string): boolean {
  const hay = text.toLowerCase();
  const who = login.toLowerCase();
  if (!/^[a-z0-9-]{1,39}$/.test(who)) return false;
  let page = pageUrl.trim().toLowerCase().replace(/\/+$/, "");
  if (page.startsWith("http://") || page.startsWith("https://")) {
    if (hasToken(hay, page) || hasToken(hay, page + "/")) return true;
  }
  return hasToken(hay, "github.com/" + who);
}

/** True when an npm repository URL lives under github.com/<login>/<repo>. */
export function npmRepoMatches(repository: unknown, login: string): boolean {
  const raw =
    typeof repository === "string"
      ? repository
      : repository && typeof repository === "object" && typeof (repository as { url?: unknown }).url === "string"
        ? (repository as { url: string }).url
        : "";
  if (!raw || raw.length > 300) return false;
  const cleaned = raw.replace(/^git\+/i, "").replace(/\.git$/i, "");
  let u: URL;
  try {
    u = new URL(cleaned);
  } catch {
    return false;
  }
  if (u.hostname.toLowerCase() !== "github.com") return false;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return false;
  let owner = segs[0];
  try {
    owner = decodeURIComponent(owner);
  } catch {
    return false;
  }
  return owner.toLowerCase() === login.toLowerCase();
}

const hostLabel = (raw: string) => {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
};

const looksLikeFeed = (status: number, text: string) => status === 200 && /<(rss|feed|rdf:RDF)[\s>]/i.test(text.slice(0, 2000));

export interface CustomSpec {
  id: string;
  kind: CustomKind;
  target: string;
  /** Previous verified flag, kept when this run cannot re-check. */
  verified: boolean;
}

export interface CustomFetch {
  items: ActivityItem[];
  verified: boolean;
  label: string;
  summary: string;
}

function itemsFromFeed(xml: string, base: string, source: string, now: number): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const e of parseFeed(xml, base)) {
    const item = cleanItem({ source, kind: "post", ...e }, now);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Fetches one owner-added source. Returns null when the fetch failed (stored rows stay, failure count goes up).
 * An empty item list with a result means the source answered and simply had nothing to keep.
 */
export async function fetchCustomSource(
  f: Fetcher,
  spec: CustomSpec,
  ctx: { login: string; pageUrl: string; now?: number; maxGets?: number },
): Promise<CustomFetch | null> {
  const now = ctx.now ?? Date.now();
  const maxGets = ctx.maxGets ?? CUSTOM_GETS;
  const source = `c:${spec.id}`;
  let spent = 0;
  const get = (url: string, accept: string) => {
    if (spent >= maxGets) return Promise.resolve(null);
    spent++;
    return f.get(url, { headers: { Accept: accept }, maxRedirects: CUSTOM_MAX_REDIRECTS });
  };
  const linked = (text: string) => hasBacklink(text, ctx.login, ctx.pageUrl);

  if (spec.kind === "feed" || spec.kind === "website") return fetchSite(spec, source, get, linked, now);
  if (spec.kind === "hn") return fetchHn(spec, source, get, linked, now);
  if (spec.kind === "devto") return fetchDevto(spec, source, get, linked, ctx.login, now);
  return fetchNpm(spec, source, get, ctx.login, now);
}

type Get = (url: string, accept: string) => Promise<{ status: number; url: string; text: string } | null>;

async function fetchSite(spec: CustomSpec, source: string, get: Get, linked: (t: string) => boolean, now: number): Promise<CustomFetch | null> {
  const accept = "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/html;q=0.5, */*;q=0.1";
  const first = await get(spec.target, accept);
  if (!first || first.status !== 200) return null;
  const label = hostLabel(first.url);
  let verified = linked(first.text);
  let summary = "";
  let feedText = "";
  let feedUrl = first.url;

  if (looksLikeFeed(first.status, first.text)) {
    feedText = first.text;
  } else {
    const sum = pageSummary(first.text);
    summary = [cleanLine(sum.title).slice(0, 140), cleanLine(sum.description).slice(0, 180)].filter(Boolean).join(". ").slice(0, 240);
    const found = discoverFeedLink(first.text, first.url);
    if (found && sameSite(found, spec.target)) {
      const feed = await get(found, accept);
      if (feed && looksLikeFeed(feed.status, feed.text)) {
        feedText = feed.text;
        feedUrl = feed.url;
        if (!verified && linked(feed.text)) verified = true;
      }
    }
  }

  if (feedText && !verified) {
    const home = channelLink(feedText, feedUrl);
    if (home && sameSite(home, feedUrl) && home !== first.url) {
      const page = await get(home, "text/html, */*;q=0.1");
      if (page && page.status === 200 && linked(page.text)) verified = true;
      if (page && !summary && !looksLikeFeed(page.status, page.text)) {
        const sum = pageSummary(page.text);
        summary = [cleanLine(sum.title).slice(0, 140), cleanLine(sum.description).slice(0, 180)].filter(Boolean).join(". ").slice(0, 240);
      }
    }
  }

  // A website with no discovered feed still counts: the summary is the point. A feed with no items is a real answer.
  if (spec.kind === "feed" && !feedText) return null;
  return {
    items: feedText ? itemsFromFeed(feedText, feedUrl, source, now) : [],
    verified,
    label,
    summary: spec.kind === "website" ? summary : "",
  };
}

interface HnHit {
  title?: string;
  url?: string;
  objectID?: string;
  created_at?: string;
}

async function fetchHn(spec: CustomSpec, source: string, get: Get, linked: (t: string) => boolean, now: number): Promise<CustomFetch | null> {
  const user = encodeURIComponent(spec.target);
  const [about, stories] = await Promise.all([
    get(`https://hacker-news.firebaseio.com/v0/user/${user}.json`, "application/json"),
    get(`https://hn.algolia.com/api/v1/search_by_date?tags=author_${user},story&hitsPerPage=8`, "application/json"),
  ]);
  // Both calls were issued together, so a stories failure is a failure even if `about` arrived.
  if (!stories || stories.status !== 200) return null;
  let hits: HnHit[] = [];
  try {
    const data = JSON.parse(stories.text) as { hits?: HnHit[] };
    hits = Array.isArray(data.hits) ? data.hits : [];
  } catch {
    return null;
  }
  const items: ActivityItem[] = [];
  for (const h of hits.slice(0, 8)) {
    const id = typeof h.objectID === "string" && /^[0-9]{1,12}$/.test(h.objectID) ? h.objectID : "";
    const url = typeof h.url === "string" && h.url ? h.url : id ? `https://news.ycombinator.com/item?id=${id}` : "";
    if (!url || !h.title) continue;
    const item = cleanItem({ source, kind: "post", title: h.title, url, ts: h.created_at ?? "" }, now);
    if (item) items.push(item);
  }
  let verified = spec.verified;
  if (about && about.status === 200) {
    try {
      const row = JSON.parse(about.text) as { about?: unknown };
      verified = typeof row.about === "string" && linked(row.about);
    } catch {
      verified = false;
    }
  }
  return { items, verified, label: `@${spec.target}`, summary: "" };
}

interface DevtoArticle {
  title?: string;
  url?: string;
  published_at?: string;
}

async function fetchDevto(
  spec: CustomSpec,
  source: string,
  get: Get,
  linked: (t: string) => boolean,
  login: string,
  now: number,
): Promise<CustomFetch | null> {
  const user = encodeURIComponent(spec.target);
  const [who, posts] = await Promise.all([
    get(`https://dev.to/api/users/by_username?url=${user}`, "application/json"),
    get(`https://dev.to/api/articles?username=${user}&per_page=8`, "application/json"),
  ]);
  if (!posts || posts.status !== 200) return null;
  let articles: DevtoArticle[] = [];
  try {
    const data = JSON.parse(posts.text) as unknown;
    articles = Array.isArray(data) ? (data as DevtoArticle[]) : [];
  } catch {
    return null;
  }
  const items: ActivityItem[] = [];
  for (const a of articles.slice(0, 8)) {
    if (!a.title || !a.url) continue;
    const item = cleanItem({ source, kind: "post", title: a.title, url: a.url, ts: a.published_at ?? "" }, now);
    if (item) items.push(item);
  }
  let verified = false;
  if (who && who.status === 200) {
    try {
      const row = JSON.parse(who.text) as { github_username?: unknown; summary?: unknown; website_url?: unknown };
      const gh = typeof row.github_username === "string" ? row.github_username : "";
      const bio = `${typeof row.summary === "string" ? row.summary : ""} ${typeof row.website_url === "string" ? row.website_url : ""}`;
      verified = gh.toLowerCase() === login.toLowerCase() || linked(bio);
    } catch {
      verified = false;
    }
  }
  return { items, verified, label: `@${spec.target}`, summary: "" };
}

interface NpmPackage {
  name?: string;
  description?: string;
  date?: string;
  links?: { npm?: string; repository?: unknown };
}

async function fetchNpm(spec: CustomSpec, source: string, get: Get, login: string, now: number): Promise<CustomFetch | null> {
  const res = await get(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`maintainer:${spec.target}`)}&size=8`,
    "application/json",
  );
  if (!res || res.status !== 200) return null;
  let objects: { package?: NpmPackage }[] = [];
  try {
    const data = JSON.parse(res.text) as { objects?: { package?: NpmPackage }[] };
    objects = Array.isArray(data.objects) ? data.objects : [];
  } catch {
    return null;
  }
  const items: ActivityItem[] = [];
  let matched = 0;
  for (const o of objects.slice(0, 8)) {
    const p = o.package;
    if (!p?.name || !NPM_NAME.test(p.name)) continue;
    if (!npmRepoMatches(p.links?.repository, login)) continue;
    matched++;
    const url = `https://www.npmjs.com/package/${p.name}`;
    const item = cleanItem({ source, kind: "package", title: p.description ? `${p.name}: ${p.description}` : p.name, url, ts: p.date ?? "" }, now);
    if (item) items.push(item);
  }
  return { items, verified: matched > 0, label: `@${spec.target}`, summary: "" };
}
