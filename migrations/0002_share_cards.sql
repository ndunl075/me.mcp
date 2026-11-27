-- One 1200x630 PNG per profile, drawn in the owner's browser and used as the X / Open Graph unfurl image.
-- png_b64 is the PNG as base64 TEXT, not a BLOB: D1 returns BLOBs as arrays of byte values (one JS number per byte,
-- ~170k for a card), which costs several ms of CPU to decode; a string costs almost nothing.
-- version is a short hash of exactly the profile fields the card shows (see cardVersionOf in src/cards.ts); the card is
-- stale when it no longer matches. The row goes away with its profile.
CREATE TABLE share_cards (
  handle     TEXT PRIMARY KEY REFERENCES profiles (handle) ON DELETE CASCADE,
  png_b64    TEXT NOT NULL,
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
