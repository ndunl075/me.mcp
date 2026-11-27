import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker";
import {
  KEEP_PER_SOURCE,
  KEEP_TOTAL,
  REFRESH_BATCH,
  REFRESH_EVERY_MS,
  SOURCE_DISABLE_AFTER,
  retryDelayMs,
  listActivity,
  listSources,
  planWrites,
  refreshProfileActivity,
  refreshStaleProfiles,
  selectKeep,
  selectStaleHandles,
  setSourceEnabled,
} from "../src/activity";
import { Fetcher } from "../src/sources";
import { deleteProfile } from "../src/db";
import { NOW, json, zoeFetch } from "./fixtures";
import { NOTE_PREFIX, publish, signIn, tool } from "./helpers";

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
const item = (source: string, n: number, ts = `2026-11-${String(10 + n).padStart(2, "0")}T00:00:00Z`) => ({ source, kind: "post", title: `t${n}`, url: `https://x.example/${source}/${n}`, ts });

async function makeProfile(login: string, id: number, published = 1, created = "2026-01-01 00:00:00") {
  await env.DB.prepare("INSERT INTO profiles (handle, github_id, published, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(login, id, published, created).run();
}
const markFetched = (handle: string, ts: string | null) =>
  env.DB.prepare("INSERT INTO sources (handle, source, last_fetched) VALUES (?, 'github', ?) ON CONFLICT(handle, source) DO UPDATE SET last_fetched = excluded.last_fetched").bind(handle, ts).run();

afterEach(() => vi.restoreAllMocks());

describe("retention", () => {
  it("keeps the newest 15 overall and at most 8 per source", () => {
    const many = [...Array.from({ length: 20 }, (_, i) => item("github", i)), ...Array.from({ length: 3 }, (_, i) => item("blog", i, `2026-10-0${i + 1}T00:00:00Z`))];
    const kept = selectKeep(many);
    expect(kept).toHaveLength(11); // 8 github + 3 blog
    expect(kept.filter((k) => k.source === "github")).toHaveLength(KEEP_PER_SOURCE);
    expect(kept.filter((k) => k.source === "blog")).toHaveLength(3);
    expect([...kept].sort((a, b) => (a.ts < b.ts ? 1 : -1))).toEqual(kept);
    const lots = ["github", "blog", "bluesky"].flatMap((s) => Array.from({ length: 8 }, (_, i) => item(s, i)));
    expect(selectKeep(lots)).toHaveLength(KEEP_TOTAL);
  });

  it("planWrites emits nothing for unchanged rows, and only the changed/new/dropped ones otherwise", () => {
    const existing = [item("blog", 1), item("blog", 2)] as any[];
    expect(planWrites(existing, existing.map((e) => ({ ...e })))).toEqual({ upserts: [], deletes: [] });
    const changed = planWrites(existing, [{ ...existing[0], title: "edited" }, item("blog", 3)] as any[]);
    expect(changed.upserts.map((u) => u.title).sort()).toEqual(["edited", "t3"]);
    expect(changed.deletes).toEqual([]);
    const crowded = planWrites([item("github", 0, "2000-01-01T00:00:00Z")] as any[], Array.from({ length: 8 }, (_, i) => item("github", i + 1)) as any[]);
    expect(crowded.deletes.map((d) => d.title)).toEqual(["t0"]);
  });
});

describe("refreshProfileActivity", () => {
  beforeAll(() => makeProfile("zoe", 9001));

  it("stores normalized items and the sources GitHub lists", async () => {
    const { fn } = zoeFetch();
    const r = await refreshProfileActivity(env, "zoe", { fetch: fn, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.subrequests).toBeLessThanOrEqual(9);

    const rows = await listActivity(env.DB, "zoe");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.map((x) => x.source).sort().filter((v, i, a) => a.indexOf(v) === i)).toEqual(["blog", "bluesky", "github", "mastodon"]);
    expect([...rows].sort((a, b) => (a.ts < b.ts ? 1 : -1))).toEqual(rows);
    for (const x of rows) {
      expect(x.url).toMatch(/^https:\/\//);
      expect(x.title.length).toBeLessThanOrEqual(200);
      expect(x.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
    const srcs = await listSources(env.DB, "zoe");
    expect(srcs.map((s) => s.source)).toEqual(["blog", "bluesky", "github", "mastodon"]);
    expect(srcs.find((s) => s.source === "mastodon")).toMatchObject({ enabled: true, label: "@zoe@hachyderm.example", last_fetched: iso(NOW) });
  });

  it("a second refresh with identical data writes nothing", async () => {
    const { fn } = zoeFetch();
    const r = await refreshProfileActivity(env, "zoe", { fetch: fn, now: NOW + 1000 });
    expect(r).toMatchObject({ ok: true, written: 0, deleted: 0, sourceRows: 0 }); // no source bookkeeping rewritten either
  });

  it("a changed item is the only write", async () => {
    const { fn } = zoeFetch({ "https://public.api.bsky.app/": () => json({ feed: [{ post: { uri: "at://x/app.bsky.feed.post/3kpost1", author: { handle: "zoe.example.com" }, record: { text: "Edited post", createdAt: "2026-11-25T20:00:00.000Z" } } }] }) });
    const r = await refreshProfileActivity(env, "zoe", { fetch: fn, now: NOW });
    expect(r).toMatchObject({ written: 1, deleted: 0 });
    expect((await listActivity(env.DB, "zoe")).find((x) => x.source === "bluesky")!.title).toBe("Edited post");
  });

  it("a failing source keeps its stored rows; a source GitHub stops listing is removed", async () => {
    const down = zoeFetch({ "https://hachyderm.example/": () => new Response("boom", { status: 500 }) });
    await refreshProfileActivity(env, "zoe", { fetch: down.fn, now: NOW });
    expect((await listActivity(env.DB, "zoe")).some((x) => x.source === "mastodon")).toBe(true);

    const noMasto = zoeFetch({ "https://api.github.com/users/zoe/social_accounts": () => json([{ provider: "bluesky", url: "https://bsky.app/profile/zoe.example.com" }]) });
    await refreshProfileActivity(env, "zoe", { fetch: noMasto.fn, now: NOW });
    expect((await listActivity(env.DB, "zoe")).some((x) => x.source === "mastodon")).toBe(false);
    expect((await listSources(env.DB, "zoe")).some((s) => s.source === "mastodon")).toBe(false);
  });

  it("if social_accounts itself fails, Bluesky/Mastodon rows are left alone", async () => {
    const f = zoeFetch();
    await refreshProfileActivity(env, "zoe", { fetch: f.fn, now: NOW }); // restores mastodon
    const before = (await listActivity(env.DB, "zoe")).length;
    const flaky = zoeFetch({ "https://api.github.com/users/zoe/social_accounts": () => new Response("x", { status: 502 }) });
    await refreshProfileActivity(env, "zoe", { fetch: flaky.fn, now: NOW });
    expect((await listActivity(env.DB, "zoe")).length).toBe(before);
    expect((await listSources(env.DB, "zoe")).map((s) => s.source)).toContain("mastodon");
  });

  it("GitHub down: nothing changes and the retry comes sooner than 24 h", async () => {
    const before = await listActivity(env.DB, "zoe");
    const down = zoeFetch({ "https://api.github.com/": () => json({ message: "rate limited" }, 403) });
    const r = await refreshProfileActivity(env, "zoe", { fetch: down.fn, now: NOW });
    expect(r.ok).toBe(false);
    expect(await listActivity(env.DB, "zoe")).toEqual(before);
    const gh = (await listSources(env.DB, "zoe")).find((s) => s.source === "github")!;
    const age = NOW - Date.parse(gh.last_fetched!);
    expect(age).toBeGreaterThan(REFRESH_EVERY_MS - 6 * 3600_000);
    expect(age).toBeLessThan(REFRESH_EVERY_MS);
  });

  it("a disabled source is not fetched and its rows are removed; re-enabling brings it back", async () => {
    await setSourceEnabled(env.DB, "zoe", "blog", false);
    expect((await listActivity(env.DB, "zoe")).some((x) => x.source === "blog")).toBe(false);
    const f = zoeFetch();
    await refreshProfileActivity(env, "zoe", { fetch: f.fn, now: NOW });
    expect(f.calls.some((c) => c.url.includes("blog.zoe.example"))).toBe(false);
    expect((await listSources(env.DB, "zoe")).find((s) => s.source === "blog")!.enabled).toBe(false);
    await setSourceEnabled(env.DB, "zoe", "blog", true);
    // Turning it back on clears the profile refresh marker, so the page fetches now instead of waiting out 24 h.
    expect((await listSources(env.DB, "zoe")).find((s) => s.source === "github")!.last_fetched).toBeNull();
    await refreshProfileActivity(env, "zoe", { fetch: zoeFetch().fn, now: NOW });
    expect((await listActivity(env.DB, "zoe")).some((x) => x.source === "blog")).toBe(true);
  });

  it("a disabled source GitHub stops listing keeps its off switch (hidden tombstone); relisting does not re-enable it", async () => {
    await makeProfile("tomb", 9400);
    const social = (providers: { provider: string; url: string }[]) =>
      zoeFetch({
        "https://api.github.com/users/tomb/events": () => json([]),
        "https://api.github.com/users/tomb/social": () => json(providers),
        "https://api.github.com/users/tomb": () => json({ blog: "" }),
      }).fn;
    const bsky = [{ provider: "bluesky", url: "https://bsky.app/profile/tomb.example.com" }];
    const raw = () => env.DB.prepare("SELECT enabled, failures FROM sources WHERE handle = 'tomb' AND source = 'bluesky'").first<{ enabled: number; failures: number }>();

    await refreshProfileActivity(env, "tomb", { fetch: social(bsky), now: NOW });
    expect((await listSources(env.DB, "tomb")).find((s) => s.source === "bluesky")?.enabled).toBe(true);
    await setSourceEnabled(env.DB, "tomb", "bluesky", false);

    // GitHub stops listing it: hidden from the owner's list, but the off switch is still stored.
    await refreshProfileActivity(env, "tomb", { fetch: social([]), now: NOW + 1 });
    expect((await listSources(env.DB, "tomb")).some((s) => s.source === "bluesky")).toBe(false);
    expect(await raw()).toEqual({ enabled: 0, failures: -1 });
    const again = await refreshProfileActivity(env, "tomb", { fetch: social([]), now: NOW + 2 });
    expect(again.sourceRows).toBe(0); // nothing to rewrite while it stays unlisted

    // Listed again: still off, not fetched, and shown (off) again with a clean failure count.
    const f = zoeFetch({
      "https://api.github.com/users/tomb/events": () => json([]),
      "https://api.github.com/users/tomb/social": () => json(bsky),
      "https://api.github.com/users/tomb": () => json({ blog: "" }),
    });
    await refreshProfileActivity(env, "tomb", { fetch: f.fn, now: NOW + 3 });
    expect(f.calls.some((c) => c.url.includes("bsky"))).toBe(false);
    expect((await listSources(env.DB, "tomb")).find((s) => s.source === "bluesky")).toMatchObject({ enabled: false, failures: 0 });
    expect((await listActivity(env.DB, "tomb")).some((x) => x.source === "bluesky")).toBe(false);

    // Unlisted again; the owner API cannot un-hide or re-enable a tombstone.
    await refreshProfileActivity(env, "tomb", { fetch: social([]), now: NOW + 4 });
    await setSourceEnabled(env.DB, "tomb", "bluesky", true);
    expect(await raw()).toEqual({ enabled: 0, failures: -1 });
    expect((await listSources(env.DB, "tomb")).some((s) => s.source === "bluesky")).toBe(false);

    // Listed and enabled by the owner, then dropped by GitHub: an enabled source is simply deleted (nothing to preserve).
    await refreshProfileActivity(env, "tomb", { fetch: social(bsky), now: NOW + 5 });
    await setSourceEnabled(env.DB, "tomb", "bluesky", true);
    expect((await listSources(env.DB, "tomb")).find((s) => s.source === "bluesky")?.enabled).toBe(true);
    await refreshProfileActivity(env, "tomb", { fetch: social([]), now: NOW + 6 });
    expect(await raw()).toBeNull();
  });

  it("an auto-disabled source that GitHub drops and re-lists stays disabled", async () => {
    await makeProfile("tomb2", 9401);
    const mk = (listed: boolean) => zoeFetch({
      "https://api.github.com/users/tomb2/events": () => json([]),
      "https://api.github.com/users/tomb2/social": () => json(listed ? [{ provider: "bluesky", url: "https://bsky.app/profile/tomb2.example.com" }] : []),
      "https://api.github.com/users/tomb2": () => json({ blog: "" }),
      "https://public.api.bsky.app/": () => new Response("down", { status: 500 }),
    }).fn;
    for (let i = 1; i <= SOURCE_DISABLE_AFTER; i++) await refreshProfileActivity(env, "tomb2", { fetch: mk(true), now: NOW + i });
    expect((await listSources(env.DB, "tomb2")).find((s) => s.source === "bluesky")?.enabled).toBe(false);
    await refreshProfileActivity(env, "tomb2", { fetch: mk(false), now: NOW + 50 });
    await refreshProfileActivity(env, "tomb2", { fetch: mk(true), now: NOW + 51 });
    expect((await listSources(env.DB, "tomb2")).find((s) => s.source === "bluesky")).toMatchObject({ enabled: false, failures: 0 });
  });

  it("sends the OAuth app's Basic credentials to GitHub only", async () => {
    const f = zoeFetch();
    await refreshProfileActivity({ ...env, GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csecret" }, "zoe", { fetch: f.fn, now: NOW });
    const want = "Basic " + btoa("cid:csecret");
    for (const c of f.calls) expect(c.auth, c.url).toBe(new URL(c.url).hostname === "api.github.com" ? want : null);
  });

  it("deleteProfile removes activity and sources", async () => {
    await makeProfile("tmpuser", 9100);
    await refreshProfileActivity(env, "tmpuser", { fetch: zoeFetch({
      "https://api.github.com/users/tmpuser/events": () => json([{ type: "WatchEvent", created_at: "2026-11-20T00:00:00Z", repo: { name: "a/b" }, payload: {} }]),
      "https://api.github.com/users/tmpuser/social": () => json([]),
      "https://api.github.com/users/tmpuser": () => json({ blog: "" }),
    }).fn, now: NOW });
    expect((await listActivity(env.DB, "tmpuser")).length).toBe(1);
    await deleteProfile(env.DB, "tmpuser");
    expect(await listActivity(env.DB, "tmpuser")).toEqual([]);
    expect(await listSources(env.DB, "tmpuser")).toEqual([]);
  });
});

describe("backoff and auto-disable", () => {
  const H = 3600_000;
  const down = () => zoeFetch({ "https://api.github.com/": () => json({ message: "Not Found" }, 404) }).fn;

  it("a profile that keeps failing is retried after 3 h, 6 h, 12 h, 24 h ... capped at 7 days; success resets", async () => {
    await makeProfile("ghost", 9700, 1, "1998-01-01 00:00:00");
    let now = NOW;
    const due = async (at: number) => (await selectStaleHandles(env.DB, at, 500)).includes("ghost");
    const expectDelays = [3, 6, 12, 24, 48, 96, 168, 168];
    for (const h of expectDelays) {
      await refreshProfileActivity(env, "ghost", { fetch: down(), now });
      expect(await due(now + h * H - 1000), `not due ${h}h-1s after`).toBe(false);
      expect(await due(now + h * H + 1000), `due ${h}h after`).toBe(true);
      now += h * H + 1000;
    }
    const src = (await listSources(env.DB, "ghost")).find((s) => s.source === "github")!;
    expect(src.failures).toBe(expectDelays.length);
    // GitHub comes back: success marks it fresh for 24 h and clears the failures.
    const gh = zoeFetch({ "https://api.github.com/users/ghost/events": () => json([]), "https://api.github.com/users/ghost/social": () => json([]), "https://api.github.com/users/ghost": () => json({ blog: "" }) });
    await refreshProfileActivity(env, "ghost", { fetch: gh.fn, now });
    expect((await listSources(env.DB, "ghost")).find((s) => s.source === "github")).toMatchObject({ failures: 0, last_fetched: iso(now) });
    expect(await due(now + 23 * H)).toBe(false);
    expect(retryDelayMs(1)).toBe(3 * H);
    expect(retryDelayMs(99)).toBe(7 * 24 * H);
  });

  it("a refresh that throws also backs off", async () => {
    await makeProfile("crasher", 9701, 1, "1998-01-02 00:00:00");
    const boom = zoeFetch({ "https://api.github.com/users/crasher": () => new Response(new ReadableStream({ pull: () => Promise.reject(new Error("x")) })) }).fn;
    await refreshStaleProfiles(env, { fetch: boom, now: NOW, batch: 1 });
    await refreshStaleProfiles(env, { fetch: boom, now: NOW + 4 * H, batch: 5 });
    expect((await listSources(env.DB, "crasher")).find((s) => s.source === "github")!.failures).toBe(2);
    expect(await selectStaleHandles(env.DB, NOW + 4 * H + 5 * H, 500)).not.toContain("crasher"); // 6 h delay now
  });

  it("a source that fails SOURCE_DISABLE_AFTER refreshes in a row is switched off; re-enabling clears the count", async () => {
    await makeProfile("flaky", 9702);
    const flaky = () => zoeFetch({
      "https://api.github.com/users/flaky/events": () => json([]),
      "https://api.github.com/users/flaky/social": () => json([{ provider: "bluesky", url: "https://bsky.app/profile/flaky.example.com" }]),
      "https://api.github.com/users/flaky": () => json({ blog: "" }),
      "https://public.api.bsky.app/": () => new Response("down", { status: 500 }),
    }).fn;
    for (let i = 1; i <= SOURCE_DISABLE_AFTER; i++) {
      const r = await refreshProfileActivity(env, "flaky", { fetch: flaky(), now: NOW + i });
      expect(r.sourceRows).toBe(1); // the failure count changed: one bookkeeping write
      const row = (await listSources(env.DB, "flaky")).find((s) => s.source === "bluesky")!;
      expect(row).toMatchObject({ failures: i, enabled: i < SOURCE_DISABLE_AFTER });
    }
    // switched off: no longer fetched
    const f = zoeFetch({ "https://api.github.com/users/flaky/events": () => json([]), "https://api.github.com/users/flaky/social": () => json([{ provider: "bluesky", url: "https://bsky.app/profile/flaky.example.com" }]), "https://api.github.com/users/flaky": () => json({ blog: "" }) });
    const r = await refreshProfileActivity(env, "flaky", { fetch: f.fn, now: NOW + 100 });
    expect(f.calls.some((c) => c.url.includes("bsky"))).toBe(false);
    expect(r.sourceRows).toBe(0);
    await setSourceEnabled(env.DB, "flaky", "bluesky", true);
    expect((await listSources(env.DB, "flaky")).find((s) => s.source === "bluesky")).toMatchObject({ enabled: true, failures: 0 });
  });
});

describe("future-dated items", () => {
  it("are clamped once and not rewritten (or re-dated) by later refreshes", async () => {
    await makeProfile("future", 9800);
    const feedWith = (date: string) => ({
      "https://api.github.com/users/future/events": () => json([]),
      "https://api.github.com/users/future/social": () => json([]),
      "https://api.github.com/users/future": () => json({ blog: "https://f.example/feed.xml" }),
      "https://f.example/feed.xml": () => new Response(`<rss><item><title>Time traveller</title><link>https://f.example/p</link><pubDate>${date}</pubDate></item></rss>`),
    });
    const r1 = await refreshProfileActivity(env, "future", { fetch: zoeFetch(feedWith("2099-01-01T00:00:00Z")).fn, now: NOW });
    expect(r1.written).toBe(1);
    expect((await listActivity(env.DB, "future"))[0].ts).toBe(iso(NOW));
    const r2 = await refreshProfileActivity(env, "future", { fetch: zoeFetch(feedWith("2099-01-01T00:00:00Z")).fn, now: NOW + 3 * 86400_000 });
    expect(r2).toMatchObject({ written: 0, deleted: 0 });
    expect((await listActivity(env.DB, "future"))[0].ts).toBe(iso(NOW)); // not "today" again
    // once the claimed date is no longer in the future, the real date is stored
    const r3 = await refreshProfileActivity(env, "future", { fetch: zoeFetch(feedWith("2026-11-27T00:00:00Z")).fn, now: NOW + 3 * 86400_000 });
    expect(r3.written).toBe(1);
    expect((await listActivity(env.DB, "future"))[0].ts).toBe("2026-11-27T00:00:00Z");
  });
});

describe("cron selection", () => {
  it("picks published, never-fetched and >24h-stale profiles, stalest first, and skips fresh/unpublished ones", async () => {
    await makeProfile("c-never", 9201, 1, "2026-02-01 00:00:00");
    await makeProfile("c-old", 9202);
    await makeProfile("c-older", 9203);
    await makeProfile("c-fresh", 9204);
    await makeProfile("c-draft", 9205, 0);
    await markFetched("c-old", iso(NOW - 30 * 3600_000));
    await markFetched("c-older", iso(NOW - 50 * 3600_000));
    await markFetched("c-fresh", iso(NOW - 2 * 3600_000));
    await markFetched("zoe", iso(NOW - 1000));
    const picked = await selectStaleHandles(env.DB, NOW, 50);
    expect(picked.filter((h) => h.startsWith("c-"))).toEqual(["c-never", "c-older", "c-old"]);
    expect(picked).not.toContain("zoe");
    expect(await selectStaleHandles(env.DB, NOW, 2)).toHaveLength(2);
  });

  it("refreshStaleProfiles handles at most REFRESH_BATCH profiles and stays under 50 subrequests", async () => {
    for (let i = 0; i < 8; i++) await makeProfile(`bulk${i}`, 9300 + i, 1, `2025-01-0${i + 1} 00:00:00`);
    // Every bulkN has the same blog and no social accounts, and empty events: ~5 subrequests each.
    const { fn, calls } = zoeFetch({
      "https://api.github.com/users/bulk": (u) => (u.includes("/events") ? json([]) : u.includes("/social") ? json([]) : json({ blog: "blog.zoe.example" })),
    });
    const summary = await refreshStaleProfiles(env, { fetch: fn, now: NOW });
    expect(summary.handles.length).toBeLessThanOrEqual(REFRESH_BATCH);
    expect(summary.handles.length).toBeGreaterThan(0);
    expect(summary.subrequests).toBe(calls.length);
    expect(summary.subrequests).toBeLessThan(50);
    // they are now fresh, so the next run picks different ones
    const again = await refreshStaleProfiles(env, { fetch: fn, now: NOW + 60_000 });
    for (const h of again.handles) expect(summary.handles).not.toContain(h);
  });

  it("a refresh that throws goes to the back of the queue instead of wedging the cron", async () => {
    await makeProfile("wedge-a", 9600, 1, "1999-01-01 00:00:00");
    await makeProfile("wedge-b", 9601, 1, "1999-01-02 00:00:00");
    const { fn } = zoeFetch({
      "https://api.github.com/users/wedge-a": () =>
        new Response(new ReadableStream({ pull: () => Promise.reject(new Error("body exploded")) })),
      "https://api.github.com/users/wedge-b": (u) => (u.includes("/events") ? json([]) : u.includes("/social") ? json([]) : json({ blog: "" })),
    });
    const first = await refreshStaleProfiles(env, { fetch: fn, now: NOW, batch: 1 });
    expect(first.handles).toEqual(["wedge-a"]);
    // The claim was written before fetching: a is ~21 h old, so it is not due again and b is next.
    const a = (await listSources(env.DB, "wedge-a")).find((s) => s.source === "github")!;
    expect(NOW - Date.parse(a.last_fetched!)).toBe(21 * 3600_000);
    const second = await refreshStaleProfiles(env, { fetch: fn, now: NOW + 60_000, batch: 1 });
    expect(second.handles).toEqual(["wedge-b"]);
    // ...and it becomes due again after the retry delay, not never.
    expect(await selectStaleHandles(env.DB, NOW + 4 * 3600_000, 50)).toContain("wedge-a");
  });

  it("stops early when the shared subrequest budget runs out", async () => {
    for (let i = 0; i < 6; i++) await makeProfile(`greedy${i}`, 9400 + i, 1, `2024-01-0${i + 1} 00:00:00`);
    let n = 0;
    const fn = (async (u: string) => {
      n++;
      if (u.endsWith("/events/public?per_page=20")) return json([]);
      if (u.includes("social_accounts")) return json([{ provider: "mastodon", url: "https://a.example/@g" }, { provider: "bluesky", url: "https://bsky.app/profile/g.example" }]);
      return json({ blog: "https://slow.example", id: "1" });
    }) as unknown as typeof fetch;
    const summary = await refreshStaleProfiles(env, { fetch: fn, now: NOW, batch: 20 });
    expect(n).toBeLessThanOrEqual(50);
    expect(summary.handles.length).toBeLessThan(20);
  });

  it("the Worker's scheduled() handler runs a refresh using global fetch", async () => {
    await makeProfile("sched", 9500, 1, "2020-01-01 00:00:00");
    const { fn } = zoeFetch({
      "https://api.github.com/users/sched/events": () => json([]),
      "https://api.github.com/users/sched/social_accounts": () => json([]),
      "https://api.github.com/users/sched": () => json({ blog: "" }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fn as any);
    const ctx = createExecutionContext();
    await worker.scheduled!({ cron: "*/30 * * * *", scheduledTime: Date.now(), type: "scheduled" } as any, env, ctx);
    await waitOnExecutionContext(ctx);
    const gh = (await listSources(env.DB, "sched")).find((s) => s.source === "github");
    expect(gh?.last_fetched).toBeTruthy();
  });

  it("a mocked refresh, which is what POST /edit/refresh runs, stays under the 10 ms CPU budget", async () => {
    await makeProfile("cpu-refresh", 9602);
    const { fn } = zoeFetch({
      "https://api.github.com/users/cpu-refresh/events": () => json([]),
      "https://api.github.com/users/cpu-refresh/social_accounts": () => json([]),
      "https://api.github.com/users/cpu-refresh": () => json({ blog: "" }),
    });
    const started = performance.now();
    const r = await refreshProfileActivity(env, "cpu-refresh", { fetch: fn, now: NOW });
    const ms = performance.now() - started;
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(10);
  });
});

describe("MCP output with activity", () => {
  it("get_profile lists top 5 activity lines; get_recent_activity honours limit; budget holds", async () => {
    const cookie = await signIn("zoe");
    await publish(cookie, {
      name: "Zoe Example",
      headline: "Tools person",
      location: "Berlin",
      bio: "I make small tools for developers and write about the process of shipping them.",
      now: "Building the widgets 2.0 release",
      about: "x".repeat(2000),
      contact: "zoe@example.com",
      links: "Site | https://zoe.example.com\nGitHub | https://github.com/zoe",
      projects: "widgets | https://github.com/zoe/widgets | Tiny UI kit\nold | https://github.com/zoe/old | Archived thing",
    });
    await refreshProfileActivity(env, "zoe", { fetch: zoeFetch().fn, now: NOW });

    const p = await tool("/me/zoe/mcp", "get_profile");
    const recent = p.text.split("\n").filter((l) => l.startsWith("- 20") && l.includes(" · "));
    expect(recent).toHaveLength(5);
    expect(recent[0]).toMatch(/^- \d{4}-\d{2}-\d{2} · [a-z]+ · .+ · https:\/\//);
    expect(p.text).toContain("About: " + "x".repeat(40));
    expect(p.text).toContain("… (more: get_about)");
    expect(p.text).toContain(NOTE_PREFIX);
    // ~4 chars/token: a full profile with activity, long about, 2 projects and 2 links stays near 400 tokens
    expect(p.text.length).toBeLessThan(2000);

    const a = await tool("/me/zoe/mcp", "get_recent_activity", { limit: 3 });
    const lines = a.text.split("\n").filter((l) => / · https:\/\//.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2} · [a-z]+ · /);
    const def = await tool("/me/zoe/mcp", "get_recent_activity");
    expect(def.text.split("\n").filter((l) => / · https:\/\//.test(l)).length).toBeGreaterThan(3);
    expect(def.text).toContain(NOTE_PREFIX);
  });

  it("lookup_person includes activity too", async () => {
    const t = await tool("/me/mcp", "lookup_person", { handle: "zoe" });
    expect(t.text).toContain("Recent:");
  });
});
