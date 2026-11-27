import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addCustomSource, listActivity, listCustomSources, REFRESH_BATCH, RUN_SUBREQUEST_BUDGET } from "../src/activity";
import { deleteProfile } from "../src/db";
import {
  CUSTOM_SOURCE_CAP,
  CUSTOM_SUBREQUESTS,
  fetchCustomSource,
  hasBacklink,
  normalizeTarget,
  npmRepoMatches,
} from "../src/custom-sources";
import { pageSummary } from "../src/sources";
import { moveHandleStatements } from "../src/profile-move";
import { Fetcher } from "../src/sources";
import { html, json, xml } from "./fixtures";
import { call, signIn, tool } from "./helpers";
import { withFetch } from "./oauth";

const PAGE = "http://localhost/me/ada";
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Ada</title><link>https://blog.example/</link>
<item><title>Shipped the parser</title><link>https://blog.example/shipped</link><pubDate>Tue, 24 Nov 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;
const PAGE_HTML = `<!doctype html><html><head><title>Ada's site</title>
<meta name="description" content="Notes on parsers">
<link rel="alternate" type="application/rss+xml" href="https://blog.example/feed.xml">
</head><body><a href="https://github.com/ada">me</a></body></html>`;

function routed(map: Record<string, () => Response>) {
  const routes = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [prefix, make] of routes) if (url.startsWith(prefix)) return make();
    return new Response("no", { status: 404 });
  }) as typeof fetch;
}

describe("target checks", () => {
  it("rejects private hosts, bad usernames and non-https tricks", () => {
    expect(normalizeTarget("feed", "https://127.0.0.1/x")).toBeNull();
    expect(normalizeTarget("feed", "https://169.254.169.254/latest")).toBeNull();
    expect(normalizeTarget("website", "http://localhost/me")).toBeNull();
    expect(normalizeTarget("hn", "a/b")).toBeNull();
    expect(normalizeTarget("hn", "x")).toBeNull();
    expect(normalizeTarget("devto", "has space")).toBeNull();
    expect(normalizeTarget("npm", "...")).toBeNull();
    expect(normalizeTarget("feed", "https://blog.example/feed.xml")?.target).toBe("https://blog.example/feed.xml");
    expect(normalizeTarget("hn", "@pg")?.target).toBe("pg");
    expect(normalizeTarget("npm", "Ada")?.target).toBe("ada");
  });

  it("backlink requires the exact login and the exact page", () => {
    expect(hasBacklink("see https://github.com/ada", "ada", PAGE)).toBe(true);
    expect(hasBacklink("https://github.com/ada/repo", "ada", PAGE)).toBe(true);
    expect(hasBacklink("https://github.com/ada-evil", "ada", PAGE)).toBe(false);
    expect(hasBacklink("https://github.com/adamine", "ada", PAGE)).toBe(false);
    expect(hasBacklink(`hello ${PAGE}`, "other", PAGE)).toBe(true);
    expect(hasBacklink("http://localhost/me/ada-evil", "other", PAGE)).toBe(false);
    expect(npmRepoMatches("git+https://github.com/ada/pkg.git", "ada")).toBe(true);
    expect(npmRepoMatches("https://github.com/ada", "ada")).toBe(false);
    expect(npmRepoMatches("https://github.com/other/pkg", "ada")).toBe(false);
  });

  it("page summary stays bounded on a huge body", () => {
    const huge = `<title>${"A".repeat(200_000)}</title><meta name="description" content="${"B".repeat(200_000)}">`;
    const sum = pageSummary(huge);
    expect(sum.title.length).toBeLessThanOrEqual(140);
    expect(sum.description.length).toBeLessThanOrEqual(180);
  });
});

describe("fetchers", () => {
  const spec = { id: "abcd1234", verified: false } as const;

  it("a feed is verified from a backlink, and items are cleaned", async () => {
    const fn = routed({
      "https://blog.example/": () => html(PAGE_HTML),
      "https://blog.example/feed.xml": () => xml(FEED),
    });
    const got = await fetchCustomSource(new Fetcher(6, fn), { ...spec, kind: "feed", target: "https://blog.example/" }, { login: "ada", pageUrl: PAGE, maxGets: 3 });
    expect(got?.verified).toBe(true);
    expect(got?.items.map((i) => i.title)).toEqual(["Shipped the parser"]);
    expect(got?.items[0].source).toBe("c:abcd1234");
  });

  it("a feed with no backlink is kept and labeled unverified", async () => {
    const bare = PAGE_HTML.replace("https://github.com/ada", "https://example.com/");
    const fn = routed({
      "https://blog.example/": () => html(bare),
      "https://blog.example/feed.xml": () => xml(FEED),
    });
    const got = await fetchCustomSource(new Fetcher(6, fn), { ...spec, kind: "feed", target: "https://blog.example/" }, { login: "ada", pageUrl: PAGE, maxGets: 3 });
    expect(got?.verified).toBe(false);
    expect(got?.items).toHaveLength(1);
  });

  it("a redirect to a private host is not followed", async () => {
    const fn = (async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } })) as typeof fetch;
    const got = await fetchCustomSource(new Fetcher(4, fn), { ...spec, kind: "website", target: "https://blog.example/" }, { login: "ada", pageUrl: PAGE });
    expect(got).toBeNull();
  });

  it("hacker news verifies from the about field", async () => {
    const fn = routed({
      "https://hacker-news.firebaseio.com/": () => json({ about: "https://github.com/ada", id: "ada" }),
      "https://hn.algolia.com/": () => json({ hits: [{ title: "Show HN", url: "https://blog.example/show", objectID: "42", created_at: "2026-11-20T00:00:00.000Z" }] }),
    });
    const got = await fetchCustomSource(new Fetcher(4, fn), { ...spec, kind: "hn", target: "ada" }, { login: "ada", pageUrl: PAGE });
    expect(got?.verified).toBe(true);
    expect(got?.items[0].url).toBe("https://blog.example/show");
  });

  it("dev.to verifies from github_username, not the dev.to name", async () => {
    const fn = routed({
      "https://dev.to/api/users/": () => json({ github_username: "Ada", summary: "no link" }),
      "https://dev.to/api/articles": () => json([{ title: "A post", url: "https://dev.to/ada/a-post", published_at: "2026-11-20T00:00:00Z" }]),
    });
    const got = await fetchCustomSource(new Fetcher(4, fn), { ...spec, kind: "devto", target: "ada" }, { login: "ada", pageUrl: PAGE });
    expect(got?.verified).toBe(true);
    expect(got?.label).toBe("@ada");
  });

  it("npm drops packages whose repository is not under the login", async () => {
    const fn = routed({
      "https://registry.npmjs.org/": () =>
        json({
          objects: [
            { package: { name: "mine", description: "ok", date: "2026-11-01T00:00:00.000Z", links: { repository: "https://github.com/ada/mine" } } },
            { package: { name: "theirs", description: "no", date: "2026-11-02T00:00:00.000Z", links: { repository: "https://github.com/other/theirs" } } },
          ],
        }),
    });
    const got = await fetchCustomSource(new Fetcher(3, fn), { ...spec, kind: "npm", target: "ada" }, { login: "ada", pageUrl: PAGE });
    expect(got?.verified).toBe(true);
    expect(got?.items.map((i) => i.title)).toEqual(["mine: ok"]);
    expect(got?.items[0].kind).toBe("package");
  });

  it("a website summary is stored from title and description", async () => {
    const fn = routed({ "https://ada.example/": () => html(`<html><head><title>Ada Lin</title><meta name="description" content="I write parsers"></head><body><a href="${PAGE}">page</a></body></html>`) });
    const got = await fetchCustomSource(new Fetcher(3, fn), { ...spec, kind: "website", target: "https://ada.example/" }, { login: "ada", pageUrl: PAGE });
    expect(got?.verified).toBe(true);
    expect(got?.summary).toBe("Ada Lin. I write parsers");
    expect(got?.items).toEqual([]);
  });
});

describe("owner routes", () => {
  const post = (cookie: string, body: string, headers: Record<string, string> = {}) =>
    call("/me/edit/sources/add", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost", ...headers },
      body,
    });

  it("refuses a stranger, a cross-site post, and a bad username", async () => {
    const anon = await call("/me/edit/sources/add", { method: "POST", body: "kind=hn&target=ada", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toContain("/auth/github");

    const cookie = await signIn("cs-ada");
    const cross = await post(cookie, "kind=hn&target=ada", { Origin: "https://evil.example" });
    expect(cross.status).toBe(403);

    const bad = await post(cookie, "kind=hn&target=a/b&back=edit");
    expect(bad.headers.get("location")).toContain("src=bad");
    expect(await listCustomSources(env.DB, "cs-ada")).toEqual([]);
  });

  it("adds a verified feed, labels an unverified one, and stops at 6", async () => {
    const cookie = await signIn("cs-bee");
    const fn = routed({
      "https://blog.example/": () => html(PAGE_HTML.replace("github.com/ada", "github.com/cs-bee").replace(PAGE, "http://localhost/me/cs-bee")),
      "https://blog.example/feed.xml": () => xml(FEED),
      "https://other.example/": () => html(`<html><head><link rel="alternate" type="application/rss+xml" href="https://other.example/feed.xml"></head></html>`),
      "https://other.example/feed.xml": () => xml(FEED.replace("blog.example", "other.example")),
    });
    const add = (body: string) => withFetch({ fn }, () => post(cookie, body));
    const ok = await add("kind=feed&target=https://blog.example/&back=profile");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain("src=verified");
    const rows = await listActivity(env.DB, "cs-bee");
    expect(rows.some((r) => r.custom_kind === "feed" && !r.unverified)).toBe(true);

    const weak = await add("kind=feed&target=https://other.example/&back=profile");
    expect(weak.headers.get("location")).toContain("src=unverified");
    const act = await tool("/me/cs-bee/mcp", "get_recent_activity");
    expect(act.text).toContain(" · feed (unverified) · ");
    const profile = await tool("/me/cs-bee/mcp", "get_profile");
    expect(profile.text).toContain("feed (unverified)");
    expect(profile.text).toContain("Sources:");

    const dead = { fn: (async () => new Response("no", { status: 404 })) as typeof fetch };
    for (let i = 0; i < 4; i++) {
      const res = await withFetch(dead, () => post(cookie, `kind=hn&target=user${i}aaa&back=edit`));
      expect(res.headers.get("location")).toContain("src=unverified");
    }
    expect(await listCustomSources(env.DB, "cs-bee")).toHaveLength(CUSTOM_SOURCE_CAP);
    const over = await withFetch(dead, () => post(cookie, "kind=hn&target=user9aaa&back=edit"));
    expect(over.headers.get("location")).toContain("src=limit");

    const removed = await call("/me/edit/sources/remove", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded" },
      body: `id=${(await listCustomSources(env.DB, "cs-bee"))[0].id}&back=edit`,
    });
    expect(removed.headers.get("location")).toContain("src=removed");
    expect(await listCustomSources(env.DB, "cs-bee")).toHaveLength(5);
  });
});

describe("move, delete, budget", () => {
  it("a handle move carries custom sources and delete removes them", async () => {
    const cookie = await signIn("cs-old");
    expect(cookie).toContain("memcp_session");
    await env.DB.prepare("INSERT INTO custom_sources (handle, id, kind, target, label, verified) VALUES ('cs-old', 'abcd1234', 'hn', 'ada', '@ada', 1)").run();
    await env.DB.prepare("INSERT INTO activity (handle, source, kind, title, url, ts) VALUES ('cs-old', 'c:abcd1234', 'post', 'A story', 'https://news.ycombinator.com/item?id=1', '2026-11-20T00:00:00Z')").run();
    await env.DB.batch(moveHandleStatements(env.DB, "cs-old", "cs-new"));
    expect((await listCustomSources(env.DB, "cs-new")).map((r) => r.id)).toEqual(["abcd1234"]);
    expect(await listCustomSources(env.DB, "cs-old")).toEqual([]);
    expect((await listActivity(env.DB, "cs-new"))[0].custom_kind).toBe("hn");
    await deleteProfile(env.DB, "cs-new");
    expect(await listCustomSources(env.DB, "cs-new")).toEqual([]);
    expect(await listActivity(env.DB, "cs-new")).toEqual([]);
  });

  it("one cron profile stays inside the subrequest budget with six custom sources", () => {
    expect(REFRESH_BATCH).toBe(1);
    expect(9 + CUSTOM_SOURCE_CAP * CUSTOM_SUBREQUESTS).toBeLessThanOrEqual(RUN_SUBREQUEST_BUDGET);
    expect(RUN_SUBREQUEST_BUDGET).toBeLessThanOrEqual(44);
  });

  it("addCustomSource records a website summary", async () => {
    await env.DB.prepare("INSERT INTO profiles (handle, github_id, published) VALUES ('cs-web', 4242, 1)").run();
    const fn = routed({
      "https://web.example/": () => html(`<html><head><title>Web</title><meta name="description" content="Hello"></head><body>https://github.com/cs-web</body></html>`),
    });
    const r = await addCustomSource(env, "cs-web", "website", "https://web.example", { fetch: fn });
    expect(r).toEqual({ ok: true, verified: true });
    const t = await tool("/me/cs-web/mcp", "get_profile");
    expect(t.text).toContain("Website: Web. Hello");
    expect(t.text).not.toContain("Website: Web. Hello (unverified)");
    await deleteProfile(env.DB, "cs-web");
  });
});
