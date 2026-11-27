import type { Env } from "./env";
import {
  CUSTOM_GETS,
  CUSTOM_SOURCE_CAP,
  CUSTOM_SUBREQUESTS,
  fetchCustomSource,
  isCustomKind,
  KIND_NAME,
  newSourceId,
  normalizeTarget,
  type CustomFetch,
} from "./custom-sources";
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
 * Profiles refreshed per cron run. The cron runs every 5 minutes, so one profile per run is ~288 refreshes/day.
 * Owner-added sources can spend 6 x 4 subrequests on top of the GitHub path (about 9 normally, about 21 if every
 * redirect hop is used). Two profiles would clear the free plan's 50-subrequest cap, so the batch stays at 1.
 * A run never exceeds RUN_SUBREQUEST_BUDGET; if the GitHub path uses its worst case, the last custom source waits
 * for the next daily refresh. Common case (9 + 24) fits all six.
 */
export const REFRESH_BATCH = 1;
/** Hard stop for the whole run, below the 50-subrequest limit, in case redirects add hops. */
export const RUN_SUBREQUEST_BUDGET = 44;
const PER_PROFILE_MIN_BUDGET = 9;

export interface ActivityRow {
  source: string;
  kind: string;
  title: string;
  url: string;
  ts: string;
  /** Set for an owner-added source (feed, website, hn, devto, npm). */
  custom_kind?: string;
  /** Owner-added source that does not link back to this person. */
  unverified?: boolean;
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
  const n = Math.max(1, Math.min(limit, KEEP_TOTAL));
  const map = (r: { source: string; kind: string; title: string; url: string; ts: string; custom_kind?: string | null; custom_verified?: number | null }): ActivityRow => ({
    source: r.source,
    kind: r.kind,
    title: r.title,
    url: r.url,
    ts: r.ts,
    ...(r.custom_kind ? { custom_kind: r.custom_kind, unverified: r.custom_verified !== 1 } : {}),
  });
  try {
    const { results } = await db
      .prepare(
        `SELECT a.source, a.kind, a.title, a.url, a.ts, c.kind AS custom_kind, c.verified AS custom_verified
         FROM activity a LEFT JOIN custom_sources c ON c.handle = a.handle AND a.source = ('c:' || c.id)
         WHERE a.handle = ? ORDER BY a.ts DESC LIMIT ?`,
      )
      .bind(handle, n)
      .all<{ source: string; kind: string; title: string; url: string; ts: string; custom_kind: string | null; custom_verified: number | null }>();
    return results.map(map);
  } catch {
    try {
      const { results } = await db
        .prepare("SELECT source, kind, title, url, ts FROM activity WHERE handle = ? ORDER BY ts DESC LIMIT ?")
        .bind(handle, n)
        .all<ActivityRow>();
      return results;
    } catch {
      return [];
    }
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

export interface CustomSourceRow {
  id: string;
  kind: string;
  target: string;
  label: string;
  summary: string;
  verified: boolean;
  enabled: boolean;
  failures: number;
  last_fetched: string | null;
}

export async function listCustomSources(db: D1Database, handle: string): Promise<CustomSourceRow[]> {
  try {
    const { results } = await db
      .prepare("SELECT id, kind, target, label, summary, verified, enabled, failures, last_fetched FROM custom_sources WHERE handle = ? ORDER BY rowid")
      .bind(handle)
      .all<{ id: string; kind: string; target: string; label: string; summary: string; verified: number; enabled: number; failures: number; last_fetched: string | null }>();
    return results.map((r) => ({ ...r, verified: r.verified === 1, enabled: r.enabled === 1 }));
  } catch {
    return [];
  }
}

/** Compact source list for get_profile, plus the personal-site summary when one was stored. */
export function describeSources(builtin: SourceRow[], custom: CustomSourceRow[]): { sources: string; website?: { text: string; unverified: boolean } } {
  const parts: string[] = [];
  for (const s of builtin) {
    if (!s.enabled || s.failures < 0) continue;
    parts.push(s.source);
  }
  let website: { text: string; unverified: boolean } | undefined;
  for (const c of custom) {
    if (!c.enabled) continue;
    const name = KIND_NAME[c.kind as keyof typeof KIND_NAME] ?? c.kind;
    parts.push(c.verified ? name : `${name} (unverified)`);
    if (!website && c.kind === "website" && c.summary) website = { text: c.summary, unverified: !c.verified };
  }
  return { sources: parts.join(", "), website };
}

export async function removeCustomSource(db: D1Database, handle: string, id: string): Promise<void> {
  if (!/^[0-9a-f]{8}$/.test(id)) return;
  await db.batch([
    db.prepare("DELETE FROM custom_sources WHERE handle = ? AND id = ?").bind(handle, id),
    db.prepare("DELETE FROM activity WHERE handle = ? AND source = ?").bind(handle, `c:${id}`),
  ]);
}

export type AddSourceResult = { ok: true; verified: boolean } | { ok: false; error: "bad" | "limit" };

/** Validates, stores and fetches one owner-added source. Re-adding the same target re-enables it. */
export async function addCustomSource(
  env: Pick<Env, "DB" | "PUBLIC_URL">,
  handle: string,
  kindRaw: string,
  targetRaw: string,
  deps: RefreshDeps = {},
): Promise<AddSourceResult> {
  const norm = normalizeTarget(kindRaw, targetRaw);
  if (!norm) return { ok: false, error: "bad" };
  const db = env.DB;
  const existing = await db
    .prepare("SELECT id FROM custom_sources WHERE handle = ? AND kind = ? AND target = ?")
    .bind(handle, norm.kind, norm.target)
    .first<{ id: string }>();
  if (!existing) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM custom_sources WHERE handle = ?").bind(handle).first<{ n: number }>();
    if ((n?.n ?? 0) >= CUSTOM_SOURCE_CAP) return { ok: false, error: "limit" };
  }
  const id = existing?.id ?? newSourceId();
  await db
    .prepare(
      `INSERT INTO custom_sources (handle, id, kind, target) VALUES (?, ?, ?, ?)
       ON CONFLICT(handle, kind, target) DO UPDATE SET enabled = 1, failures = 0`,
    )
    .bind(handle, id, norm.kind, norm.target)
    .run();
  const now = deps.now ?? Date.now();
  const f = deps.fetcher ?? new Fetcher(8, deps.fetch);
  let got: CustomFetch | null = null;
  try {
    got = await fetchCustomSource(f, { id, kind: norm.kind, target: norm.target, verified: false }, { login: handle, pageUrl: env.PUBLIC_URL.replace(/\/+$/, "") + `/${handle}`, now, maxGets: 3 });
  } catch {
    got = null;
  }
  const stmts: D1PreparedStatement[] = [
    got
      ? db
          .prepare("UPDATE custom_sources SET label = ?, summary = ?, verified = ?, failures = 0, last_fetched = ?, enabled = 1 WHERE handle = ? AND id = ?")
          .bind(got.label, got.summary, got.verified ? 1 : 0, iso(now), handle, id)
      : db.prepare("UPDATE custom_sources SET failures = 1 WHERE handle = ? AND id = ?").bind(handle, id),
  ];
  if (got) {
    const { results } = await db.prepare("SELECT source, kind, title, url, ts FROM activity WHERE handle = ?").bind(handle).all<ActivityRow>();
    const { upserts, deletes } = planWrites(results, got.items);
    for (const r of upserts) {
      stmts.push(
        db
          .prepare("INSERT INTO activity (handle, source, kind, title, url, ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(handle, source, url) DO UPDATE SET kind = excluded.kind, title = excluded.title, ts = excluded.ts")
          .bind(handle, r.source, r.kind, r.title, r.url, r.ts),
      );
    }
    for (const r of deletes) stmts.push(db.prepare("DELETE FROM activity WHERE handle = ? AND source = ? AND url = ?").bind(handle, r.source, r.url));
  }
  await db.batch(stmts);
  return { ok: true, verified: !!got?.verified };
}

/**
 * Refreshes enabled owner-added sources until the shared subrequest budget runs out (stalest first).
 * A failed source keeps its rows and counts toward auto-disable. Returns the items to merge.
 */
async function refreshCustomSources(
  db: D1Database,
  handle: string,
  pageUrl: string,
  f: Fetcher,
  now: number,
  stmts: D1PreparedStatement[],
  dropped: Set<string>,
): Promise<ActivityItem[]> {
  const rows = (await listCustomSources(db, handle))
    .filter((r) => r.enabled && isCustomKind(r.kind))
    .sort((a, b) => ((a.last_fetched ?? "") < (b.last_fetched ?? "") ? -1 : 1));
  const items: ActivityItem[] = [];
  for (const row of rows) {
    if (f.remaining < 2 || !isCustomKind(row.kind)) break;
    const key = `c:${row.id}`;
    let got: CustomFetch | null = null;
    try {
      got = await fetchCustomSource(f, { id: row.id, kind: row.kind, target: row.target, verified: row.verified }, { login: handle, pageUrl, now, maxGets: CUSTOM_GETS });
    } catch {
      got = null;
    }
    if (!got) {
      const fails = row.failures + 1;
      const disable = fails >= SOURCE_DISABLE_AFTER;
      stmts.push(db.prepare("UPDATE custom_sources SET failures = ?, enabled = ? WHERE handle = ? AND id = ?").bind(fails, disable ? 0 : row.enabled ? 1 : 0, handle, row.id));
      if (disable) {
        dropped.add(key);
        stmts.push(db.prepare("DELETE FROM activity WHERE handle = ? AND source = ?").bind(handle, key));
      }
      continue;
    }
    stmts.push(
      db
        .prepare("UPDATE custom_sources SET label = ?, summary = ?, verified = ?, failures = 0, last_fetched = ? WHERE handle = ? AND id = ?")
        .bind(got.label, got.summary, got.verified ? 1 : 0, iso(now), handle, row.id),
    );
    items.push(...got.items);
  }
  return items;
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
  env: Pick<Env, "DB" | "PUBLIC_URL" | "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET">,
  handle: string,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const db = env.DB;
  const now = deps.now ?? Date.now();
  const f = deps.fetcher ?? new Fetcher(PER_PROFILE_MIN_BUDGET + 3 + CUSTOM_SOURCE_CAP * CUSTOM_SUBREQUESTS, deps.fetch);
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

  const githubItems = SOURCE_IDS.flatMap((id) => (vouched.has(id) && !skip.has(id) ? (got.items[id] ?? []) : []));
  // Rows of sources GitHub no longer lists were deleted above; leave them out of the merge.
  // Custom sources (`c:…`) are not "known" here: only GitHub's own list can drop a built-in source.
  const isKnown = (id: string) => id === "github" || id === "blog" || (got.socialKnown && (id === "bluesky" || id === "mastodon"));
  const dropped = new Set<string>();
  let customItems: ActivityItem[] = [];
  try {
    customItems = await refreshCustomSources(db, handle, env.PUBLIC_URL.replace(/\/+$/, "") + `/${handle}`, f, now, stmts, dropped);
  } catch (e) {
    console.error(`custom source refresh failed for ${handle}`, e);
  }
  const fetched = [...githubItems, ...customItems];
  const existing = actRows.filter((r) => !autoDisabled.has(r.source as SourceId) && !dropped.has(r.source) && (vouched.has(r.source as SourceId) || !isKnown(r.source)));
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
