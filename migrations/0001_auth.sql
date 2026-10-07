CREATE TABLE auth_codes (
  hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE refresh_tokens (
  hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX refresh_tokens_member ON refresh_tokens (member_id);
