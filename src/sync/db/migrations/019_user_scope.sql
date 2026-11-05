-- Kişiye ait veri (§10.1): bildirim tercihleri, hesap başına imza ve özel şablonlar kullanıcıya bağlanır.
-- Sunucu modunda her kullanıcı kendi sessiz saatini/VIP listesini taşır; genel prefs yalnız cihaz ayarı kalır.
CREATE TABLE user_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- accounts.signature hesabın varsayılanı olarak kalır; burada kişinin üzerine yazdığı imza
CREATE TABLE user_signatures (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  PRIMARY KEY (user_id, account_id)
);

-- göç: mevcut genel bildirim tercihleri her kullanıcıya kopyalanır (davranış değişmez)
INSERT INTO user_prefs (user_id, key, value)
  SELECT u.id, p.key, p.value FROM users u CROSS JOIN prefs p
  WHERE p.key IN ('notifyScope', 'notifyQuiet', 'notifyQuietStart', 'notifyQuietEnd', 'notifyVip') AND p.value IS NOT NULL;

-- şablonlar yeniden kurulur: owner_user_id NULL = paylaşılan (cihaz senkronuna yalnız bunlar girer).
-- Ad sahibi başına tekil; NULL'lar UNIQUE'te birbirine eşit sayılmadığından paylaşılanlar için kısmi indeks.
CREATE TABLE templates_new (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (owner_user_id, name)
);
INSERT INTO templates_new (id, owner_user_id, name, subject, body, updated_at, deleted_at)
  SELECT id, NULL, name, subject, body, updated_at, deleted_at FROM templates;
DROP TABLE templates;
ALTER TABLE templates_new RENAME TO templates;
CREATE UNIQUE INDEX idx_templates_shared_name ON templates (name) WHERE owner_user_id IS NULL;
