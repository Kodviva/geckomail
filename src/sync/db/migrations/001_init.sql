CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  imap_tls TEXT NOT NULL DEFAULT 'tls',
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  smtp_tls TEXT NOT NULL DEFAULT 'tls',
  password_enc BLOB NOT NULL,
  color TEXT NOT NULL DEFAULT '#8888aa',
  starred INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  allow_invalid_certs INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_detail TEXT,
  status_since INTEGER,
  last_success_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  uidvalidity INTEGER,
  last_seen_uidnext INTEGER,
  highest_modseq INTEGER,
  backfill_low_uid INTEGER,
  last_deep_flag_sync_at INTEGER,
  last_seen_exists INTEGER,
  UNIQUE (account_id, path)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL,
  folder_kind TEXT NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  subject TEXT,
  from_name TEXT,
  from_addr TEXT,
  to_json TEXT,
  date INTEGER NOT NULL,
  size INTEGER,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  UNIQUE (folder_id, uid)
);

CREATE INDEX idx_msgs_unified ON messages (folder_kind, date DESC, id);
CREATE INDEX idx_msgs_account ON messages (account_id, folder_kind, date DESC, id);
CREATE INDEX idx_msgs_unread ON messages (account_id) WHERE seen = 0 AND folder_kind = 'inbox';

CREATE TABLE bodies (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  text_plain TEXT,
  html TEXT,
  fetched_at INTEGER,
  last_access_at INTEGER,
  raw_size INTEGER
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id TEXT,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  content_id TEXT,
  disk_path TEXT,
  fetched_at INTEGER,
  last_access_at INTEGER
);
CREATE INDEX idx_att_msg ON attachments (message_id);

CREATE TABLE op_queue (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ops_pending ON op_queue (state, not_before);

CREATE TABLE prefs (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, from_text, to_text, body_text,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);
