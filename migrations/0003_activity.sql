-- Recent public activity collected from sources the person lists on their own GitHub profile.
-- ts is ISO-8601 UTC ("2026-11-26T12:34:56Z"), so it sorts as text. At most ~15 rows are kept per handle (src/activity.ts).
CREATE TABLE activity (
  handle TEXT NOT NULL,
  source TEXT NOT NULL,   -- github | blog | bluesky | mastodon
  kind   TEXT NOT NULL,   -- push | release | repo | star | pr | post
  title  TEXT NOT NULL,
  url    TEXT NOT NULL,
  ts     TEXT NOT NULL,
  PRIMARY KEY (handle, source, url)
);
CREATE INDEX activity_handle_ts ON activity (handle, ts DESC);

-- One row per source discovered for a profile. `enabled` is the owner's on/off switch; `label` is a short
-- human-readable identifier (blog host, @handle). The 'github' row's last_fetched is also the profile's refresh marker.
CREATE TABLE sources (
  handle       TEXT NOT NULL,
  source       TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  label        TEXT NOT NULL DEFAULT '',
  last_fetched TEXT,
  PRIMARY KEY (handle, source)
);
