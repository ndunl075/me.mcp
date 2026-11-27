import { DEFAULT_CARD_B64 } from "./views/defaultcard";
import type { Profile } from "./db";

// Share cards: the PNG that X / Open Graph unfurls show for a profile link.
// The owner's browser draws it (views/sharecard.ts) and uploads it; the Worker never renders images (free plan: 10 ms CPU).

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const CARD_MAX_BYTES = 400 * 1024;
/** Bump when the card's look changes (views/sharecard.ts) so existing cards count as stale and get redrawn. */
const CARD_DESIGN = 1;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/** Checks signature, an IHDR of exactly 1200x630 and a closing IEND chunk. Returns an error message, or null when acceptable. */
export function validateCardPng(b: Uint8Array): string | null {
  if (b.byteLength > CARD_MAX_BYTES) return "Card is larger than 400 KB.";
  if (b.byteLength < 33 + IEND.length) return "Not a PNG.";
  if (SIGNATURE.some((v, i) => b[i] !== v)) return "Not a PNG.";
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(8) !== 13 || dv.getUint32(12) !== 0x49484452 /* IHDR */) return "Not a PNG.";
  if (dv.getUint32(16) !== CARD_WIDTH || dv.getUint32(20) !== CARD_HEIGHT) return `Card must be ${CARD_WIDTH}x${CARD_HEIGHT}.`;
  const tail = b.byteLength - IEND.length;
  if (IEND.some((v, i) => b[tail + i] !== v)) return "Not a PNG.";
  return null;
}

/** Reads a request body, giving up as soon as it exceeds `max` bytes (so an oversized upload is never buffered whole). */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Short hash of exactly what the card shows. A card is current while its stored version equals this; edits to fields the card
 * doesn't show (bio, about, links, projects, ...) don't count. It doubles as the cache-busting `?v=` of the image URL.
 */
export async function cardVersionOf(
  p: Pick<Profile, "handle" | "name" | "location" | "headline" | "now" | "avatar_url"> & { avatar_rev?: string },
  pageUrl: string,
): Promise<string> {
  // avatar_rev is omitted while empty so cards drawn before the first check stay current.
  const fields = [CARD_DESIGN, p.handle, p.name, p.location, p.headline, p.now, p.avatar_url, pageUrl];
  if (p.avatar_rev) fields.push(p.avatar_rev);
  const data = new TextEncoder().encode(JSON.stringify(fields));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- base64 <-> bytes ---------------------------------------------------------
// Stored as base64 TEXT (see the migration). Uint8Array.fromBase64/toBase64 where the runtime has them, atob/btoa otherwise.

type B64 = { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> };
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as B64).fromBase64;
  if (native) return native.call(Uint8Array, b64);
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function toBase64(b: Uint8Array): string {
  const native = (b as unknown as { toBase64?: () => string }).toBase64;
  if (native) return native.call(b);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- D1 -----------------------------------------------------------------------

/**
 * Stores the card for a published profile (one row per handle). Returns false, writing nothing, if the profile is gone or
 * unpublished: the insert is selected from `profiles`, so it can't race a delete (and the FK would refuse an orphan anyway).
 * When `githubId` is given, the profile row must also belong to that GitHub account (a handle can be deleted and claimed
 * by someone else between a session being issued and this write). Omitted, no ownership check is made.
 */
export async function saveCard(db: D1Database, handle: string, png: Uint8Array, version: string, githubId?: number): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO share_cards (handle, png_b64, version)
       SELECT handle, ?, ? FROM profiles WHERE handle = ? AND published = 1 AND (? IS NULL OR github_id = ?)
       ON CONFLICT (handle) DO UPDATE SET png_b64 = excluded.png_b64, version = excluded.version, updated_at = datetime('now')`,
    )
    .bind(toBase64(png), version, handle, githubId ?? null, githubId ?? null)
    .run();
  return res.meta.changes > 0;
}

/**
 * Reads the GitHub avatar's ETag and stores it when it changed. The avatar URL is stable across photo changes,
 * so this is what makes the share card redraw. Only `avatars.githubusercontent.com` is requested, and a failure
 * leaves the stored revision alone. Returns the profile, with `avatar_rev` updated when the photo changed.
 */
export async function syncAvatarRev(db: D1Database, p: Profile, doFetch: typeof fetch = fetch): Promise<Profile> {
  if (!Number.isInteger(p.github_id) || p.github_id <= 0) return p;
  const url = `https://avatars.githubusercontent.com/u/${p.github_id}?s=64`;
  let etag = "";
  try {
    const res = await doFetch(url, { method: "HEAD", redirect: "manual" });
    await res.body?.cancel();
    if (res.status !== 200) return p;
    etag = (res.headers.get("etag") ?? "").trim().slice(0, 64);
  } catch {
    return p;
  }
  if (!etag || etag === p.avatar_rev) return p;
  await db.prepare("UPDATE profiles SET avatar_rev = ? WHERE handle = ? AND github_id = ?").bind(etag, p.handle, p.github_id).run();
  return { ...p, avatar_rev: etag };
}

/** Version of the stored card for a profile, or null if it has none. */
export async function getCardVersion(db: D1Database, handle: string): Promise<string | null> {
  const r = await db.prepare("SELECT version FROM share_cards WHERE handle = ?").bind(handle).first<{ version: string }>();
  return r?.version ?? null;
}

// ---- serving ------------------------------------------------------------------

const BRAND_CACHE = "public, max-age=3600";
// A card whose URL carries its own version never changes: cache it for a year, at the CDN too (CDN-Cache-Control is what Vercel's
// edge honours for an external rewrite). Anything else (no ?v, an old or guessed one) is short-lived so it can't pin a stale image.
const IMMUTABLE = { "Cache-Control": "public, max-age=31536000, immutable", "CDN-Cache-Control": "max-age=31536000" };
const SHORT = { "Cache-Control": "public, max-age=300" };

const pngResponse = (body: BodyInit | null, etag: string, cache: Record<string, string>, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "image/png", ETag: etag, ...cache } });

const matches = (req: Request, etag: string) =>
  (req.headers.get("if-none-match") ?? "")
    .split(",")
    .some((t) => t.trim().replace(/^W\//, "") === etag);

let brandPng: Uint8Array<ArrayBuffer> | undefined;
function brand(): Uint8Array<ArrayBuffer> {
  return (brandPng ??= fromBase64(DEFAULT_CARD_B64)); // decoded once per isolate
}

/** FNV-1a (two 32-bit lanes with different seeds) over the bytes, as 16 hex chars. Not cryptographic: it only has to change when the image does. */
function fingerprint(b: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 0x01000193);
    h2 = Math.imul(h2 ^ b[i], 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** ETag of the brand card: derived from its bytes, so replacing the image (views/defaultcard.ts) invalidates caches without a manual bump. Computed once per isolate. */
let brandEtag: string | undefined;
const BRAND_ETAG = (): string => (brandEtag ??= `"brand-${fingerprint(brand())}"`);

/** The brand card: landing page og:image, and the stand-in for profiles whose owner hasn't generated a card yet. */
export function defaultCardResponse(req: Request, cache: Record<string, string> = { "Cache-Control": BRAND_CACHE }): Response {
  const etag = BRAND_ETAG();
  return matches(req, etag) ? pngResponse(null, etag, cache, 304) : pngResponse(brand(), etag, cache);
}

/**
 * GET /<handle>/card.png: 404 unless the profile is published; its stored card, else the brand card.
 * One query (profile + card). A conditional request that matches the stored version is answered without reading the PNG column.
 */
export async function profileCardResponse(req: Request, db: D1Database, handle: string, requestedVersion: string | null): Promise<Response> {
  const conditional = req.headers.has("if-none-match");
  const row = await db
    .prepare(
      `SELECT c.version AS version, ${conditional ? "NULL" : "c.png_b64"} AS b64
       FROM profiles p LEFT JOIN share_cards c ON c.handle = p.handle WHERE p.handle = ? AND p.published = 1`,
    )
    .bind(handle)
    .first<{ version: string | null; b64: string | null }>();
  if (!row) return new Response("Not found", { status: 404 });
  if (!row.version) return defaultCardResponse(req, SHORT);
  const etag = `"${row.version}"`;
  const cache = requestedVersion === row.version ? IMMUTABLE : SHORT;
  if (matches(req, etag)) return pngResponse(null, etag, cache, 304);
  let b64 = row.b64;
  if (b64 === null) b64 = (await db.prepare("SELECT png_b64 FROM share_cards WHERE handle = ?").bind(handle).first<{ png_b64: string }>())?.png_b64 ?? null;
  return b64 ? pngResponse(fromBase64(b64), etag, cache) : defaultCardResponse(req, SHORT);
}
