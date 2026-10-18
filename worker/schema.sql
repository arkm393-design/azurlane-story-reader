-- Reading progress, one row per sync key (id = SHA-256 of the key; the key itself is never stored).
CREATE TABLE IF NOT EXISTS progress (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- New keys per (hashed) IP address per day, to slow down abuse.
CREATE TABLE IF NOT EXISTS creates (
  ip TEXT NOT NULL,
  day INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (ip, day)
);
