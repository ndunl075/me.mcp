import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, signIn, tool } from "./helpers";
import { oauthSignIn } from "./oauth";
import { relativeDay } from "../src/views/profile";

const db = env.DB;
const one = async <T>(sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>()) ?? null;

const post = (path: string, cookie: string, fields: Record<string, string | string[]> = {}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return call(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
};

describe("activity fetched at sign-in", () => {
  it("a new profile gets its activity right after sign-in, within the subrequest budget", async () => {
    const r = await oauthSignIn({ login: "zoe", id: 5150, name: "Zoe" }, { refresh: true });
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get("location")).toBe("http://localhost/me/zoe?welcome=1");

    // 3 for the sign-in itself (token, /user, repos) + at most 12 for the refresh; Workers Free allows 50 per invocation.
    const signInCalls = r.calls.filter((u) => u.startsWith("https://github.com/login") || u === "https://api.github.com/user" || u.includes("/repos"));
    expect(signInCalls).toHaveLength(3);
    expect(r.calls.length).toBeLessThanOrEqual(15);
    expect(r.calls.length).toBeGreaterThan(5); // it really fetched events, social accounts, blog, Bluesky and Mastodon

    const page = await (await call("/me/zoe")).text();
    expect(page).toContain("Recent activity");
    expect(page).toContain("Shipping &amp; learning"); // blog post
    expect(page).toContain("Hello from bsky");

    const mcp = await tool("/me/zoe/mcp", "get_recent_activity", { limit: 15 });
    expect(mcp.text).toContain("Shipping & learning");
    expect(mcp.text).toContain("Hello from bsky");
    const rows = await db.prepare("SELECT source FROM sources WHERE handle = 'zoe' ORDER BY source").all<{ source: string }>();
    expect(rows.results.map((x) => x.source)).toEqual(["blog", "bluesky", "github", "mastodon"]);
  });

  it("signing in again does not fetch activity again", async () => {
    await oauthSignIn({ login: "zoe", id: 5150 }, { refresh: true });
    const again = await oauthSignIn({ login: "zoe", id: 5150 }, { refresh: true });
    expect(again.calls).toHaveLength(3);
  });

  it("a failing GitHub API never breaks sign-in", async () => {
    const r = await oauthSignIn({ login: "failing", id: 5151 }, { refresh: true, extra: { "https://api.github.com/users/failing": () => new Response("nope", { status: 500 }) } });
    expect(r.res.status).toBe(302);
    expect(r.cookie).toContain("memcp_session=");
    expect(r.res.headers.get("location")).toContain("welcome=1");
    expect((await call("/me/failing")).status).toBe(200);
    expect(await one("SELECT COUNT(*) AS n FROM activity WHERE handle = 'failing'")).toEqual({ n: 0 });
  });

  it("a fetch that throws never breaks sign-in either", async () => {
    const r = await oauthSignIn({ login: "thrower", id: 5152 }, {
      refresh: true,
      extra: {
        "https://api.github.com/users/thrower": () => {
          throw new Error("network down");
        },
      },
    });
    expect(r.res.status).toBe(302);
    expect((await call("/me/thrower")).status).toBe(200);
  });

  it("a rename refreshes under the new handle", async () => {
    await oauthSignIn({ login: "zoe-old", id: 5153, name: "Zoe" });
    // "zoe" is still held by the first test's account (id 5150): that row is parked and this profile takes the login.
    const r = await oauthSignIn({ login: "zoe", id: 5153 }, { refresh: true });
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get("location")).toBe("http://localhost/me/zoe");
    expect(r.calls.length).toBeGreaterThan(5);
    expect(await one("SELECT github_id FROM profiles WHERE handle = 'zoe'")).toEqual({ github_id: 5153 });
    expect((await one<{ n: number }>("SELECT COUNT(*) AS n FROM activity WHERE handle = 'zoe' AND source = 'blog'"))!.n).toBeGreaterThan(0);
    expect(await one("SELECT handle FROM profiles WHERE github_id = 5150")).toEqual({ handle: "~5150" });
  });

  it("the dev login does the same, and SIGNIN_REFRESH=0 switches it off", async () => {
    const off = await signIn("devperson");
    expect(off).toContain("memcp_session=");
    expect(await one("SELECT 1 FROM sources WHERE handle = 'devperson'")).toBeNull();
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
