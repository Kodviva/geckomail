-- S/MIME: anahtarlar kasa anahtarıyla şifrelidir (key_enc); kimlik hesaba değil kullanıcı + adrese bağlıdır,
-- hesabı silmek özel anahtarı yok etmemeli. message_smime.info kasa hesabında mühürlüdür, smime_kind düz kalır.
ALTER TABLE messages ADD COLUMN smime_kind TEXT;
CREATE TABLE message_smime (message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, info TEXT NOT NULL);
CREATE TABLE smime_identities (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL,
  fingerprint TEXT NOT NULL, cert_der BLOB NOT NULL, chain_der TEXT NOT NULL, key_enc TEXT NOT NULL,
  not_before INTEGER NOT NULL, not_after INTEGER NOT NULL, can_sign INTEGER NOT NULL, can_encrypt INTEGER NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE (user_id, fingerprint));
CREATE INDEX idx_smime_identity_user_email ON smime_identities(user_id, email);
CREATE TABLE smime_contact_certs (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL,
  fingerprint TEXT NOT NULL, cert_der BLOB NOT NULL, chain_der TEXT NOT NULL, not_after INTEGER NOT NULL,
  capabilities TEXT, source TEXT NOT NULL CHECK (source IN ('auto','manual')),
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, UNIQUE (user_id, email, fingerprint));
CREATE INDEX idx_smime_contact_user_email ON smime_contact_certs(user_id, email);
CREATE TABLE smime_trust_anchors (fingerprint TEXT PRIMARY KEY, cert_der BLOB NOT NULL, label TEXT NOT NULL, added_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL);
CREATE TABLE smime_crls (url TEXT PRIMARY KEY, der BLOB, this_update INTEGER, next_update INTEGER, fetched_at INTEGER, last_error_at INTEGER);
