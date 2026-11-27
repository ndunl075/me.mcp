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

// Strip control chars (except newline/tab) and trim. Everything is still treated as untrusted on output.
const clean = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "").trim())
    .pipe(z.string().max(max));

const httpUrl = z
  .string()
  .trim()
  .max(300)
  .refine((u) => {
    try {
      const p = new URL(u).protocol;
      return p === "https:" || p === "http:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

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
  name: clean(LIMITS.name),
  headline: clean(LIMITS.headline),
  location: clean(LIMITS.location),
  bio: clean(LIMITS.bio),
  now: clean(LIMITS.now),
  about: clean(LIMITS.about),
  contact: clean(LIMITS.contact),
  links: z.array(z.object({ label: clean(60), url: httpUrl })).max(LIMITS.links),
  projects: z
    .array(z.object({ name: clean(80), url: z.union([httpUrl, z.literal("")]), description: clean(300) }))
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
      d.name.slice(0, LIMITS.name),
      d.avatar_url,
      d.bio.slice(0, LIMITS.headline),
      d.location.slice(0, LIMITS.location),
      "",
      JSON.stringify(d.links.slice(0, LIMITS.links)),
      JSON.stringify(d.projects.slice(0, LIMITS.projects)),
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
