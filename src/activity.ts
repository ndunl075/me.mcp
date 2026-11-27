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
/** First retry after a failed refresh; doubles with each consecutive failure up to RETRY_MAX_MS. */
export const RETRY_AFTER_MS = 3 * 3600_000;
export const RETRY_MAX_MS = 7 * 86400_000;
/** A blog / Bluesky / Mastodon source that fails this many refreshes in a row is switched off (the owner can re-enable it). */
export const SOURCE_DISABLE_AFTER = 5;

/** Delay before retrying a profile that has failed `failures` times in a row (this attempt included): 3 h, 6 h, 12 h, ... 7 d. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_AFTER_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}
/**
 * Profiles refreshed per cron run. wrangler.jsonc runs the cron every 5 minutes: 288 runs/day x 2 = up to 576 profile
 * refreshes/day (each at most once per 24 h, so capacity is ~576 published profiles; beyond that raise the batch or the
 * frequency). The limit is CPU, not subrequests: a profile costs ~1 ms of CPU once warm and the first one of a fresh
 * isolate ~5 ms (Node measurement of the full fetch/parse/merge path with real API payloads) against 10 ms per
 * invocation, so 2 per run. Subrequests are at most ~9 per profile (3 GitHub + 3 blog + 1 Bluesky + 2 Mastodon).
 * D1: each run reads the profiles table once to pick the stalest, so 288 runs/day is ~288 x (published profiles) rows
 * read, within the 5M/day free allowance up to ~15k profiles.
 */
export const REFRESH_BATCH = 2;
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
  failures: number;
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
      .prepare("SELECT source, enabled, label, last_fetched, failures FROM sources WHERE handle = ? AND failures >= 0 ORDER BY source")
      .bind(handle)
      .all<{ source: SourceId; enabled: number; label: string; last_fetched: string | null; failures: number }>();
    return results.map((r) => ({ ...r, enabled: r.enabled === 1 }));
  } catch {
    return [];
  }
}

/**
 * `failures` value marking a row whose source GitHub no longer lists: a tombstone that keeps an off switch (the owner's
 * or the auto-disable) alive, so the source does not come back switched on if GitHub lists it again. Never shown
 * (listSources skips it); reuses the existing column, so no migration.
 */
const UNLISTED = -1;

/** Owner's on/off switch for one source. Turning one off also removes what it contributed. A tombstoned (unlisted) row is left untouched, so it stays hidden. */
export async function setSourceEnabled(db: D1Database, handle: string, source: SourceId, enabled: boolean): Promise<void> {
  if (!SOURCE_IDS.includes(source)) return;
  const stmts = [
    db
      .prepare("INSERT INTO sources (handle, source, enabled) VALUES (?, ?, ?) ON CONFLICT(handle, source) DO UPDATE SET enabled = excluded.enabled, failures = 0 WHERE sources.failures >= 0")
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
  for (const it of fetched) {
    // A future-dated item was clamped to "now" at fetch time. Clamp once: keep the stored date so it neither shows as
    // "today" forever nor gets rewritten on every refresh.
    const o = merged.get(key(it));
    merged.set(key(it), it.clamped && o ? { ...it, ts: o.ts } : it);
  }
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
  /** Source bookkeeping rows written (excluding the refresh marker). */
  sourceRows: number;
  subrequests: number;
}

/**
 * Fetches fresh activity for one profile from GitHub and whatever it vouches for there, and writes only what
 * changed. Ignores the 24 h rule (callers such as sign-in want an immediate refresh); refreshStaleProfiles applies it.
 *
 * The refresh marker is claimed BEFORE any fetching, as a failure with exponential backoff (retry in 3 h, then 6 h, ...
 * up to 7 days), and set to now with the failure count reset on success. A profile whose refresh fails, throws or is
 * killed mid-way therefore goes to the back of the queue instead of being picked first on every run.
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
  const marker = (ms: number, failures: number) =>
    db
      .prepare(
        "INSERT INTO sources (handle, source, last_fetched, label, failures) VALUES (?, 'github', ?, ?, ?) ON CONFLICT(handle, source) DO UPDATE SET last_fetched = excluded.last_fetched, label = excluded.label, failures = excluded.failures",
      )
      .bind(handle, iso(ms), `@${handle}`, failures);

  const [existingSources, existingActivity] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT source, enabled, label, failures FROM sources WHERE handle = ?").bind(handle),
    db.prepare("SELECT source, kind, title, url, ts FROM activity WHERE handle = ?").bind(handle),
  ]);
  const srcRows = existingSources.results as unknown as { source: SourceId; enabled: number; label: string; failures: number }[];
  const actRows = existingActivity.results as unknown as ActivityRow[];
  const skip = new Set<SourceId>(srcRows.filter((r) => r.enabled === 0).map((r) => r.source));

  // The claim: count this attempt as a failure and schedule the retry with backoff. Success below resets both. If the
  // refresh throws or is killed, the claim stands, so a profile that never succeeds (deleted GitHub user, hostile
  // source) backs off from 3 h up to 7 days instead of occupying a slot every few hours.
  const failures = (srcRows.find((r) => r.source === "github")?.failures ?? 0) + 1;
  await marker(now - REFRESH_EVERY_MS + retryDelayMs(failures), failures).run();

  const got = await fetchProfileSources(f, { auth: githubBasicAuth(env) }, handle, skip, now);
  if (!got.githubOk) return { ok: false, written: 0, deleted: 0, sourceRows: 0, subrequests: f.used - before };

  const stmts: D1PreparedStatement[] = [marker(now, 0)];
  // Per-source bookkeeping, written only when something changed: new source, new label, a change in the failure count,
  // auto-disable, or GitHub no longer lists it.
  const vouched = new Set<SourceId>(["github"]);
  if (got.profile?.blog) vouched.add("blog");
  if (got.socialKnown) {
    if (got.profile?.bluesky) vouched.add("bluesky");
    if (got.profile?.mastodon) vouched.add("mastodon");
  }
  let sourceRows = 0;
  const autoDisabled = new Set<SourceId>();
  for (const id of ["blog", "bluesky", "mastodon"] as const) {
    const known = id === "blog" || got.socialKnown;
    const row = srcRows.find((r) => r.source === id);
    if (vouched.has(id)) {
      const label = got.labels[id] ?? "";
      const ok = !!got.items[id];
      const stored = row?.failures ?? 0;
      const prev = Math.max(0, stored); // a tombstone (UNLISTED) starts again at zero failures, still switched off
      const fails = skip.has(id) ? prev : ok ? 0 : prev + 1;
      const disable = !skip.has(id) && !ok && fails >= SOURCE_DISABLE_AFTER;
      if (!row || row.label !== label || fails !== stored || disable) {
        sourceRows++;
        stmts.push(
          db
            .prepare(
              "INSERT INTO sources (handle, source, label, last_fetched, failures, enabled) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(handle, source) DO UPDATE SET label = excluded.label, failures = excluded.failures, enabled = CASE WHEN excluded.enabled = 0 THEN 0 ELSE enabled END, last_fetched = COALESCE(excluded.last_fetched, last_fetched)",
            )
            .bind(handle, id, label, ok ? iso(now) : null, fails, disable ? 0 : 1),
        );
      }
      if (disable) {
        autoDisabled.add(id);
        if (actRows.some((r) => r.source === id)) stmts.push(db.prepare("DELETE FROM activity WHERE handle = ? AND source = ?").bind(handle, id));
      }
    } else if (known) {
      if (row && row.enabled === 0) {
        // Keep the off switch: mark the row unlisted instead of deleting it.
        if (row.failures !== UNLISTED) {
          sourceRows++;
          stmts.push(db.prepare("UPDATE sources SET failures = ? WHERE handle = ? AND source = ?").bind(UNLISTED, handle, id));
        }
      } else if (row) {
        sourceRows++;
        stmts.push(db.prepare("DELETE FROM sources WHERE handle = ? AND source = ?").bind(handle, id));
      }
      if (actRows.some((r) => r.source === id)) stmts.push(db.prepare("DELETE FROM activity WHERE handle = ? AND source = ?").bind(handle, id));
    }
  }

  const fetched = SOURCE_IDS.flatMap((id) => (vouched.has(id) && !skip.has(id) ? (got.items[id] ?? []) : []));
  // Rows of sources GitHub no longer lists were deleted above; leave them out of the merge.
  const isKnown = (id: SourceId) => id === "github" || id === "blog" || got.socialKnown;
  const existing = actRows.filter((r) => !autoDisabled.has(r.source) && (vouched.has(r.source) || !isKnown(r.source)));
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
  return { ok: true, written: upserts.length, deleted: deletes.length, sourceRows, subrequests: f.used - before };
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
