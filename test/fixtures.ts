/** Canned responses for the sources fetcher. Shapes follow the live APIs (checked November 2026). */

export const NOW = Date.parse("2026-11-26T12:00:00Z");

export const GH_USER = { login: "zoe", blog: "blog.zoe.example" };

export const GH_SOCIAL = [
  { provider: "twitter", url: "https://twitter.com/zoe" },
  { provider: "bluesky", url: "https://bsky.app/profile/zoe.example.com" },
  { provider: "mastodon", url: "https://hachyderm.example/@zoe" },
  { provider: "generic", url: "https://internal.example/should-not-be-fetched" },
];

export const GH_EVENTS = [
  { type: "PushEvent", created_at: "2026-11-26T10:00:00Z", repo: { name: "zoe/widgets" }, payload: { ref: "refs/heads/main", head: "abc" } },
  { type: "PushEvent", created_at: "2026-11-26T09:00:00Z", repo: { name: "zoe/widgets" }, payload: { ref: "refs/heads/dev" } },
  { type: "PushEvent", created_at: "2026-11-25T09:00:00Z", repo: { name: "zoe/old" }, payload: { commits: [{ message: "Fix the thing\n\nlong body" }] } },
  { type: "ReleaseEvent", created_at: "2026-11-24T09:00:00Z", repo: { name: "zoe/widgets" }, payload: { action: "published", release: { html_url: "https://github.com/zoe/widgets/releases/tag/v2", tag_name: "v2", name: "" } } },
  { type: "CreateEvent", created_at: "2026-11-23T09:00:00Z", repo: { name: "zoe/new-thing" }, payload: { ref_type: "repository" } },
  { type: "CreateEvent", created_at: "2026-11-23T08:00:00Z", repo: { name: "zoe/widgets" }, payload: { ref_type: "branch", ref: "x" } },
  { type: "WatchEvent", created_at: "2026-11-22T09:00:00Z", repo: { name: "other/cool" }, payload: { action: "started" } },
  { type: "PullRequestEvent", created_at: "2026-11-21T09:00:00Z", repo: { name: "other/cool" }, payload: { action: "closed", pull_request: { html_url: "https://github.com/other/cool/pull/7", title: "Add docs", number: 7, merged: true } } },
  { type: "PullRequestEvent", created_at: "2026-11-20T09:00:00Z", repo: { name: "other/cool" }, payload: { action: "opened", pull_request: { html_url: "https://github.com/other/cool/pull/7", title: "Add docs", number: 7, merged: false } } },
  { type: "IssueCommentEvent", created_at: "2026-11-19T09:00:00Z", repo: { name: "other/cool" }, payload: {} },
  { type: "PushEvent", created_at: "2026-11-19T09:00:00Z", repo: { name: "../../etc" }, payload: {} },
];

export const BLOG_HTML = `<!doctype html><html><head><title>Zoe</title>
<link rel="stylesheet" href="/s.css">
<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
</head><body>hi</body></html>`;

export const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Zoe's blog</title><link>https://blog.zoe.example/</link>
<item><title><![CDATA[Shipping &amp; learning]]></title><link>https://blog.zoe.example/posts/shipping</link><pubDate>Tue, 24 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>Hidden&#x200B; text</title><link>/posts/relative</link><pubDate>Mon, 23 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Mon, 23 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://blog.zoe.example/nodate</link></item>
</channel></rss>`;

export const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>
<entry><title type="html">An &lt;b&gt;atom&lt;/b&gt; entry</title><link rel="alternate" href="https://blog.zoe.example/atom-1"/><link rel="edit" href="https://blog.zoe.example/edit"/><updated>2026-11-22T08:00:00Z</updated></entry>
</feed>`;

export const BSKY = {
  feed: [
    { post: { uri: "at://did:plc:abc/app.bsky.feed.post/3kpost1", author: { handle: "zoe.example.com" }, record: { text: "Hello from bsky", createdAt: "2026-11-25T20:00:00.000Z" } } },
    { post: { uri: "at://did:plc:abc/app.bsky.feed.post/3kpost2", author: { handle: "zoe.example.com" }, record: { text: "A repost", createdAt: "2026-11-25T21:00:00.000Z" } }, reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
  ],
};

export const MASTO_LOOKUP = { id: "1099", username: "zoe" };
export const MASTO_STATUSES = [
  { id: "5", url: "https://hachyderm.example/@zoe/5", content: "<p>Toot &amp; <a href=\"x\">link</a></p>", created_at: "2026-11-25T18:00:00.000Z" },
  { id: "6", url: "https://evil.example/@zoe/6", content: "<p>Wrong host</p>", created_at: "2026-11-25T19:00:00.000Z" },
];

export const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
export const xml = (s: string) => new Response(s, { headers: { "content-type": "application/xml" } });
export const html = (s: string) => new Response(s, { headers: { "content-type": "text/html" } });

/** A fetch mock for everything zoe lists. Records every request URL (and Authorization header) it receives. */
export function zoeFetch(overrides: Record<string, (url: string) => Response> = {}) {
  const calls: { url: string; auth: string | null }[] = [];
  const routes: [string, (url: string) => Response][] = [
    ["https://api.github.com/users/zoe/events/public", () => json(GH_EVENTS)],
    ["https://api.github.com/users/zoe/social_accounts", () => json(GH_SOCIAL)],
    ["https://api.github.com/users/zoe", () => json(GH_USER)],
    ["https://blog.zoe.example/feed.xml", () => xml(RSS)],
    ["https://blog.zoe.example/", () => html(BLOG_HTML)],
    ["https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed", () => json(BSKY)],
    ["https://hachyderm.example/api/v1/accounts/lookup", () => json(MASTO_LOOKUP)],
    ["https://hachyderm.example/api/v1/accounts/1099/statuses", () => json(MASTO_STATUSES)],
  ];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    for (const [prefix, make] of [...Object.entries(overrides), ...routes]) {
      if (url.startsWith(prefix)) return make(url);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}
