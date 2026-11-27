import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, signIn, tool } from "./helpers";
import { githubStub, oauthSignIn, refreshActivity, withFetch } from "./oauth";
import { relativeDay } from "../src/views/profile";

const db = env.DB;
const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>()) ?? null;

const post = (path: string, cookie: string, fields: Record<string, string | string[]> = {}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return call(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
};

/** A realistic /users/<login>/repos item: GitHub returns ~90 fields per repo, about 4-5 KB each. */
const repo = (i: number, o: Record<string, unknown> = {}) => ({
  id: 1000 + i,
  node_id: `R_kgDO${i}`,
  name: `repo-${i}`,
  full_name: `bulky/repo-${i}`,
  private: false,
  owner: { login: "bulky", id: 9, avatar_url: "https://avatars.githubusercontent.com/u/9?v=4", html_url: "https://github.com/bulky", type: "User", site_admin: false },
  html_url: `https://github.com/bulky/repo-${i}`,
  description: `Repository number ${i}`,
  fork: false,
  url: `https://api.github.com/repos/bulky/repo-${i}`,
  homepage: null,
  language: "TypeScript",
  stargazers_count: i,
  watchers_count: i,
  forks_count: 1,
  topics: ["a", "b", "c"],
  license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: "https://api.github.com/licenses/mit", node_id: "MDc6TGljZW5zZTEz" },
  pushed_at: "2026-11-25T10:00:00Z",
  filler: "x".repeat(3500),
  ...o,
});

describe("sign-in does not fetch activity itself", () => {
  it("the callback makes exactly three subrequests and defers activity", async () => {
    const r = await oauthSignIn({ login: "zoe", id: 5150, name: "Zoe" });
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get("location")).toBe("http://localhost/me/zoe?welcome=1");
    expect(r.calls).toEqual(["https://github.com/login/oauth/access_token", "https://api.github.com/user", "https://api.github.com/users/zoe/repos?per_page=30&sort=pushed"]);
    expect(await one("SELECT 1 FROM sources WHERE handle = 'zoe'")).toBeNull();
    expect(await one("SELECT 1 FROM activity WHERE handle = 'zoe'")).toBeNull();
  });

  it("seeds projects from a realistic repos payload (30 repos, ~4 KB each)", async () => {
    const repos = Array.from({ length: 30 }, (_, i) => repo(i)); // pushed order, newest first; stars rise with i
    repos[3] = repo(3, { fork: true, stargazers_count: 999 });
    const r = await oauthSignIn({ login: "bulky", id: 5160 }, { repos });
    expect(r.res.status).toBe(302);
    const p = await one<{ projects: string; now: string }>("SELECT projects, now FROM profiles WHERE handle = 'bulky'");
    const names = JSON.parse(p!.projects).map((x: { name: string }) => x.name);
    expect(names).toEqual(["repo-29", "repo-28", "repo-27", "repo-26", "repo-25"]); // top 5 by stars, fork skipped
    expect(p!.now).toContain("repo-0"); // most recently pushed non-fork
    expect(JSON.stringify(repos).length).toBeGreaterThan(100_000);
  });

  it("a repos failure never breaks sign-in", async () => {
    const r = await oauthSignIn({ login: "norepos", id: 5161 }, { extra: { "https://api.github.com/users/norepos/repos": () => new Response("nope", { status: 500 }) } });
    expect(r.res.status).toBe(302);
    expect((await call("/me/norepos")).status).toBe(200);
  });

  it("the owner's page asks to fetch activity when it was never fetched; others and later views do not", async () => {
    const { cookie } = await oauthSignIn({ login: "zoe", id: 5150 }); // existing
    const html = await (await call("/me/zoe", { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Fetching your activity");
    expect(html).toContain('"/me/edit/refresh"');
    const anon = await (await call("/me/zoe")).text();
    expect(anon).not.toContain("Fetching your activity");
    expect(anon).not.toContain("/edit/refresh");
  });
});

describe("POST /edit/refresh", () => {
  const zoe = { login: "zoe", id: 5150 };
  const blogRows = async () => (await one<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE handle = 'zoe' AND source = 'blog'"))!.n;

  it("is owner-only", async () => {
    const anon = await call("/me/edit/refresh", { method: "POST" });
    expect(anon.status).toBe(401);
    // A session whose login row belongs to another GitHub account is refused
    const stale = await signIn("someone-stale");
    await db.prepare("UPDATE profiles SET github_id = 1 WHERE handle = 'someone-stale'").run();
    expect((await call("/me/edit/refresh", { method: "POST", headers: { Cookie: stale } })).status).toBe(403);
  });

  it("refuses an unpublished profile", async () => {
    const c = await signIn("offliner");
    await post("/me/edit", c, { action: "unpublish" });
    expect((await call("/me/edit/refresh", { method: "POST", headers: { Cookie: c } })).status).toBe(403);
    expect(await one("SELECT 1 FROM sources WHERE handle = 'offliner'")).toBeNull();
  });

  it("fetches within the subrequest budget, then throttles", async () => {
    const { cookie } = await oauthSignIn(zoe);
    const first = await refreshActivity(cookie, zoe);
    expect(first.res.status).toBe(200);
    expect(await first.res.json()).toEqual({ changed: true });
    expect(first.calls.length).toBeGreaterThan(5); // events, social accounts, blog, Bluesky, Mastodon
    expect(first.calls.length).toBeLessThanOrEqual(12);
    expect(await blogRows()).toBeGreaterThan(0);
    const rows = await db.prepare("SELECT source FROM sources WHERE handle = 'zoe' ORDER BY source").all<{ source: string }>();
    expect(rows.results.map((x) => x.source)).toEqual(["blog", "bluesky", "github", "mastodon"]);

    const page = await (await call("/me/zoe")).text();
    expect(page).toContain("Shipping &amp; learning");
    expect((await tool("/me/zoe/mcp", "get_recent_activity", { limit: 15 })).text).toContain("Hello from bsky");
    // fetched: the page no longer asks
    expect(await (await call("/me/zoe", { headers: { Cookie: cookie } })).text()).not.toContain("Fetching your activity");

    // within 10 minutes: nothing is fetched
    const again = await refreshActivity(cookie, zoe);
    expect(await again.res.json()).toEqual({ changed: false, throttled: true });
    expect(again.calls).toHaveLength(0);

    // 10+ minutes later it fetches again
    await db.prepare("UPDATE sources SET last_fetched = ? WHERE handle = 'zoe' AND source = 'github'").bind(new Date(Date.now() - 11 * 60_000).toISOString().slice(0, 19) + "Z").run();
    const later = await refreshActivity(cookie, zoe);
    expect(await later.res.json()).toEqual({ changed: true });
    expect(later.calls.length).toBeGreaterThan(5);
  });

  it("works for a source switched back on, which sign-in or cron would otherwise wait for", async () => {
    const { cookie } = await oauthSignIn(zoe);
    await post("/me/edit/sources", cookie, { on: ["bluesky", "mastodon"] });
    expect(await blogRows()).toBe(0);
    await db.prepare("UPDATE sources SET last_fetched = '2026-01-01T00:00:00Z' WHERE handle = 'zoe' AND source = 'github'").run();
    await refreshActivity(cookie, zoe);
    expect(await blogRows()).toBe(0); // still off
    await post("/me/edit/sources", cookie, { on: ["blog", "bluesky", "mastodon"] });
    expect(await blogRows()).toBe(0); // switching on does not fetch inline
    await db.prepare("UPDATE sources SET last_fetched = '2026-01-01T00:00:00Z' WHERE handle = 'zoe' AND source = 'github'").run();
    await refreshActivity(cookie, zoe);
    expect(await blogRows()).toBeGreaterThan(0);
  });

  it("a failing GitHub API answers 200 changed:false and never throws", async () => {
    const { cookie } = await oauthSignIn({ login: "failing", id: 5151 });
    const stub = githubStub({ login: "failing", id: 5151 }, { "https://api.github.com/users/failing": () => new Response("nope", { status: 500 }) });
    const res = await withFetch(stub, () => call("/me/edit/refresh", { method: "POST", headers: { Cookie: cookie } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: false });
    const thrower = await oauthSignIn({ login: "thrower", id: 5152 });
    const stub2 = githubStub({ login: "thrower", id: 5152 }, { "https://api.github.com/users/thrower": () => { throw new Error("network down"); } });
    const res2 = await withFetch(stub2, () => call("/me/edit/refresh", { method: "POST", headers: { Cookie: thrower.cookie } }));
    expect(res2.status).toBe(200);
  });

  it("a renamed profile counts as never fetched", async () => {
    const a = await oauthSignIn({ login: "was-here", id: 5170 });
    await db.prepare("INSERT INTO sources (handle, source, label, last_fetched) VALUES ('was-here', 'github', '@was-here', '2026-11-25T10:00:00Z')").run();
    const b = await oauthSignIn({ login: "now-here", id: 5170 });
    expect(await one("SELECT last_fetched FROM sources WHERE handle = 'now-here' AND source = 'github'")).toEqual({ last_fetched: null });
    expect(await (await call("/me/now-here", { headers: { Cookie: b.cookie } })).text()).toContain("Fetching your activity");
    expect(a.cookie).not.toBe("");
  });
});

describe("Origin check on owner POSTs", () => {
  const routes: [string, string][] = [
    ["/me/edit", "action=save&name=x"],
    ["/me/edit/key", ""],
    ["/me/edit/sources", "on=blog"],
    ["/me/edit/refresh", ""],
    ["/me/edit/delete", ""],
    ["/me/edit/card", ""],
  ];
  const send = (path: string, body: string, cookie: string, headers: Record<string, string>) =>
    call(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": path.endsWith("/card") ? "image/png" : "application/x-www-form-urlencoded", ...headers }, body });

  it("refuses a cross-site Origin on every owner route, and changes nothing", async () => {
    const cookie = await signIn("csrfvictim");
    for (const [path, body] of routes) {
      const res = await send(path, body, cookie, { Origin: "https://evil.example" });
      expect(res.status, path).toBe(403);
      expect(await res.text()).toContain("Cross-site");
    }
    expect((await send("/me/edit/delete", "", cookie, { Origin: "null" })).status).toBe(403);
    expect((await send("/me/edit/key", "", cookie, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(await one("SELECT key_hash FROM profiles WHERE handle = 'csrfvictim'")).toEqual({ key_hash: null });
    expect((await call("/me/csrfvictim")).status).toBe(200); // not deleted
  });

  it("accepts the site's own origin (browser form posts) and header-less clients", async () => {
    const cookie = await signIn("csrfok");
    expect((await send("/me/edit/sources", "on=blog", cookie, { Origin: "http://localhost" })).status).toBe(302);
    expect((await send("/me/edit/sources", "on=blog", cookie, { "Sec-Fetch-Site": "same-origin" })).status).toBe(302);
    expect((await send("/me/edit/sources", "on=blog", cookie, {})).status).toBe(302);
    expect((await send("/me/edit/key", "", cookie, { Origin: "http://localhost" })).status).toBe(200);
  });

  it("does not touch GETs or the MCP endpoints", async () => {
    expect((await call("/me", { headers: { Origin: "https://evil.example" } })).status).toBe(200);
    const res = await call("/me/mcp", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(200);
  });
});

describe("recent activity on the profile page", () => {
  const seed = async (handle: string, rows: [string, string, string, string][]) => {
    await db.batch(
      rows.map(([source, title, url, ts]) =>
        db.prepare("INSERT INTO activity (handle, source, kind, title, url, ts) VALUES (?, ?, 'post', ?, ?, ?)").bind(handle, source, title, url, ts),
      ),
    );
  };

  it("lists items newest first with date, source and a safe link; hides the section when empty", async () => {
    const o = await signIn("lister");
    expect(await (await call("/me/lister")).text()).not.toContain("Recent activity");
    const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 19) + "Z";
    await seed("lister", [
      ["blog", "Older post", "https://blog.example/old", day(30)],
      ["github", "Pushed to lister/app", "https://github.com/lister/app", day(0)],
      ["bluesky", "Sneaky <b>title</b>", "javascript:alert(1)", day(3)],
    ]);
    const html = await (await call("/me/lister", { headers: { Cookie: o } })).text();
    expect(html).toContain("Recent activity");
    expect(html.indexOf("Pushed to lister/app")).toBeLessThan(html.indexOf("Older post"));
    expect(html).toContain('<a href="https://github.com/lister/app" rel="nofollow noopener" target="_blank">Pushed to lister/app</a>');
    expect(html).toContain(">today</time>");
    expect(html).toContain(">3d ago</time>");
    expect(html).toContain('<span class="src">GitHub</span>');
    // Non-http(s) URL: shown as plain, escaped text, never as a link
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain("Sneaky &lt;b&gt;title&lt;/b&gt;");
  });

  it("relativeDay", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    expect(relativeDay("2026-11-26T01:00:00Z", now)).toBe("today");
    expect(relativeDay("2026-11-25T01:00:00Z", now)).toBe("yesterday");
    expect(relativeDay("2026-11-20T12:00:00Z", now)).toBe("6d ago");
    expect(relativeDay("2026-11-05T12:00:00Z", now)).toBe("3w ago");
    expect(relativeDay("2026-08-04T12:00:00Z", now)).toBe("Aug 4");
    expect(relativeDay("2025-08-04T12:00:00Z", now)).toBe("Aug 4, 2025");
    expect(relativeDay("garbage", now)).toBe("");
  });
});

describe("owner source toggles", () => {
  const setup = async (handle: string) => {
    const cookie = await signIn(handle);
    await db.batch([
      db.prepare("INSERT INTO sources (handle, source, label, failures) VALUES (?, 'github', ?, 0), (?, 'blog', 'blog.example', 0), (?, 'bluesky', 'me.example.com', 5)").bind(handle, `@${handle}`, handle, handle),
      db.prepare("UPDATE sources SET enabled = 0 WHERE handle = ? AND source = 'bluesky'").bind(handle),
      db.prepare("INSERT INTO activity (handle, source, kind, title, url, ts) VALUES (?, 'blog', 'post', 'A post', 'https://blog.example/a', '2026-11-25T10:00:00Z')").bind(handle),
    ]);
    return cookie;
  };
  const enabled = async (handle: string, source: string) => (await one<{ enabled: number }>("SELECT enabled FROM sources WHERE handle = ? AND source = ?", handle, source))?.enabled;

  it("shows the card to the owner only, as a plain form", async () => {
    const cookie = await setup("sourcey");
    const html = await (await call("/me/sourcey", { headers: { Cookie: cookie } })).text();
    expect(html).toContain("Sources");
    expect(html).toContain("listed on your GitHub profile");
    expect(html).toContain('action="/me/edit/sources"');
    expect(html).toContain("Always on");
    expect(html).toContain("Turned off after repeated failures"); // bluesky: disabled with failures >= 5
    expect(html).toMatch(/name="on"[^>]*value="blog"[^>]*checked/);
    expect(html).not.toMatch(/value="bluesky"[^>]*checked/);
    expect(html).not.toMatch(/value="github"/); // no switch for GitHub

    const anon = await (await call("/me/sourcey")).text();
    expect(anon).not.toContain('id="sources"');
    expect(anon).not.toContain("edit/sources");
    const other = await signIn("someoneelse");
    expect(await (await call("/me/sourcey", { headers: { Cookie: other } })).text()).not.toContain('id="sources"');
  });

  it("POST turns a source off (and removes what it added), then on again", async () => {
    const cookie = await setup("flipper");
    const off = await post("/me/edit/sources", cookie, {}); // nothing ticked
    expect(off.status).toBe(302);
    expect(off.headers.get("location")).toBe("http://localhost/me/flipper#sources");
    expect(await enabled("flipper", "blog")).toBe(0);
    expect(await one("SELECT COUNT(*) AS n FROM activity WHERE handle = 'flipper'")).toEqual({ n: 0 });

    await post("/me/edit/sources", cookie, { on: ["blog", "bluesky", "github", "nonsense"] });
    expect(await enabled("flipper", "blog")).toBe(1);
    expect(await enabled("flipper", "bluesky")).toBe(1);
    expect(await one("SELECT failures FROM sources WHERE handle = 'flipper' AND source = 'bluesky'")).toEqual({ failures: 0 });
    expect(await enabled("flipper", "github")).toBe(1); // untouched, no switch
    expect(await one("SELECT 1 FROM sources WHERE handle = 'flipper' AND source = 'nonsense'")).toBeNull();
  });

  it("is owner-only", async () => {
    await setup("guarded");
    const anon = await post("/me/edit/sources", "", {});
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/auth/github");
    const other = await signIn("intruder");
    await post("/me/edit/sources", other, {});
    expect(await enabled("guarded", "blog")).toBe(1);
  });
});

describe("copy", () => {
  it("llms.txt lists get_recent_activity and explains verified sources", async () => {
    const body = await (await call("/me/llms.txt")).text();
    expect(body).toContain("get_recent_activity");
    expect(body).toMatch(/verified sources/i);
    expect(body).toContain("GitHub profile");
  });

  it("the unpublished editor no longer says 'Create your MCP server'", async () => {
    const cookie = await signIn("offline");
    await post("/me/edit", cookie, { action: "unpublish" });
    const html = await (await call("/me/edit", { headers: { Cookie: cookie } })).text();
    expect(html).not.toContain("Create your MCP server");
    expect(html).toContain("Your server is offline");
  });
});
