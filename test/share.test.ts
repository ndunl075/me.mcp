import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { call, publish, signIn, unpublish } from "./helpers";

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
function png(width = 1200, height = 630, padding = 0, { iend = true } = {}): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(16 + padding).fill(7)),
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

  it("requires Content-Type: image/png", async () => {
    for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "application/octet-stream"]) {
      expect((await upload(cookie, png(), { type })).status, String(type)).toBe(400);
    }
  });

  it("answers 409 when the profile changed since the card was drawn", async () => {
    const res = await upload(cookie, png(), { query: "?v=1999-01-01%2000%3A00%3A00" });
    expect(res.status).toBe(409);
  });
});

describe("GET /:handle/card.png", () => {
  it("serves the default brand card when the profile has none", async () => {
    const res = await call("/me/ivan/card.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("etag")).toBeTruthy();
    const b = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(b.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(new DataView(b.buffer).getUint32(16)).toBe(1200);
    expect(new DataView(b.buffer).getUint32(20)).toBe(630);
    // The same image is the landing page's og:image.
    const landing = new Uint8Array(await (await call("/me/card.png")).arrayBuffer());
    expect(landing).toEqual(b);
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

    const res = await call("/me/heidi/card.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-z-]+"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(card);

    const again = await call("/me/heidi/card.png", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);

    // Handles are case-insensitive, like profile pages.
    expect((await call("/me/Heidi/card.png")).status).toBe(200);
  });

  it("replaces the card on re-upload (one row per handle) and changes the ETag", async () => {
    const before = (await call("/me/heidi/card.png")).headers.get("etag");
    const next = png(1200, 630, 7000);
    expect((await upload(cookie, next)).status).toBe(204);
    expect(await cardRows("heidi")).toBe(1);
    const res = await call("/me/heidi/card.png");
    expect(res.headers.get("etag")).not.toBe(before);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(next);
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
    expect(img).toMatch(/^http:\/\/localhost\/me\/heidi\/card\.png\?v=\d+$/);
    expect(meta(html, "twitter:image")).toBe(img);
    expect(meta(html, "og:image:width")).toBe("1200");
    expect(meta(html, "og:image:height")).toBe("630");
  });

  it("changes the image URL when the card is regenerated", async () => {
    const v1 = meta(await (await call("/me/heidi")).text(), "og:image");
    await env.DB.prepare("UPDATE profiles SET updated_at = '2099-01-01 00:00:00' WHERE handle = 'heidi'").run();
    expect((await upload(cookie, png(), { query: "?v=2099-01-01%2000%3A00%3A00" })).status).toBe(204);
    const v2 = meta(await (await call("/me/heidi")).text(), "og:image");
    expect(v2).not.toBe(v1);
    expect(v2).toMatch(/v=20990101000000$/);
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

    // The profile moves on: stale again.
    await env.DB.prepare("UPDATE profiles SET updated_at = '2099-06-01 00:00:00' WHERE handle = 'ivan'").run();
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

describe("cleanup", () => {
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
});
