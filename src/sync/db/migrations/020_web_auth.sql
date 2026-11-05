-- Sunucu modu web girişi: TOTP iki aşamalı doğrulama, çerezli oturumlar, giriş denemeleri (kilit DB'de,
-- bağlantıdan bağımsız). TOTP sırrı host.encrypt ile şifreli; onaylanmamış sır totp_enabled = 0 ile bekler.
ALTER TABLE users ADD COLUMN totp_secret_enc BLOB;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
-- son kabul edilen TOTP adımı: aynı kod ikinci kez kullanılamaz
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;

-- id_hash = sha256(belirteç) hex; belirtecin kendisi DB'ye yazılmaz
CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX web_sessions_user ON web_sessions(user_id);

-- ok: 1 giriş tamam, 0 başarısız (kilide sayılır), 2 sayılmayan ara sonuç (kilitliyken red, TOTP bekleniyor)
CREATE TABLE web_login_attempts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ip TEXT NOT NULL,
  username TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX web_login_attempts_ts ON web_login_attempts(ts);
