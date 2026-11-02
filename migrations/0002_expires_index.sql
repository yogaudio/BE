CREATE INDEX IF NOT EXISTS auth_codes_expires ON auth_codes (expires_at);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires ON refresh_tokens (expires_at);
