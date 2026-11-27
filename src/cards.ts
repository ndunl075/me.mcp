import { DEFAULT_CARD_B64 } from "./views/defaultcard";

// Share cards: the PNG that X / Open Graph unfurls show for a profile link.
// The owner's browser draws it (views/sharecard.ts) and uploads it; the Worker never renders images (free plan: 10 ms CPU).

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const CARD_MAX_BYTES = 400 * 1024;

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

// ---- D1 -----------------------------------------------------------------------

/** When the stored card was drawn (the profile updated_at it reflects), or null if the profile has none. */
export async function getCardVersion(db: D1Database, handle: string): Promise<string | null> {
  const r = await db.prepare("SELECT updated_at FROM share_cards WHERE handle = ?").bind(handle).first<{ updated_at: string }>();
  return r?.updated_at ?? null;
}

export async function saveCard(db: D1Database, handle: string, png: Uint8Array, updatedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO share_cards (handle, png, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (handle) DO UPDATE SET png = excluded.png, updated_at = excluded.updated_at`,
    )
    .bind(handle, png, updatedAt)
    .run();
}

export async function deleteCard(db: D1Database, handle: string): Promise<void> {
  await db.prepare("DELETE FROM share_cards WHERE handle = ?").bind(handle).run();
}

// ---- serving ------------------------------------------------------------------

function bytesOf(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const CACHE = "public, max-age=3600";
const DEFAULT_ETAG = '"default-1"';

const pngResponse = (body: BodyInit | null, etag: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "image/png", "Cache-Control": CACHE, ETag: etag } });

const matches = (req: Request, etag: string) =>
  (req.headers.get("if-none-match") ?? "")
    .split(",")
    .some((t) => t.trim().replace(/^W\//, "") === etag);

/** The brand card, shown on the landing page and for profiles whose owner hasn't generated a card yet. */
export function defaultCardResponse(req: Request): Response {
  return matches(req, DEFAULT_ETAG) ? pngResponse(null, DEFAULT_ETAG, 304) : pngResponse(bytesOf(DEFAULT_CARD_B64), DEFAULT_ETAG);
}

/** The profile's stored card, or the default card if there is none. Conditional requests are answered without reading the PNG. */
export async function profileCardResponse(req: Request, db: D1Database, handle: string): Promise<Response> {
  const meta = await db
    .prepare("SELECT updated_at, length(png) AS size FROM share_cards WHERE handle = ?")
    .bind(handle)
    .first<{ updated_at: string; size: number }>();
  if (!meta) return defaultCardResponse(req);
  const etag = `"${meta.updated_at.replace(/\D/g, "")}-${meta.size}"`;
  if (matches(req, etag)) return pngResponse(null, etag, 304);
  const row = await db.prepare("SELECT png FROM share_cards WHERE handle = ?").bind(handle).first<{ png: ArrayBuffer | number[] }>();
  if (!row) return defaultCardResponse(req);
  // D1 returns BLOBs as arrays of byte values (an ArrayBuffer under some runtimes).
  const png = Array.isArray(row.png) ? Uint8Array.from(row.png) : new Uint8Array(row.png);
  return pngResponse(png, etag);
}
