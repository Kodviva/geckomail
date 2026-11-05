-- Kişiler ve takvim: kaynaklar (hesaba bağlı ya da kişiye ait) ve koleksiyonlar
CREATE TABLE pim_sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('dav','graph','ics','local')),
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  caldav_url TEXT,
  carddav_url TEXT,
  ics_url_enc BLOB,
  ics_etag TEXT,
  ics_last_modified TEXT,
  username TEXT,
  secret_enc BLOB,
  auth TEXT NOT NULL CHECK (auth IN ('none','basic','account')),
  server_schedules INTEGER NOT NULL DEFAULT 0,
  granted_scopes TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_reauth','error')),
  last_error TEXT,
  last_sync_at INTEGER,
  next_sync_at INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  CHECK ((account_id IS NULL) <> (owner_user_id IS NULL))
);
CREATE UNIQUE INDEX idx_pim_sources_account ON pim_sources(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_pim_sources_owner ON pim_sources(owner_user_id);

CREATE TABLE pim_collections (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES pim_sources(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('addressbook','calendar')),
  remote_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  read_only INTEGER NOT NULL DEFAULT 0,
  ctag TEXT,
  sync_token TEXT,
  delta_link TEXT,
  window_start INTEGER,
  window_end INTEGER,
  UNIQUE (source_id, type, remote_id)
);

-- Gizleme, renk ve hatırlatma tercihi kişiye aittir
CREATE TABLE pim_collection_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES pim_collections(id) ON DELETE CASCADE,
  hidden INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  reminders INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, collection_id)
);

-- Yenileme belirteci Graph kaynağı taşımış hesap: posta yenilemesi hep posta kapsamını açıkça ister
ALTER TABLE accounts ADD COLUMN mail_scope_explicit INTEGER NOT NULL DEFAULT 0;
