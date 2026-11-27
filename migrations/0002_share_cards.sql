-- One 1200x630 PNG per profile, drawn in the owner's browser and used as the X / Open Graph unfurl image.
-- updated_at is the profile's updated_at the card was drawn from; the card is stale once the profile is newer.
CREATE TABLE share_cards (
  handle     TEXT PRIMARY KEY,
  png        BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
