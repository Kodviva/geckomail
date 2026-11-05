-- Kişi kartları: ham vCard + arama ve otomatik tamamlama için çıkarılmış alanlar
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES pim_collections(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  etag TEXT,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual','group')),
  raw TEXT NOT NULL,
  full_name TEXT NOT NULL,
  org TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (collection_id, remote_id)
);
CREATE INDEX idx_contacts_name ON contacts(collection_id, full_name COLLATE NOCASE);

CREATE TABLE contact_emails (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  addr TEXT NOT NULL COLLATE NOCASE,
  label TEXT,
  pos INTEGER NOT NULL,
  PRIMARY KEY (contact_id, addr)
);
CREATE INDEX idx_contact_emails_addr ON contact_emails(addr);

CREATE TABLE contact_group_members (
  group_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  member_uid TEXT NOT NULL,
  PRIMARY KEY (group_id, member_uid)
);
