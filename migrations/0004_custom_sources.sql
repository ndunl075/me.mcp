-- Sources an owner adds themselves (a feed, a personal site, Hacker News, dev.to, npm).
-- `verified` is 1 when the source links back to the person's GitHub profile or their me.mcp page.
-- Activity rows from these use source = 'c:' || id, so each one stays its own bucket.
CREATE TABLE custom_sources (
  handle       TEXT NOT NULL,
  id           TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- feed | website | hn | devto | npm
  target       TEXT NOT NULL,             -- https URL or username
  label        TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',  -- website title + description
  verified     INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_fetched TEXT,
  failures     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (handle, id),
  UNIQUE (handle, kind, target)
);
