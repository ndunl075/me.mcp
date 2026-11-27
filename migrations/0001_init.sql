CREATE TABLE profiles (
  handle      TEXT PRIMARY KEY,
  github_id   INTEGER NOT NULL UNIQUE,
  published   INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL DEFAULT '',
  avatar_url  TEXT NOT NULL DEFAULT '',
  headline    TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  bio         TEXT NOT NULL DEFAULT '',
  now         TEXT NOT NULL DEFAULT '',
  about       TEXT NOT NULL DEFAULT '',
  contact     TEXT NOT NULL DEFAULT '',
  links       TEXT NOT NULL DEFAULT '[]',
  projects    TEXT NOT NULL DEFAULT '[]',
  key_hash    TEXT,
  calls_total INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX profiles_published_updated ON profiles (published, updated_at);

CREATE TABLE call_daily (
  handle TEXT NOT NULL,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (handle, day)
);

CREATE TABLE call_clients (
  handle TEXT NOT NULL,
  client TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (handle, client)
);
