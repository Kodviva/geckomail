-- v2.0: yerel çoklu kullanıcı + grup bazlı yetkilendirme

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#8888aa',
  created_at INTEGER NOT NULL
);

-- Hesap -> tek grup: 67 hesap/~28 domain "bir domain=bir grup" modelini işaret ediyor.
-- İhtiyaç doğarsa many-to-many junction'a geçiş tek migration'lık iş.
ALTER TABLE accounts ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;
CREATE INDEX idx_accounts_group ON accounts (group_id);

CREATE TABLE user_group_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  can_view INTEGER NOT NULL DEFAULT 1,
  can_manage INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, group_id)
);

-- geriye dönük göç: mevcut hesaplar kırılmasın
INSERT INTO groups (name, color, created_at) VALUES ('Genel', '#8888aa', strftime('%s','now') * 1000);
UPDATE accounts SET group_id = (SELECT id FROM groups WHERE name = 'Genel') WHERE group_id IS NULL;
