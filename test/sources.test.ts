import { describe, expect, it } from "vitest";
import {
  Fetcher,
  blueskyToItems,
  cleanItem,
  discoverFeedLink,
  fetchBlog,
  fetchProfileSources,
  githubBasicAuth,
  githubEventsToItems,
  mastodonToItems,
  parseFeed,
  parseSocialAccounts,
  publicHttpsUrl,
  sameSite,
} from "../src/sources";
import { ATOM, BLOG_HTML, BSKY, GH_EVENTS, GH_SOCIAL, MASTO_STATUSES, NOW, RSS, html, json, xml, zoeFetch } from "./fixtures";

describe("SSRF guard (publicHttpsUrl)", () => {
  it.each([
    "http://example.com/feed", // not https
    "ftp://example.com/",
    "javascript:alert(1)",
    "https://localhost/",
    "https://foo.localhost/",
    "https://127.0.0.1/",
    "https://127.1/", // normalized to 127.0.0.1
    "https://2130706433/", // decimal IPv4
    "https://0x7f.0.0.1/",
    "https://10.0.0.5/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://intranet/",
    "https://printer.local/",
    "https://metadata.google.internal/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://example.com:22/",
    "not a url",
    "",
  ])("blocks %j", (u) => {
    expect(publicHttpsUrl(u)).toBeNull();
  });

  it.each(["https://example.com/", "https://blog.example.co.uk/feed.xml?x=1", "https://example.com:443/", "https://xn--bcher-kva.example/"])(
    "allows %j",
    (u) => {
      expect(publicHttpsUrl(u)).not.toBeNull();
    },
  );
});

describe("Fetcher", () => {
  it("never calls fetch for a blocked URL and counts nothing", async () => {
    const { fn, calls } = zoeFetch();
    const f = new Fetcher(10, fn);
    expect(await f.get("http://blog.zoe.example/")).toBeNull();
    expect(await f.get("https://127.0.0.1/")).toBeNull();
    expect(calls).toEqual([]);
    expect(f.used).toBe(0);
  });

  it("re-validates redirects: a redirect to a private host is not followed", async () => {
    const calls: string[] = [];
    const fn = (async (u: string) => {
      calls.push(u);
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
    }) as unknown as typeof fetch;
    const f = new Fetcher(10, fn);
    expect(await f.get("https://blog.zoe.example/")).toBeNull();
    expect(calls).toEqual(["https://blog.zoe.example/"]);
  });

  it("follows a safe redirect (and counts the hop), but not past maxRedirects", async () => {
    const fn = (async (u: string) =>
      u.endsWith("/a") ? new Response(null, { status: 301, headers: { location: "/b" } }) : new Response("ok")) as unknown as typeof fetch;
    const f = new Fetcher(10, fn);
    const r = await f.get("https://x.example/a");
    expect(r?.text).toBe("ok");
    expect(r?.url).toBe("https://x.example/b");
    expect(f.used).toBe(2);
    expect(await new Fetcher(10, fn).get("https://x.example/a", { maxRedirects: 0 })).toBeNull();
  });

  it("stops at the subrequest budget", async () => {
    const { fn, calls } = zoeFetch();
    const f = new Fetcher(2, fn);
    await f.get("https://blog.zoe.example/");
    await f.get("https://blog.zoe.example/");
    expect(await f.get("https://blog.zoe.example/")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("caps the bytes read", async () => {
    const big = "x".repeat(500_000);
    const f = new Fetcher(5, (async () => new Response(big)) as unknown as typeof fetch);
    const r = await f.get("https://x.example/", { maxBytes: 1000 });
    expect(r?.text.length).toBe(1000);
  });

  it("sends the Authorization header only to api.github.com", async () => {
    const seen: Record<string, string | null> = {};
    const fn = (async (u: string, init: RequestInit) => {
      seen[new URL(u).hostname] = new Headers(init.headers).get("authorization");
      return new Response("{}");
    }) as unknown as typeof fetch;
    const f = new Fetcher(5, fn);
    await f.get("https://api.github.com/x", { authHeader: "Basic abc" });
    await f.get("https://blog.zoe.example/", { authHeader: "Basic abc" });
    expect(seen).toEqual({ "api.github.com": "Basic abc", "blog.zoe.example": null });
  });
});

describe("item cleaning", () => {
  it("caps titles at 200 chars, collapses whitespace and strips hidden characters", () => {
    const it = cleanItem({ source: "blog", kind: "post", title: "a\n\nb​" + "x".repeat(300) + "\u{E0041}", url: "https://x.example/p", ts: "2026-11-01T00:00:00Z" }, NOW);
    expect(it!.title.length).toBeLessThanOrEqual(200);
    expect(it!.title.startsWith("a b")).toBe(true);
    expect(it!.title).not.toMatch(/[​\u{E0041}\n]/u);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://x.example/", "https://x.example/a b", "/relative", ""])("rejects URL %j", (url) => {
    expect(cleanItem({ source: "blog", kind: "post", title: "t", url, ts: "2026-11-01T00:00:00Z" }, NOW)).toBeNull();
  });

  it("rejects empty titles and invalid dates; clamps future dates to now", () => {
    expect(cleanItem({ source: "blog", kind: "post", title: " \n ", url: "https://x.example/", ts: "2026-11-01T00:00:00Z" }, NOW)).toBeNull();
    expect(cleanItem({ source: "blog", kind: "post", title: "t", url: "https://x.example/", ts: "garbage" }, NOW)).toBeNull();
    expect(cleanItem({ source: "blog", kind: "post", title: "t", url: "https://x.example/", ts: "2099-01-01T00:00:00Z" }, NOW)!.ts).toBe("2026-11-26T12:00:00Z");
  });
});

describe("GitHub events", () => {
  const items = githubEventsToItems(GH_EVENTS as any, NOW);
  const byUrl = Object.fromEntries(items.map((i) => [i.url, i]));

  it("collapses pushes per repo (newest wins) and uses the first commit message when GitHub provides one", () => {
    expect(byUrl["https://github.com/zoe/widgets"]).toMatchObject({ kind: "push", title: "Pushed to zoe/widgets", ts: "2026-11-26T10:00:00Z" });
    expect(byUrl["https://github.com/zoe/old"].title).toBe("Pushed to zoe/old: Fix the thing");
  });

  it("maps releases, new repos, stars and PRs; skips branch creates, comments and bad repo names", () => {
    expect(byUrl["https://github.com/zoe/widgets/releases/tag/v2"]).toMatchObject({ kind: "release", title: "Released v2 of zoe/widgets" });
    expect(byUrl["https://github.com/zoe/new-thing"]).toMatchObject({ kind: "repo", title: "Created repo zoe/new-thing" });
    expect(byUrl["https://github.com/other/cool"]).toMatchObject({ kind: "star", title: "Starred other/cool" });
    expect(byUrl["https://github.com/other/cool/pull/7"]).toMatchObject({ kind: "pr", title: "Merged PR #7 in other/cool: Add docs" });
    expect(items).toHaveLength(6);
    expect(items.every((i) => i.source === "github")).toBe(true);
  });
});

describe("social accounts", () => {
  it("takes only Bluesky and Mastodon, and only well-formed https profile URLs", () => {
    expect(parseSocialAccounts(GH_SOCIAL)).toEqual({ bluesky: "zoe.example.com", mastodon: { host: "hachyderm.example", user: "zoe" } });
    expect(parseSocialAccounts([{ provider: "mastodon", url: "https://127.0.0.1/@x" }, { provider: "bluesky", url: "https://evil.example/profile/x" }])).toEqual({
      bluesky: null,
      mastodon: null,
    });
    expect(parseSocialAccounts([{ provider: "mastodon", url: "http://masto.example/@x" }])).toEqual({ bluesky: null, mastodon: null });
  });
});

describe("feeds", () => {
  it("parses RSS 2.0: CDATA, entities, relative links, drops items without link/title/date", () => {
    const items = parseFeed(RSS, "https://blog.zoe.example/");
    expect(items.map((i) => i.title)).toEqual(["Shipping & learning", "Hidden​ text", "Bad link"]);
    expect(items[1].url).toBe("https://blog.zoe.example/posts/relative");
  });

  it("parses Atom: picks rel=alternate and strips markup", () => {
    expect(parseFeed(ATOM, "https://blog.zoe.example/")).toEqual([
      { title: "An atom entry", url: "https://blog.zoe.example/atom-1", ts: "2026-11-22T08:00:00Z" },
    ]);
  });

  it("ignores a truncated final item and caps the item count", () => {
    const many = Array.from({ length: 40 }, (_, i) => `<item><title>t${i}</title><link>https://x.example/${i}</link><pubDate>2026-11-01T00:00:00Z</pubDate></item>`).join("");
    expect(parseFeed(`<rss>${many}</rss>`, "https://x.example/")).toHaveLength(15);
    expect(parseFeed(`<rss><item><title>cut</title><link>https://x.example/c</link>`, "https://x.example/")).toEqual([]);
  });

  it("discovers <link rel=alternate> feeds and ignores stylesheets", () => {
    expect(discoverFeedLink(BLOG_HTML, "https://blog.zoe.example/")).toBe("https://blog.zoe.example/feed.xml");
    expect(discoverFeedLink('<link rel="stylesheet" href="/a.css">', "https://x.example/")).toBeNull();
    expect(discoverFeedLink('<link href="//cdn.other.example/f.xml" type="application/atom+xml" rel="alternate">', "https://x.example/")).toBe("https://cdn.other.example/f.xml");
  });

  it("only follows feed links that stay on the blog's own site", () => {
    expect(sameSite("https://blog.zoe.example/feed", "https://zoe.example/")).toBe(true);
    expect(sameSite("https://www.zoe.example/feed", "https://zoe.example/")).toBe(true);
    expect(sameSite("https://evil.example/feed", "https://zoe.example/")).toBe(false);
    expect(sameSite("https://notzoe.example/feed", "https://zoe.example/")).toBe(false);
  });
});

describe("fetchBlog", () => {
  it("homepage -> discovered feed: 2 subrequests", async () => {
    const { fn, calls } = zoeFetch();
    const f = new Fetcher(10, fn);
    const items = await fetchBlog(f, "https://blog.zoe.example/");
    expect(items!.map((i) => i.title)).toEqual(["Shipping & learning", "Hidden text", "Bad link"].filter((t) => t !== "Bad link"));
    expect(calls.map((c) => c.url)).toEqual(["https://blog.zoe.example/", "https://blog.zoe.example/feed.xml"]);
  });

  it("falls back to common paths, never more than 3 subrequests", async () => {
    const { fn, calls } = zoeFetch({ "https://blog.zoe.example/": () => html("<html>no feed link</html>"), "https://blog.zoe.example/feed.xml": () => new Response("nope", { status: 404 }) });
    const f = new Fetcher(10, fn);
    expect(await fetchBlog(f, "https://blog.zoe.example/")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("ignores a discovered feed on another site", async () => {
    const { fn, calls } = zoeFetch({ "https://blog.zoe.example/": () => html('<link rel="alternate" type="application/rss+xml" href="https://evil.example/f.xml">') });
    await fetchBlog(new Fetcher(10, fn), "https://blog.zoe.example/");
    expect(calls.some((c) => c.url.startsWith("https://evil.example"))).toBe(false);
  });

  it("accepts a blog field that is itself a feed", async () => {
    const { fn, calls } = zoeFetch({ "https://blog.zoe.example/": () => xml(ATOM) });
    const items = await fetchBlog(new Fetcher(10, fn), "https://blog.zoe.example/");
    expect(items).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe("Bluesky and Mastodon", () => {
  it("Bluesky: skips reposts, builds the post URL", () => {
    expect(blueskyToItems(BSKY, "zoe.example.com", NOW)).toEqual([
      { source: "bluesky", kind: "post", title: "Hello from bsky", url: "https://bsky.app/profile/zoe.example.com/post/3kpost1", ts: "2026-11-25T20:00:00Z" },
    ]);
  });

  it("Mastodon: strips HTML and drops statuses whose URL is on another host", () => {
    expect(mastodonToItems(MASTO_STATUSES, "hachyderm.example", NOW)).toEqual([
      { source: "mastodon", kind: "post", title: "Toot & link", url: "https://hachyderm.example/@zoe/5", ts: "2026-11-25T18:00:00Z" },
    ]);
  });
});

describe("fetchProfileSources", () => {
  it("fetches GitHub + exactly the sources GitHub lists, within 9 subrequests", async () => {
    const { fn, calls } = zoeFetch();
    const f = new Fetcher(20, fn);
    const got = await fetchProfileSources(f, {}, "zoe");
    expect(got.githubOk).toBe(true);
    expect(Object.keys(got.items).sort()).toEqual(["blog", "bluesky", "github", "mastodon"]);
    expect(got.labels).toEqual({ github: "@zoe", blog: "blog.zoe.example", bluesky: "zoe.example.com", mastodon: "@zoe@hachyderm.example" });
    expect(f.used).toBeLessThanOrEqual(9);
    const hosts = new Set(calls.map((c) => new URL(c.url).hostname));
    expect([...hosts].sort()).toEqual(["api.github.com", "blog.zoe.example", "hachyderm.example", "public.api.bsky.app"]);
    expect(calls.some((c) => c.url.includes("internal.example") || c.url.includes("twitter"))).toBe(false);
  });

  it("skips sources the owner switched off", async () => {
    const { fn, calls } = zoeFetch();
    await fetchProfileSources(new Fetcher(20, fn), {}, "zoe", new Set(["blog", "mastodon", "github"] as const));
    expect(calls.some((c) => c.url.includes("blog.zoe.example") || c.url.includes("hachyderm") || c.url.includes("/events/"))).toBe(false);
    expect(calls.some((c) => c.url.includes("bsky"))).toBe(true);
  });

  it("uses HTTP Basic client credentials for GitHub, and retries without them on 401", async () => {
    const auth = githubBasicAuth({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
    expect(auth).toBe("Basic " + btoa("id:secret"));
    expect(githubBasicAuth({ GITHUB_CLIENT_ID: "id" })).toBeUndefined();

    const ok = zoeFetch();
    await fetchProfileSources(new Fetcher(20, ok.fn), { auth }, "zoe");
    expect(ok.calls.filter((c) => c.url.startsWith("https://api.github.com")).every((c) => c.auth === auth)).toBe(true);
    expect(ok.calls.filter((c) => !c.url.startsWith("https://api.github.com")).every((c) => c.auth === null)).toBe(true);

    const plain = zoeFetch();
    const wrapped = (async (u: string, init: RequestInit) =>
      new Headers(init.headers).get("authorization") ? json({ message: "Bad credentials" }, 401) : plain.fn(u, init)) as unknown as typeof fetch;
    const got = await fetchProfileSources(new Fetcher(30, wrapped), { auth }, "zoe");
    expect(got.githubOk).toBe(true);
    expect(got.items.github!.length).toBeGreaterThan(0);
  });

  it("GitHub failing reports githubOk=false and fetches nothing else", async () => {
    const { fn, calls } = zoeFetch({ "https://api.github.com/": () => json({ message: "rate limited" }, 403) });
    const got = await fetchProfileSources(new Fetcher(20, fn), {}, "zoe");
    expect(got.githubOk).toBe(false);
    expect(calls.every((c) => c.url.startsWith("https://api.github.com"))).toBe(true);
  });

  it("a blog field that is not a public https host is never fetched", async () => {
    for (const blog of ["http://localhost:8080", "127.0.0.1", "javascript:alert(1)", "https://10.1.1.1/"]) {
      const { fn, calls } = zoeFetch({ "https://api.github.com/users/zoe/events": () => json([]), "https://api.github.com/users/zoe/social": () => json([]), "https://api.github.com/users/zoe": () => json({ blog }) });
      const got = await fetchProfileSources(new Fetcher(20, fn), {}, "zoe");
      expect(got.labels.blog, blog).toBeUndefined();
      expect(calls.every((c) => c.url.startsWith("https://api.github.com")), blog).toBe(true);
    }
  });
});
