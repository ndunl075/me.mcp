import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, publish, signIn, unpublish } from "./helpers";
import { cardVersionOf, getCardVersion, saveCard, syncAvatarRev } from "../src/cards";
import { getProfile } from "../src/db";
import { SHARE_CARD_JS } from "../src/views/sharecard";

// ---- a structurally valid PNG of any size (the Worker checks signature, IHDR dimensions and IEND, not pixel data) ----

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** Filler pixel data: constant bytes, or incompressible pseudo-random ones so a card is the size of a real one. */
function idat(n: number, noise: boolean): Uint8Array {
  const out = new Uint8Array(n).fill(7);
  if (noise) {
    let x = 123456789;
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 255;
    }
  }
  return out;
}
function png(width = 1200, height = 630, padding = 0, { iend = true, noise = false } = {}): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat(16 + padding, noise)),
    ...(iend ? [chunk("IEND", new Uint8Array(0))] : []),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const upload = (cookie: string | null, body: BodyInit | Uint8Array | null, opts: { type?: string | null; query?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (opts.type !== null) headers["Content-Type"] = opts.type ?? "image/png";
  return call(`/me/edit/card${opts.query ?? ""}`, { method: "POST", headers, body: body as BodyInit | null });
};

const cardRows = async (handle: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM share_cards WHERE handle = ?").bind(handle).first<{ n: number }>())!.n;

let cookie: string; // heidi, published
let otherCookie: string; // ivan, published

beforeAll(async () => {
  cookie = await signIn("heidi");
  await publish(cookie, { name: "Heidi", headline: "Builds things", now: "Shipping cards" });
  otherCookie = await signIn("ivan");
  await publish(otherCookie, { name: "Ivan" });
});

describe("POST /edit/card", () => {
  it("rejects requests without a session", async () => {
    const res = await upload(null, png());
    expect(res.status).toBe(401);
    expect(await cardRows("heidi")).toBe(0);
  });

  it("rejects a session that has no profile (not the owner)", async () => {
    const c = await signIn("judy");
    await call("/me/edit/delete", { method: "POST", headers: { Cookie: c } });
    const res = await upload(c, png());
    expect(res.status).toBe(403);
    expect(await cardRows("judy")).toBe(0);
  });

  it("rejects a body that is not a PNG", async () => {
    for (const body of [new TextEncoder().encode("<html>hello</html>"), new Uint8Array(0), png().subarray(0, 20)]) {
      expect((await upload(cookie, body)).status).toBe(400);
    }
  });

  it("rejects a PNG without its closing IEND chunk", async () => {
    expect((await upload(cookie, png(1200, 630, 0, { iend: false }))).status).toBe(400);
  });

  it("rejects the wrong dimensions", async () => {
    for (const [w, h] of [
      [1200, 628],
      [630, 1200],
      [600, 315],
      [1201, 630],
    ]) {
      const res = await upload(cookie, png(w, h));
      expect(res.status, `${w}x${h}`).toBe(400);
    }
  });

  it("rejects anything over 400 KB, with and without a declared length", async () => {
    const big = png(1200, 630, 401 * 1024);
    expect((await upload(cookie, big)).status).toBe(400);
    const streamed = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(big);
        ctrl.close();
      },
    });
    const res = await call("/me/edit/card", { method: "POST", headers: { Cookie: cookie, "Content-Type": "image/png" }, body: streamed, duplex: "half" } as RequestInit);
    expect(res.status).toBe(400);
    expect(await cardRows("heidi")).toBe(0);
  });

  it("accepts a card just under the limit", async () => {
    const ok = png(1200, 630, 399 * 1024);
    expect(ok.length).toBeLessThanOrEqual(400 * 1024);
    expect((await upload(cookie, ok)).status).toBe(204);
  });

  it("rejects an owner whose profile is unpublished", async () => {
    const c = await signIn("mallory");
    await publish(c, { name: "Mallory" });
    await unpublish(c);
    const res = await upload(c, png());
    expect(res.status).toBe(403);
    expect(await cardRows("mallory")).toBe(0);
    await publish(c, { name: "Mallory" });
    expect((await upload(c, png())).status).toBe(204);
  });

  it("requires Content-Type: image/png", async () => {
    for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "application/octet-stream"]) {
      expect((await upload(cookie, png(), { type })).status, String(type)).toBe(400);
    }
  });

  it("answers 409 when the profile changed since the card was drawn", async () => {
    const res = await upload(cookie, png(), { query: "?v=0000000000000000" });
    expect(res.status).toBe(409);
  });
});

describe("saveCard ownership check", () => {
  it("writes when github_id matches or is omitted, refuses (writing nothing) when it doesn't", async () => {
    const cookie = await signIn("ownercheck");
    await publish(cookie);
    const row = await env.DB.prepare("SELECT github_id FROM profiles WHERE handle = 'ownercheck'").first<{ github_id: number }>();
    const bytes = png();
    expect(await saveCard(env.DB, "ownercheck", bytes, "v-wrong", row!.github_id + 1)).toBe(false);
    expect(await getCardVersion(env.DB, "ownercheck")).toBeNull();
    expect(await saveCard(env.DB, "ownercheck", bytes, "v-right", row!.github_id)).toBe(true);
    expect(await getCardVersion(env.DB, "ownercheck")).toBe("v-right");
    expect(await saveCard(env.DB, "ownercheck", bytes, "v-open")).toBe(true); // no id: no check (backward compatible)
    expect(await getCardVersion(env.DB, "ownercheck")).toBe("v-open");
    expect(await saveCard(env.DB, "ownercheck", bytes, "v-hijack", row!.github_id + 1)).toBe(false);
    expect(await getCardVersion(env.DB, "ownercheck")).toBe("v-open");
  });
});

describe("GET /:handle/card.png", () => {
  it("serves the default brand card when the profile has none", async () => {
    const res = await call("/me/ivan/card.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300"); // a stand-in: short, the real card may appear any time
    expect(res.headers.get("etag")).toBeTruthy();
    const b = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(b.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(new DataView(b.buffer).getUint32(16)).toBe(1200);
    expect(new DataView(b.buffer).getUint32(20)).toBe(630);
    // The same image is the landing page's og:image.
    const landingRes = await call("/me/card.png");
    expect(landingRes.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(new Uint8Array(await landingRes.arrayBuffer())).toEqual(b);
  });

  it("the brand card's ETag is derived from its bytes, not hardcoded", async () => {
    const res = await call("/me/card.png");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"brand-[0-9a-f]{16}"$/);
    expect(etag).not.toBe('"brand-1"');
    expect((await call("/me/ivan/card.png")).headers.get("etag")).toBe(etag); // same image, same tag
    const again = await call("/me/card.png");
    expect(again.headers.get("etag")).toBe(etag); // stable
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it("answers conditional requests for the default card with 304", async () => {
    const etag = (await call("/me/card.png")).headers.get("etag")!;
    const res = await call("/me/ivan/card.png", { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
  });

  it("stores a valid upload and serves exactly those bytes with caching headers", async () => {
    const card = png(1200, 630, 5000);
    const up = await upload(cookie, card);
    expect(up.status).toBe(204);
    expect(await cardRows("heidi")).toBe(1);

    // No ?v: short TTL, so a stale or guessed URL can't pin an old image.
    const res = await call("/me/heidi/card.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(card);

    const again = await call("/me/heidi/card.png", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("public, max-age=300");

    // Handles are case-insensitive, like profile pages.
    expect((await call("/me/Heidi/card.png")).status).toBe(200);
  });

  it("caches immutably only when ?v is the stored card's version", async () => {
    const etag = (await call("/me/heidi/card.png")).headers.get("etag")!;
    const version = etag.replaceAll('"', "");
    const hit = await call(`/me/heidi/card.png?v=${version}`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(hit.headers.get("cdn-cache-control")).toBe("max-age=31536000");
    const hit304 = await call(`/me/heidi/card.png?v=${version}`, { headers: { "If-None-Match": etag } });
    expect(hit304.status).toBe(304);
    expect(hit304.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const v of ["0", "ffffffffffffffff", ""]) {
      const miss = await call(`/me/heidi/card.png?v=${v}`);
      expect(miss.headers.get("cache-control"), v).toBe("public, max-age=300");
      expect(miss.headers.get("cdn-cache-control"), v).toBeNull();
    }
  });

  it("round-trips a realistic ~200 KB card byte for byte", async () => {
    const card = png(1200, 630, 200 * 1024, { noise: true });
    expect(card.length).toBeGreaterThan(200 * 1024);
    expect((await upload(cookie, card)).status).toBe(204);
    const res = await call("/me/heidi/card.png");
    expect(res.headers.get("content-length") ?? String(card.length)).toBe(String(card.length));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(card);
  });

  it("replaces the card on re-upload (one row per handle) and serves the new bytes", async () => {
    const next = png(1200, 630, 7000, { noise: true });
    expect((await upload(cookie, next)).status).toBe(204);
    expect(await cardRows("heidi")).toBe(1);
    expect(new Uint8Array(await (await call("/me/heidi/card.png")).arrayBuffer())).toEqual(next);
  });

  it("only ever writes the signed-in owner's card", async () => {
    expect(await cardRows("ivan")).toBe(0);
    const ivanCard = new Uint8Array(await (await call("/me/ivan/card.png")).arrayBuffer());
    expect(ivanCard).not.toEqual(new Uint8Array(await (await call("/me/heidi/card.png")).arrayBuffer()));
  });

  it("is 404 for an unknown handle", async () => {
    expect((await call("/me/nobody-here/card.png")).status).toBe(404);
  });

  it("is 404 for an unpublished profile, even with a stored card, and returns once republished", async () => {
    expect((await unpublish(cookie)).status).toBe(302);
    expect((await call("/me/heidi/card.png")).status).toBe(404);
    await publish(cookie);
    expect((await call("/me/heidi/card.png")).status).toBe(200);
  });
});

describe("profile page meta tags and script", () => {
  const meta = (html: string, key: string) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1];

  it("uses a large summary card with the card image", async () => {
    const html = await (await call("/me/heidi")).text();
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
    const img = meta(html, "og:image")!;
    expect(img).toMatch(/^http:\/\/localhost\/me\/heidi\/card\.png\?v=[0-9a-f]{16}$/);
    expect(meta(html, "twitter:image")).toBe(img);
    expect(meta(html, "og:image:width")).toBe("1200");
    expect(meta(html, "og:image:height")).toBe("630");
  });

  it("changes the image URL when the card is regenerated for new content", async () => {
    const v1 = meta(await (await call("/me/heidi")).text(), "og:image");
    expect(v1).toMatch(/v=[0-9a-f]{16}$/);
    // Editing a field the card shows makes the stored card stale; the owner's page asks for a redraw at the new version.
    await publish(cookie, { name: "Heidi", headline: "Builds things", now: "Shipping cards v2" });
    const page = await (await call("/me/heidi", { headers: { Cookie: cookie } })).text();
    expect(page).toContain('id="share-card-data"');
    const post = page.match(/"post":"([^"]+)"/)![1];
    expect(post).toMatch(/^\/me\/edit\/card\?v=[0-9a-f]{16}$/);
    // Until it is uploaded, the public page still points at the old card.
    expect(meta(await (await call("/me/heidi")).text(), "og:image")).toBe(v1);
    expect((await upload(cookie, png(), { query: post.replace("/me/edit/card", "") })).status).toBe(204);
    const v2 = meta(await (await call("/me/heidi")).text(), "og:image");
    expect(v2).not.toBe(v1);
  });

  it("ignores edits to fields the card doesn't show", async () => {
    const page = () => call("/me/heidi", { headers: { Cookie: cookie } }).then((r) => r.text());
    expect(await page()).not.toContain("share-card-data");
    await publish(cookie, { name: "Heidi", headline: "Builds things", now: "Shipping cards v2", bio: "A new bio", about: "More about me" });
    expect(await page()).not.toContain("share-card-data");
  });

  it("falls back to the default card URL for a profile without a card", async () => {
    const html = await (await call("/me/ivan")).text();
    expect(meta(html, "og:image")).toMatch(/\/me\/ivan\/card\.png\?v=0$/);
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
  });

  it("landing page uses the default card as a large summary", async () => {
    const html = await (await call("/me/")).text();
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "og:image")).toBe("http://localhost/me/card.png");
    expect(meta(html, "og:image:width")).toBe("1200");
  });

  it("pages without an image keep the small card", async () => {
    const html = await (await call("/me/nobody-here")).text();
    expect(meta(html, "twitter:card")).toBe("summary");
    expect(meta(html, "og:image")).toBeUndefined();
  });

  it("gives the owner the card script only when the card is missing or stale", async () => {
    // ivan has no card yet: the owner's page draws one, posting back to the base-relative upload URL.
    const missing = await (await call("/me/ivan", { headers: { Cookie: otherCookie } })).text();
    expect(missing).toContain('id="share-card-data"');
    expect(missing).toMatch(/"post":"\/me\/edit\/card\?v=[^"]+"/);
    // Visitors and other users never get it.
    expect(await (await call("/me/ivan")).text()).not.toContain("share-card-data");
    expect(await (await call("/me/ivan", { headers: { Cookie: cookie } })).text()).not.toContain("share-card-data");

    // Upload for the version the page asked for: fresh, so no script on the next view.
    const post = missing.match(/"post":"([^"]+)"/)![1].replace("/me", "");
    const res = await call(`/me${post}`, { method: "POST", headers: { Cookie: otherCookie, "Content-Type": "image/png" }, body: png() as BodyInit });
    expect(res.status).toBe(204);
    expect(await (await call("/me/ivan", { headers: { Cookie: otherCookie } })).text()).not.toContain("share-card-data");

    // A shown field changes (the avatar here): stale again.
    await env.DB.prepare("UPDATE profiles SET avatar_url = 'https://avatars.githubusercontent.com/u/1?v=4' WHERE handle = 'ivan'").run();
    expect(await (await call("/me/ivan", { headers: { Cookie: otherCookie } })).text()).toContain("share-card-data");
  });

  it("escapes profile text in the script data block", async () => {
    const c = await signIn("karl");
    await publish(c, { name: "</script><script>alert(1)</script>", now: "a b" });
    const html = await (await call("/me/karl", { headers: { Cookie: c } })).text();
    const block = html.match(/<script type="application\/json" id="share-card-data">([\s\S]*?)<\/script>/)![1];
    expect(block).not.toContain("<");
    expect(block).not.toContain(" ");
    expect(JSON.parse(block).name).toContain("</script>");
  });
});

describe("cleanup and referential integrity", () => {
  const devId = async (login: string) =>
    (await env.DB.prepare("SELECT github_id AS id FROM profiles WHERE handle = ?").bind(login).first<{ id: number }>())!.id;

  it("the database refuses a card for a handle with no profile", async () => {
    await expect(
      env.DB.prepare("INSERT INTO share_cards (handle, png_b64, version) VALUES ('ghost', 'AAAA', 'x')").run(),
    ).rejects.toThrow();
    expect(await cardRows("ghost")).toBe(0);
  });

  it("deleting a profile deletes its card", async () => {
    const c = await signIn("lena");
    await publish(c, { name: "Lena" });
    expect((await upload(c, png())).status).toBe(204);
    expect(await cardRows("lena")).toBe(1);
    const res = await call("/me/edit/delete", { method: "POST", headers: { Cookie: c } });
    expect(res.status).toBe(302);
    expect(await cardRows("lena")).toBe(0);
    expect((await call("/me/lena/card.png")).status).toBe(404);
  });

  it("a GitHub rename (same account, new login) drops the old handle's card", async () => {
    const old = await signIn("nora-old");
    await publish(old, { name: "Nora" });
    expect((await upload(old, png())).status).toBe(204);
    // Make the old row belong to the account that the dev login "nora-new" will present.
    await signIn("nora-new");
    const id = await devId("nora-new");
    await env.DB.prepare("DELETE FROM profiles WHERE handle = 'nora-new'").run();
    await env.DB.prepare("UPDATE profiles SET github_id = ? WHERE handle = 'nora-old'").bind(id).run();
    await signIn("nora-new"); // sign-in finds the account under another handle and replaces it
    expect(await cardRows("nora-old")).toBe(0);
    expect((await call("/me/nora-old/card.png")).status).toBe(404);
  });

  it("a handle taken over by another GitHub account does not inherit the previous owner's card", async () => {
    const c = await signIn("omar");
    await publish(c, { name: "Omar" });
    expect((await upload(c, png())).status).toBe(204);
    await env.DB.prepare("UPDATE profiles SET github_id = 999999999 WHERE handle = 'omar'").run(); // previous owner renamed away
    await signIn("omar"); // a different account now has this login
    expect(await cardRows("omar")).toBe(0);
    const res = await call("/me/omar/card.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300"); // brand card, not the old one
  });
});

describe("avatar changes and fallback fonts", () => {
  it("a new avatar etag changes the card version; the same etag and a failed check do not", async () => {
    await env.DB.prepare("INSERT INTO profiles (handle, github_id, published, name, avatar_url) VALUES ('avrev', 515151, 1, 'Av', 'https://github.com/avrev.png')").run();
    const load = async () => (await getProfile(env.DB, "avrev"))!;
    const sameUrl = "http://localhost/me/avrev";
    const before = await cardVersionOf(await load(), sameUrl);
    const head = (etag: string | null, status = 200) =>
      (async () => new Response(null, { status, headers: etag ? { etag } : {} })) as typeof fetch;
    const changed = await syncAvatarRev(env.DB, await load(), head('"photo-2"'));
    expect(changed.avatar_rev).toBe('"photo-2"');
    expect(await cardVersionOf(changed, sameUrl)).not.toBe(before);
    const again = await syncAvatarRev(env.DB, changed, head('"photo-2"'));
    expect(again.avatar_rev).toBe('"photo-2"');
    expect(await cardVersionOf(again, sameUrl)).toBe(await cardVersionOf(changed, sameUrl));
    const missed = await syncAvatarRev(env.DB, again, head(null, 404));
    expect(missed.avatar_rev).toBe('"photo-2"');
  });

  it("skips the upload when the brand fonts are not ready, before the card is posted", () => {
    const skip = SHARE_CARD_JS.indexOf("skipped:fonts");
    const post = SHARE_CARD_JS.indexOf("cfg.post");
    expect(skip).toBeGreaterThan(0);
    expect(post).toBeGreaterThan(skip);
  });
});

describe("Share on X", () => {
  it("links the profile page last, so X unfurls its card, and keeps the MCP URL in the text", async () => {
    const html = await (await call("/me/heidi", { headers: { Cookie: cookie } })).text();
    const href = html.match(/href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/)![1].replaceAll("&amp;", "&").replaceAll("&#39;", "'");
    const q = new URL(href).searchParams;
    expect(q.get("url")).toBe("http://localhost/me/heidi");
    expect(q.get("text")).toContain("http://localhost/me/heidi/mcp");
  });
});
