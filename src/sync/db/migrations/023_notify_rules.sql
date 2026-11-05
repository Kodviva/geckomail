-- Kişiye ait bildirim kuralları (§10.1): koşul grupları (VEYA) içinde koşullar (VE), eşleşince seviye uygulanır.
-- Sıra: küçük position önce. notify_account_prefs: kullanıcının hesap başına aç/kapat tercihi (satır yok = varsayılan).
CREATE TABLE notify_rules (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  groups_json TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('silent','normal','urgent')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notify_rules_user ON notify_rules(user_id, position);
CREATE TABLE notify_account_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('on','off')),
  PRIMARY KEY (user_id, account_id)
);
