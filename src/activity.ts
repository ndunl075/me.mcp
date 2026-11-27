import type { Env } from "./env";
import {
  Fetcher,
  SOURCE_IDS,
  fetchProfileSources,
  githubBasicAuth,
  type ActivityItem,
  type SourceId,
} from "./sources";

/** Storage + scheduling for the `activity` and `sources` tables (migrations/0003_activity.sql). */

/** Newest items kept per handle, and the most any single source may hold (so a busy GitHub feed can't crowd out posts). */
export const KEEP_TOTAL = 15;
export const KEEP_PER_SOURCE = 8;
/** A profile is refreshed at most once per this long. */
export const REFRESH_EVERY_MS = 24 * 3600_000;
/** After a failed GitHub fetch, retry sooner than a full day (but not on the very next run). */
export const RETRY_AFTER_MS = 3 * 3600_000;
/**
 * Profiles refreshed per cron run. Each costs at most ~9 subrequests (3 GitHub + 3 blog + 1 Bluesky + 2 Mastodon),
 * so 4 stays well under the free plan's 50. CPU is the other limit (measurements are in the PR).
 */
export const REFRESH_BATCH = 4;
/** Hard stop for the whole run, below the 50-subrequest limit, in case redirects add hops. */
export const RUN_SUBREQUEST_BUDGET = 44;
const PER_PROFILE_MIN_BUDGET = 9;

export interface ActivityRow {
  source: SourceId;
  kind: string;
  title: string;
  url: string;
  ts: string;
}

export interface SourceRow {
  source: SourceId;
  enabled: boolean;
  label: string;
  last_fetched: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

// ---- reads (used by MCP tools and, later, the profile page) ---------------

/** Newest activity first. Returns [] (never throws) if the table is missing, e.g. before migration 0003 is applied. */
export async function listActivity(db: D1Database, handle: string, limit = KEEP_TOTAL): Promise<ActivityRow[]> {
  try {
    const { results } = await db
      .prepare("SELECT source, kind, title, url, ts FROM activity WHERE handle = ? ORDER BY ts DESC LIMIT ?")
      .bind(handle, Math.max(1, Math.min(limit, KEEP_TOTAL)))
      .all<ActivityRow>();
    return results;
  } catch {
    return [];
  }
}

export async function listSources(db: D1Database, handle: string): Promise<SourceRow[]> {
  try {
    const { results } = await db
      .prepare("SELECT source, enabled, label, last_fetched FROM sources WHERE handle = ? ORDER BY source")
      .bind(handle)
      .all<{ source: SourceId; enabled: number; label: string; last_fetched: string | null }>();
    return results.map((r) => ({ ...r, enabled: r.enabled === 1 }));
  } catch {
    return [];
  }
}

/** Owner's on/off switch for one source. Turning one off also removes what it contributed. */
export async function setSourceEnabled(db: D1Database, handle: string, source: SourceId, enabled: boolean): Promise<void> {
  if (!SOURCE_IDS.includes(source)) return;
  const stmts = [
    db
      .prepare("INSERT INTO sources (handle, source, enabled) VALUES (?, ?, ?) ON CONFLICT(handle, source) DO UPDATE SET enabled = excluded.enabled")
      .bind(handle, source, enabled ? 1 : 0),
  ];
  if (!enabled) stmts.push(db.prepare("DELETE FROM activity WHERE handle = ? AND source = ?").bind(handle, source));
  await db.batch(stmts);
}

// ---- merge ----------------------------------------------------------------

/** Newest first, at most `total` overall and `perSource` per source. */
export function selectKeep<T extends { source: string; ts: string }>(items: T[], total = KEEP_TOTAL, perSource = KEEP_PER_SOURCE): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const it of [...items].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))) {
    if (out.length >= total) break;
    const n = counts.get(it.source) ?? 0;
    if (n >= perSource) continue;
    counts.set(it.source, n + 1);
    out.push(it);
  }
  return out;
}

const key = (r: { source: string; url: string }) => `${r.source}\n${r.url}`;

/** What to write to turn `existing` into the kept subset of existing + fetched. Unchanged rows produce nothing. */
export function planWrites(existing: ActivityRow[], fetched: ActivityItem[]) {
  const merged = new Map<string, ActivityRow>(existing.map((r) => [key(r), r]));
  for (const it of fetched) merged.set(key(it), it);
  const final = selectKeep([...merged.values()]);
  const finalKeys = new Set(final.map(key));
  const old = new Map(existing.map((r) => [key(r), r]));
  const upserts = final.filter((r) => {
    const o = old.get(key(r));
    return !o || o.title !== r.title || o.kind !== r.kind || o.ts !== r.ts;
  });
  const deletes = existing.filter((r) => !finalKeys.has(key(r)));
  return { upserts, deletes };
}

// ---- refresh one profile --------------------------------------------------

export interface RefreshDeps {
  fetcher?: Fetcher;
  fetch?: typeof fetch;
  now?: number;
}

export interface RefreshResult {
  ok: boolean;
  written: number;
  deleted: number;
  subrequests: number;
}

/**
 * Fetches fresh activity for one profile from GitHub and whatever it vouches for there, and writes only what
 * changed. Ignores the 24 h rule (callers such as sign-in want an immediate refresh); refreshStaleProfiles applies it.
 */
export async function refreshProfileActivity(
  env: Pick<Env, "DB" | "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET">,
  handle: string,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const db = env.DB;
  const now = deps.now ?? Date.now();
  const f = deps.fetcher ?? new Fetcher(PER_PROFILE_MIN_BUDGET + 3, deps.fetch);
  const before = f.used;

  const [existingSources, existingActivity] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT source, enabled, label, last_fetched FROM sources WHERE handle = ?").bind(handle),
    db.prepare("SELECT source, kind, title, url, ts FROM activity WHERE handle = ?").bind(handle),
  ]);
  const srcRows = existingSources.results as unknown as { source: SourceId; enabled: number; label: string }[];
  const skip = new Set<SourceId>(srcRows.filter((r) => r.enabled === 0).map((r) => r.source));

  const got = await fetchProfileSources(f, { auth: githubBasicAuth(env) }, handle, skip);
  const stmts: D1PreparedStatement[] = [];
  const marker = (ms: number) =>
    db
      .prepare(
        "INSERT INTO sources (handle, source, last_fetched, label) VALUES (?, 'github', ?, ?) ON CONFLICT(handle, source) DO UPDATE SET last_fetched = excluded.last_fetched, label = excluded.label",
      )
      .bind(handle, iso(ms), `@${handle}`);

  if (!got.githubOk) {
    // GitHub unreachable or rate limited: keep everything, retry in a few hours rather than a day.
    await marker(now - (REFRESH_EVERY_MS - RETRY_AFTER_MS)).run();
    return { ok: false, written: 0, deleted: 0, subrequests: f.used - before };
  }

  stmts.push(marker(now));
  // Per-source bookkeeping: label + last_fetched for sources that were fetched, drop sources GitHub no longer lists.
  const vouched = new Set<SourceId>(["github"]);
  if (got.profile?.blog) vouched.add("blog");
  if (got.socialKnown) {
    if (got.profile?.bluesky) vouched.add("bluesky");
    if (got.profile?.mastodon) vouched.add("mastodon");
  }
  for (const id of ["blog", "bluesky", "mastodon"] as const) {
    const known = id === "blog" || got.socialKnown;
    if (vouched.has(id)) {
      stmts.push(
        db
          .prepare(
            "INSERT INTO sources (handle, source, label, last_fetched) VALUES (?, ?, ?, ?) ON CONFLICT(handle, source) DO UPDATE SET label = excluded.label, last_fetched = CASE WHEN ? THEN excluded.last_fetched ELSE last_fetched END",
          )
          .bind(handle, id, got.labels[id] ?? "", iso(now), got.items[id] ? 1 : 0),
      );
    } else if (known) {
      stmts.push(db.prepare("DELETE FROM sources WHERE handle = ? AND source = ?").bind(handle, id));
      stmts.push(db.prepare("DELETE FROM activity WHERE handle = ? AND source = ?").bind(handle, id));
    }
  }

  const fetched = SOURCE_IDS.flatMap((id) => (vouched.has(id) && !skip.has(id) ? (got.items[id] ?? []) : []));
  // Rows of sources GitHub no longer lists were deleted above; leave them out of the merge.
  const isKnown = (id: SourceId) => id === "github" || id === "blog" || got.socialKnown;
  const existing = (existingActivity.results as unknown as ActivityRow[]).filter((r) => vouched.has(r.source) || !isKnown(r.source));
  const { upserts, deletes } = planWrites(existing, fetched);
  for (const r of upserts) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO activity (handle, source, kind, title, url, ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(handle, source, url) DO UPDATE SET kind = excluded.kind, title = excluded.title, ts = excluded.ts",
        )
        .bind(handle, r.source, r.kind, r.title, r.url, r.ts),
    );
  }
  for (const r of deletes) stmts.push(db.prepare("DELETE FROM activity WHERE handle = ? AND source = ? AND url = ?").bind(handle, r.source, r.url));
  await db.batch(stmts);
  return { ok: true, written: upserts.length, deleted: deletes.length, subrequests: f.used - before };
}

// ---- cron -----------------------------------------------------------------

/**
 * Published profiles whose last refresh is older than REFRESH_EVERY_MS (or that were never refreshed), stalest first.
 * The 'github' source row's last_fetched is the profile-level marker.
 */
export async function selectStaleHandles(db: D1Database, now = Date.now(), limit = REFRESH_BATCH): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.handle FROM profiles p
       LEFT JOIN sources s ON s.handle = p.handle AND s.source = 'github'
       WHERE p.published = 1 AND (s.last_fetched IS NULL OR s.last_fetched < ?)
       ORDER BY COALESCE(s.last_fetched, '') ASC, p.created_at ASC
       LIMIT ?`,
    )
    .bind(iso(now - REFRESH_EVERY_MS), limit)
    .all<{ handle: string }>();
  return results.map((r) => r.handle);
}

export interface CronSummary {
  handles: string[];
  subrequests: number;
  written: number;
}

/** One cron run: refresh the stalest few profiles within a shared subrequest budget. Never throws. */
export async function refreshStaleProfiles(env: Env, deps: RefreshDeps & { batch?: number } = {}): Promise<CronSummary> {
  const now = deps.now ?? Date.now();
  const f = new Fetcher(RUN_SUBREQUEST_BUDGET, deps.fetch);
  const summary: CronSummary = { handles: [], subrequests: 0, written: 0 };
  let handles: string[];
  try {
    handles = await selectStaleHandles(env.DB, now, deps.batch ?? REFRESH_BATCH);
  } catch {
    return summary; // e.g. migration 0003 not applied yet
  }
  for (const handle of handles) {
    if (f.remaining < PER_PROFILE_MIN_BUDGET) break;
    try {
      const r = await refreshProfileActivity(env, handle, { fetcher: f, now });
      summary.written += r.written + r.deleted;
    } catch (e) {
      console.error(`activity refresh failed for ${handle}`, e);
    }
    summary.handles.push(handle);
  }
  summary.subrequests = f.used;
  return summary;
}
