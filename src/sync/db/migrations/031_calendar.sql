-- Takvim nesneleri: ham iCalendar + aralık dizini. range_end NULL = sonu olmayan tekrar.
-- remote_id: DAV href, Graph olay kimliği, abonelikte UID.
CREATE TABLE calendar_objects (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES pim_collections(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  etag TEXT,
  uid TEXT NOT NULL,
  raw TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER,
  recurring INTEGER NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  organizer TEXT,
  next_alarm_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (collection_id, remote_id)
);
CREATE INDEX idx_calobj_range ON calendar_objects(collection_id, range_start);
CREATE INDEX idx_calobj_uid ON calendar_objects(uid);
CREATE INDEX idx_calobj_alarm ON calendar_objects(next_alarm_at) WHERE next_alarm_at IS NOT NULL;

CREATE TABLE invite_responses (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  recurrence_id TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL,
  partstat TEXT NOT NULL CHECK (partstat IN ('ACCEPTED','DECLINED','TENTATIVE')),
  responded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  responded_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, uid, recurrence_id)
);
