import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, createKey, publish, rpc, tool } from "./helpers";
import { oauthSignIn } from "./oauth";
import { deleteStaleParkedProfiles } from "../src/db";

const db = env.DB;
const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>()) ?? null;
const count = async (table: string, handle: string) => (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE handle = ?`, handle))!.n;

/** Gives a profile some of everything that must survive a move. */
async function seed(handle: string) {
  await db.batch([
    db.prepare("UPDATE profiles SET calls_total = 42 WHERE handle = ?").bind(handle),
    db.prepare("INSERT INTO call_daily (handle, day, count) VALUES (?, '2026-11-25', 7), (?, '2026-11-26', 5)").bind(handle, handle),
    db.prepare("INSERT INTO call_clients (handle, client, count) VALUES (?, 'Claude', 9)").bind(handle),
    db.prepare("INSERT INTO activity (handle, source, kind, title, url, ts) VALUES (?, 'github', 'push', 'Pushed to x/y', 'https://github.com/x/y', '2026-11-25T10:00:00Z')").bind(handle),
    db.prepare("INSERT INTO sources (handle, source, label, last_fetched, failures) VALUES (?, 'github', ?, '2026-11-25T10:00:00Z', 0)").bind(handle, `@${handle}`),
    db.prepare("INSERT INTO share_cards (handle, png_b64, version) VALUES (?, 'AAAA', 'v1')").bind(handle),
  ]);
}

describe("GitHub rename", () => {
  it("moves the whole profile to the new handle", async () => {
    const first = await oauthSignIn({ login: "oldie", id: 7001, name: "Old Ie" });
    expect(first.res.headers.get("location")).toContain("welcome=1");
    expect((await publish(first.cookie, { name: "Old Ie", headline: "Hello there", now: "Before the rename" })).status).toBe(302);
    const key = await createKey(first.cookie);
    await seed("oldie");
    const before = await one<{ key_hash: string; created_at: string }>("SELECT key_hash, created_at FROM profiles WHERE handle = 'oldie'");

    const second = await oauthSignIn({ login: "newbie", id: 7001, name: "Old Ie" });
    expect(second.res.status).toBe(302);
    expect(second.res.headers.get("location")).toBe("http://localhost/me/newbie"); // no welcome: not a new profile

    // Old handle is gone everywhere
    expect((await call("/me/oldie")).status).toBe(404);
    expect(await one("SELECT 1 FROM profiles WHERE handle = 'oldie'")).toBeNull();
    for (const t of ["call_daily", "call_clients", "activity", "sources", "share_cards"]) expect(await count(t, "oldie")).toBe(0);

    // New handle has the data
    const p = await one<Record<string, unknown>>("SELECT * FROM profiles WHERE handle = 'newbie'");
    expect(p).toMatchObject({ github_id: 7001, published: 1, name: "Old Ie", headline: "Hello there", now: "Before the rename", calls_total: 42, key_hash: before!.key_hash, created_at: before!.created_at });
    expect(await count("call_daily", "newbie")).toBe(2);
    expect(await count("call_clients", "newbie")).toBe(1);
    expect(await count("activity", "newbie")).toBe(1);
    expect(await count("sources", "newbie")).toBe(1);
    // ...with its refresh marker cleared, so the cron and the owner's page fetch it first
    expect(await one("SELECT last_fetched FROM sources WHERE handle = 'newbie' AND source = 'github'")).toEqual({ last_fetched: null });
    // The share card is dropped, not carried (it regenerates on the next visit)
    expect(await count("share_cards", "newbie")).toBe(0);

    // The page, the MCP server and the agent key all work under the new handle
    const page = await call("/me/newbie", { headers: { Cookie: second.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Before the rename");
    expect((await tool("/me/newbie/mcp", "get_now")).text).toContain("Before the rename");
    const upd = await rpc("/me/newbie/mcp", "tools/list", {}, { Authorization: `Bearer ${key}` });
    expect(upd.body.result.tools.map((t: { name: string }) => t.name)).toContain("update_profile");
    // An old session cookie for the old login no longer reaches an editor
    expect((await call("/me/edit", { headers: { Cookie: first.cookie } })).status).toBe(302);
    expect((await call("/me/edit", { headers: { Cookie: second.cookie } })).status).toBe(200);
  });

  it("keeps an unpublished profile unpublished", async () => {
    const a = await oauthSignIn({ login: "shy-old", id: 7002 });
    await call("/me/edit", { method: "POST", headers: { Cookie: a.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: "action=unpublish" });
    await oauthSignIn({ login: "shy-new", id: 7002 });
    expect(await one("SELECT published FROM profiles WHERE handle = 'shy-new'")).toEqual({ published: 0 });
    expect((await call("/me/shy-new")).status).toBe(404);
  });

  it("signing in again under the same handle changes nothing", async () => {
    const a = await oauthSignIn({ login: "steady", id: 7003 });
    await seed("steady");
    const b = await oauthSignIn({ login: "steady", id: 7003 });
    expect(b.res.headers.get("location")).toBe("http://localhost/me/steady");
    expect(await count("call_daily", "steady")).toBe(2);
    expect(await count("share_cards", "steady")).toBe(1);
    expect(a.cookie).not.toBe("");
  });

  it("is all-or-nothing: a failure part-way leaves the old profile untouched", async () => {
    await oauthSignIn({ login: "atomic", id: 7004 });
    await seed("atomic");
    // The move fails at its activity step, after the profile row, call_daily and call_clients were already updated.
    await db.exec("CREATE TRIGGER boom BEFORE UPDATE ON activity WHEN NEW.handle = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    try {
      const r = await oauthSignIn({ login: "boom", id: 7004 });
      expect(r.res.status).toBe(500);
    } finally {
      await db.exec("DROP TRIGGER boom");
    }
    expect(await one("SELECT 1 FROM profiles WHERE handle = 'boom'")).toBeNull();
    expect(await one("SELECT calls_total FROM profiles WHERE handle = 'atomic'")).toEqual({ calls_total: 42 });
    for (const t of ["call_daily", "call_clients", "activity", "sources", "share_cards"]) {
      expect(await count(t, "atomic")).toBeGreaterThan(0);
      expect(await count(t, "boom")).toBe(0);
    }
    // ...and the next sign-in works.
    expect((await oauthSignIn({ login: "atomic2", id: 7004 })).res.status).toBe(302);
    expect(await count("call_daily", "atomic2")).toBe(2);
  });
});

describe("reused login", () => {
  it("parks the previous owner's profile out of sight instead of deleting or inheriting it", async () => {
    // alpha belongs to GitHub account 8001 ...
    const a = await oauthSignIn({ login: "alpha", id: 8001, name: "Alpha One" });
    await publish(a.cookie, { name: "Alpha One", now: "Alpha's secret plans" });
    const key = await createKey(a.cookie);
    await seed("alpha");

    // ... which renames away. Someone else (8002) takes the login "alpha".
    const b = await oauthSignIn({ login: "alpha", id: 8002, name: "Alpha Two" });
    expect(b.res.headers.get("location")).toContain("welcome=1");
    const page = await (await call("/me/alpha")).text();
    expect(page).toContain("Alpha Two");
    expect(page).not.toContain("Alpha's secret plans");
    expect(await one("SELECT github_id, calls_total FROM profiles WHERE handle = 'alpha'")).toEqual({ github_id: 8002, calls_total: 0 });
    expect(await count("call_daily", "alpha")).toBe(0);

    // The old data is parked, unpublished, under a handle no GitHub login can have
    const parked = await one<Record<string, unknown>>("SELECT * FROM profiles WHERE github_id = 8001");
    expect(parked).toMatchObject({ handle: "~8001", published: 0, now: "Alpha's secret plans", calls_total: 42 });
    expect(await count("call_daily", "~8001")).toBe(2);
    expect(await count("activity", "~8001")).toBe(1);

    // Not routable or listed
    expect((await call("/me/~8001")).status).toBe(404);
    expect((await call("/me/%7E8001")).status).toBe(404);
    expect((await call("/me/~8001/llms.txt")).status).toBe(404);
    expect((await call("/me/~8001/card.png")).status).toBe(404);
    expect((await call("/me/~8001/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status).toBe(404);
    const found = await tool("/me/mcp", "search_people", { query: "secret plans" });
    expect(found.text).not.toContain("~8001");
    expect(await (await call("/me")).text()).not.toContain("~8001");
    // The squatter never gets the old owner's key or session
    expect((await call("/me/edit", { headers: { Cookie: a.cookie } })).status).toBe(302);

    // The old owner signs in under their new login: everything comes back
    const moved = await oauthSignIn({ login: "alpha-renamed", id: 8001, name: "Alpha One" });
    expect(moved.res.headers.get("location")).toBe("http://localhost/me/alpha-renamed");
    expect(await one("SELECT 1 FROM profiles WHERE handle = '~8001'")).toBeNull();
    expect(await one("SELECT published, now, calls_total FROM profiles WHERE handle = 'alpha-renamed'")).toEqual({ published: 1, now: "Alpha's secret plans", calls_total: 42 });
    expect(await count("call_daily", "alpha-renamed")).toBe(2);
    expect(await count("activity", "alpha-renamed")).toBe(1);
    // alpha (the squatter) is untouched
    expect(await one("SELECT github_id FROM profiles WHERE handle = 'alpha'")).toEqual({ github_id: 8002 });
  });

  it("a profile its owner had unpublished stays unpublished through parking and the move home", async () => {
    const a = await oauthSignIn({ login: "quiet-one", id: 8101 });
    await call("/me/edit", { method: "POST", headers: { Cookie: a.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: "action=unpublish" });
    await oauthSignIn({ login: "quiet-one", id: 8102 });
    expect(await one("SELECT handle, published FROM profiles WHERE github_id = 8101")).toEqual({ handle: "~8101u", published: 0 });
    expect((await call("/me/~8101u")).status).toBe(404);
    await oauthSignIn({ login: "quiet-two", id: 8101 });
    expect(await one("SELECT handle, published FROM profiles WHERE github_id = 8101")).toEqual({ handle: "quiet-two", published: 0 });
  });

  it("a new profile never inherits leftovers stored under its handle", async () => {
    await db.batch([
      db.prepare("INSERT INTO call_daily (handle, day, count) VALUES ('leftover', '2026-11-25', 99)"),
      db.prepare("INSERT INTO call_clients (handle, client, count) VALUES ('leftover', 'Claude', 99)"),
      db.prepare("INSERT INTO activity (handle, source, kind, title, url, ts) VALUES ('leftover', 'blog', 'post', 'Old post', 'https://old.example/p', '2026-11-25T10:00:00Z')"),
      db.prepare("INSERT INTO sources (handle, source, label, last_fetched) VALUES ('leftover', 'github', '@leftover', '2026-11-25T10:00:00Z')"),
    ]);
    const r = await oauthSignIn({ login: "leftover", id: 8201 });
    expect(r.res.headers.get("location")).toContain("welcome=1");
    for (const t of ["call_daily", "call_clients", "activity", "sources", "share_cards"]) expect(await count(t, "leftover"), t).toBe(0);
    expect(await one("SELECT github_id FROM profiles WHERE handle = 'leftover'")).toEqual({ github_id: 8201 });
    expect(await (await call("/me/leftover", { headers: { Cookie: r.cookie } })).text()).not.toContain("Old post");
  });

  it("handles a rename into a login the previous owner left behind, in one go", async () => {
    // 9001 = "swap-a"; 9002 = "swap-b". 9001 renames to "swap-b" while 9002's old row still holds that login.
    const a = await oauthSignIn({ login: "swap-a", id: 9001 });
    await publish(a.cookie, { name: "A person", now: "I am A" });
    const b = await oauthSignIn({ login: "swap-b", id: 9002 });
    await publish(b.cookie, { name: "B person", now: "I am B" });

    const aNew = await oauthSignIn({ login: "swap-b", id: 9001 }); // A takes B's old login
    expect(aNew.res.status).toBe(302);
    expect(await one("SELECT github_id, now FROM profiles WHERE handle = 'swap-b'")).toEqual({ github_id: 9001, now: "I am A" });
    expect(await one("SELECT handle, published, now FROM profiles WHERE github_id = 9002")).toEqual({ handle: "~9002", published: 0, now: "I am B" });
    expect(await one("SELECT 1 FROM profiles WHERE handle = 'swap-a'")).toBeNull();

    const bNew = await oauthSignIn({ login: "swap-a", id: 9002 }); // B takes A's old login
    expect(bNew.res.status).toBe(302);
    expect(await one("SELECT github_id, now FROM profiles WHERE handle = 'swap-a'")).toEqual({ github_id: 9002, now: "I am B" });
    expect(await one("SELECT github_id, now FROM profiles WHERE handle = 'swap-b'")).toEqual({ github_id: 9001, now: "I am A" });
  });
});

describe("parked profiles", () => {
  it("deletes a parked row after 90 days and leaves a recent one, and a normal profile, alone", async () => {
    await db.batch([
      db.prepare("INSERT INTO profiles (handle, github_id, published, now, updated_at) VALUES ('~77001', 77001, 0, 'old parked', '2000-01-01 00:00:00')"),
      db.prepare("INSERT INTO activity (handle, source, kind, title, url, ts) VALUES ('~77001', 'github', 'push', 'old', 'https://github.com/x/y', '2000-01-01T00:00:00Z')"),
      db.prepare("INSERT INTO profiles (handle, github_id, published, now) VALUES ('~77002', 77002, 0, 'fresh parked')"),
      db.prepare("INSERT INTO profiles (handle, github_id, published, now, updated_at) VALUES ('still-here', 77003, 1, 'real', '2000-01-01 00:00:00')"),
    ]);
    expect(await deleteStaleParkedProfiles(db)).toBe(1);
    expect(await one("SELECT handle FROM profiles WHERE github_id = 77001")).toBeNull();
    expect(await count("activity", "~77001")).toBe(0);
    expect(await one("SELECT handle FROM profiles WHERE github_id = 77002")).toEqual({ handle: "~77002" });
    expect(await one("SELECT handle FROM profiles WHERE handle = 'still-here'")).toEqual({ handle: "still-here" });
  });
});
