-- Sunucu modu passkey (WebAuthn) girişi. id = kimlik bilgisi kimliği (base64url); public_key COSE biçiminde,
-- gizli değildir. transports JSON dizi (kayıtta bildirildiyse); counter son kabul edilen imza sayacı.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);
