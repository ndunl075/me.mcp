import { z } from "zod";

export interface Link {
  label: string;
  url: string;
}
export interface Project {
  name: string;
  url: string;
  description: string;
}

export interface Profile {
  handle: string;
  github_id: number;
  published: boolean;
  name: string;
  avatar_url: string;
  headline: string;
  location: string;
  bio: string;
  now: string;
  about: string;
  contact: string;
  links: Link[];
  projects: Project[];
  has_key: boolean;
  calls_total: number;
  created_at: string;
  updated_at: string;
}

/** Handles that collide with app routes. GitHub users with these logins can't claim them. */
export const RESERVED = new Set([
  "mcp", "new", "edit", "api", "auth", "assets", "logout", "llms.txt", "leaderboard", "explore", "about",
]);

// Characters that render as nothing (or reorder text) but are still read by models: control chars, bidi controls,
// zero-width/invisible operators, BOM, soft hyphen, blank "filler" letters (Hangul, braille blank, grapheme joiner),
// interlinear annotation and musical-symbol format controls.
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u034F\u061C\u115F\u1160\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}]/gu;
const HAS_INVISIBLE = new RegExp(INVISIBLE.source, "u"); // non-global: safe to .test() repeatedly

// Unicode "tag" characters (U+E0000 block) can carry hidden ASCII, so they are stripped, except the three emoji
// subdivision flags (England, Scotland, Wales), the only tag sequences emoji actually use.
const TAGS = /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\u{E0000}-\u{E007F}]/gu;
// Ideographic variation selectors (U+E0100 block) are legitimate right after a CJK ideograph (e.g. in Japanese names),
// and a hidden-data channel anywhere else.
const IVS = /([\u3400-\u9FFF\uF900-\uFAFF\u{20000}-\u{3FFFF}])[\u{E0100}-\u{E01EF}]|[\u{E0100}-\u{E01EF}]/gu;

/**
 * Normalizes line endings, strips invisible characters, caps blank-line runs at one blank line, trims.
 * ZWJ/ZWNJ (U+200C/D) are kept, since emoji sequences and Persian/Indic scripts need them, but runs of them are
 * dropped (no real text has two in a row; binary-encoded hidden text does).
 */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(INVISIBLE, "")
    .replace(TAGS, (_, flag) => flag ?? "")
    .replace(IVS, (m, ideograph) => (ideograph ? m : ""))
    .replace(/[\u200C\u200D]{2,}/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Single-line fields (name, headline, labels...): all whitespace runs, including newlines, become one space. */
export function cleanLine(s: string): string {
  return cleanText(s).replace(/\s+/g, " ");
}

// Everything is still treated as untrusted on output; this just removes the invisible/structural tricks.
const clean = (max: number) => z.string().transform(cleanText).pipe(z.string().max(max));
const cleanOneLine = (max: number) => z.string().transform(cleanLine).pipe(z.string().max(max));

// No whitespace or invisible chars inside a URL: `new URL` tolerates them, and they'd smuggle prose into a "link".
const httpUrl = z
  .string()
  .trim()
  .max(300)
  .refine((u) => {
    try {
      if (/[\s\u0000-\u001F\u007F]/.test(u) || HAS_INVISIBLE.test(u) || /[\u200C\u200D\u{E0000}-\u{E01EF}]/u.test(u)) return false;
      const p = new URL(u).protocol;
      return p === "https:" || p === "http:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL with no spaces");

export const LIMITS = {
  name: 80,
  headline: 140,
  location: 80,
  bio: 1200,
  now: 1200,
  about: 8000,
  contact: 400,
  links: 12,
  projects: 12,
};

export const ProfileInput = z.object({
  name: cleanOneLine(LIMITS.name),
  headline: cleanOneLine(LIMITS.headline),
  location: cleanOneLine(LIMITS.location),
  bio: clean(LIMITS.bio),
  now: clean(LIMITS.now),
  about: clean(LIMITS.about),
  contact: clean(LIMITS.contact),
  links: z.array(z.object({ label: cleanOneLine(60), url: httpUrl })).max(LIMITS.links),
  projects: z
    .array(z.object({ name: cleanOneLine(80), url: z.union([httpUrl, z.literal("")]), description: cleanOneLine(300) }))
    .max(LIMITS.projects),
});
export type ProfileInput = z.infer<typeof ProfileInput>;

/** Partial version used by the owner-only MCP update tool. */
export const ProfilePatch = ProfileInput.partial();

// ---- line formats used by the editor textareas ----------------------------

/** "Label | https://url" per line (label optional). */
export function parseLinks(text: string): Link[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const parts = l.split("|").map((p) => p.trim());
      if (parts.length === 1) return { label: hostLabel(parts[0]), url: parts[0] };
      return { label: parts[0], url: parts.slice(1).join("|").trim() };
    });
}
export function formatLinks(links: Link[]): string {
  return links.map((l) => `${l.label} | ${l.url}`).join("\n");
}

/** "Name | https://url | description" per line (url and description optional). */
export function parseProjects(text: string): Project[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = "", second = "", ...rest] = l.split("|").map((p) => p.trim());
      if (second && !/^https?:\/\//i.test(second)) {
        return { name, url: "", description: [second, ...rest].join(" | ") };
      }
      return { name, url: second, description: rest.join(" | ") };
    });
}
export function formatProjects(projects: Project[]): string {
  return projects
    .map((p) => [p.name, p.url, p.description].filter((x, i) => x || i === 0).join(" | "))
    .join("\n");
}

function hostLabel(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u.slice(0, 60);
  }
}

// ---- queries --------------------------------------------------------------

type Row = Record<string, unknown>;

function toProfile(r: Row): Profile {
  return {
    handle: r.handle as string,
    github_id: r.github_id as number,
    published: r.published === 1,
    name: r.name as string,
    avatar_url: r.avatar_url as string,
    headline: r.headline as string,
    location: r.location as string,
    bio: r.bio as string,
    now: r.now as string,
    about: r.about as string,
    contact: r.contact as string,
    links: safeJson(r.links as string),
    projects: safeJson(r.projects as string),
    has_key: !!r.key_hash,
    calls_total: (r.calls_total as number) ?? 0,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function safeJson<T>(s: string): T[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function getProfile(db: D1Database, handle: string): Promise<Profile | null> {
  const r = await db.prepare("SELECT * FROM profiles WHERE handle = ?").bind(handle.toLowerCase()).first();
  return r ? toProfile(r) : null;
}

export async function getPublishedProfile(db: D1Database, handle: string): Promise<Profile | null> {
  const p = await getProfile(db, handle);
  return p && p.published ? p : null;
}

export async function getProfileByGithubId(db: D1Database, id: number): Promise<Profile | null> {
  const r = await db.prepare("SELECT * FROM profiles WHERE github_id = ?").bind(id).first();
  return r ? toProfile(r) : null;
}

/** Creates an unpublished draft from GitHub data on first sign-in. */
export async function createDraft(
  db: D1Database,
  d: { handle: string; github_id: number; name: string; avatar_url: string; bio: string; location: string; links: Link[]; projects: Project[] },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO profiles (handle, github_id, name, avatar_url, headline, location, bio, links, projects)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(handle) DO NOTHING`,
    )
    .bind(
      d.handle,
      d.github_id,
      cleanLine(d.name).slice(0, LIMITS.name),
      d.avatar_url,
      cleanLine(d.bio).slice(0, LIMITS.headline),
      cleanLine(d.location).slice(0, LIMITS.location),
      "",
      // GitHub-provided text is as untrusted as anything typed in the editor.
      JSON.stringify(
        d.links.slice(0, LIMITS.links).map((l) => ({ label: cleanLine(l.label).slice(0, 60), url: l.url })),
      ),
      JSON.stringify(
        d.projects
          .slice(0, LIMITS.projects)
          .map((r) => ({ name: cleanLine(r.name).slice(0, 80), url: r.url, description: cleanLine(r.description).slice(0, 300) })),
      ),
    )
    .run();
}

export async function saveProfile(db: D1Database, handle: string, p: Partial<ProfileInput>, publish?: boolean): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["name", "headline", "location", "bio", "now", "about", "contact"] as const) {
    if (p[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(p[k]);
    }
  }
  if (p.links !== undefined) {
    sets.push("links = ?");
    vals.push(JSON.stringify(p.links));
  }
  if (p.projects !== undefined) {
    sets.push("projects = ?");
    vals.push(JSON.stringify(p.projects));
  }
  if (publish !== undefined) {
    sets.push("published = ?");
    vals.push(publish ? 1 : 0);
  }
  sets.push("updated_at = datetime('now')");
  await db
    .prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE handle = ?`)
    .bind(...vals, handle)
    .run();
}

export async function setKeyHash(db: D1Database, handle: string, hash: string): Promise<void> {
  await db.prepare("UPDATE profiles SET key_hash = ? WHERE handle = ?").bind(hash, handle).run();
}

export async function handleForKeyHash(db: D1Database, hash: string): Promise<string | null> {
  const r = await db.prepare("SELECT handle FROM profiles WHERE key_hash = ?").bind(hash).first<{ handle: string }>();
  return r?.handle ?? null;
}

export async function deleteProfile(db: D1Database, handle: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM profiles WHERE handle = ?").bind(handle),
    db.prepare("DELETE FROM call_daily WHERE handle = ?").bind(handle),
    db.prepare("DELETE FROM call_clients WHERE handle = ?").bind(handle),
  ]);
}

// ---- stats ----------------------------------------------------------------

export function clientFromUserAgent(ua: string | null): string {
  const s = (ua ?? "").toLowerCase();
  if (s.includes("claude")) return "Claude";
  if (s.includes("openai") || s.includes("chatgpt")) return "ChatGPT";
  if (s.includes("cursor")) return "Cursor";
  if (s.includes("vscode") || s.includes("visual studio code") || s.includes("copilot")) return "VS Code";
  if (s.includes("windsurf") || s.includes("codeium")) return "Windsurf";
  if (s.includes("gemini") || s.includes("google")) return "Gemini";
  return "Other";
}

export async function recordCall(db: D1Database, handle: string, client: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await db.batch([
    db.prepare("UPDATE profiles SET calls_total = calls_total + 1 WHERE handle = ?").bind(handle),
    db
      .prepare(
        "INSERT INTO call_daily (handle, day, count) VALUES (?, ?, 1) ON CONFLICT(handle, day) DO UPDATE SET count = count + 1",
      )
      .bind(handle, day),
    db
      .prepare(
        "INSERT INTO call_clients (handle, client, count) VALUES (?, ?, 1) ON CONFLICT(handle, client) DO UPDATE SET count = count + 1",
      )
      .bind(handle, client),
  ]);
}

export interface Stats {
  total: number;
  week: number;
  clients: { client: string; count: number }[];
}

export async function getStats(db: D1Database, handle: string, total: number): Promise<Stats> {
  const since = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
  const [week, clients] = await db.batch<Row>([
    db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM call_daily WHERE handle = ? AND day >= ?").bind(handle, since),
    db.prepare("SELECT client, count FROM call_clients WHERE handle = ? ORDER BY count DESC").bind(handle),
  ]);
  return {
    total,
    week: (week.results[0]?.n as number) ?? 0,
    clients: clients.results as unknown as Stats["clients"],
  };
}

export interface LeaderRow {
  handle: string;
  name: string;
  avatar_url: string;
  headline: string;
  week: number;
}

export async function leaderboard(db: D1Database, limit = 10): Promise<LeaderRow[]> {
  const since = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT p.handle, p.name, p.avatar_url, p.headline, SUM(d.count) AS week
       FROM call_daily d JOIN profiles p ON p.handle = d.handle
       WHERE d.day >= ? AND p.published = 1
       GROUP BY p.handle ORDER BY week DESC LIMIT ?`,
    )
    .bind(since, limit)
    .all<LeaderRow>();
  return results;
}

export async function newest(db: D1Database, limit = 8): Promise<LeaderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT handle, name, avatar_url, headline, 0 AS week FROM profiles
       WHERE published = 1 ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<LeaderRow>();
  return results;
}

/** Cheap people search for the network server: LIKE over a few columns. */
export async function searchPeople(db: D1Database, query: string, limit = 10): Promise<Profile[]> {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1).slice(0, 5);
  if (!terms.length) return [];
  const where = terms
    .map(() => "(lower(handle || ' ' || name || ' ' || headline || ' ' || bio || ' ' || now || ' ' || location) LIKE ?)")
    .join(" AND ");
  const { results } = await db
    .prepare(`SELECT * FROM profiles WHERE published = 1 AND ${where} ORDER BY calls_total DESC LIMIT ?`)
    .bind(...terms.map((t) => `%${t.replace(/[%_]/g, "")}%`), limit)
    .all();
  return results.map(toProfile);
}
