-- v2.0: otomasyon kuralları, giden webhook'lar, zamanlanmış görevler

CREATE TABLE rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  conditions_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_triggered_at INTEGER,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  CHECK (account_id IS NULL OR group_id IS NULL)
);
CREATE INDEX idx_rules_lookup ON rules (enabled, account_id, group_id);

CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_delivered_at INTEGER,
  last_error TEXT
);

CREATE TABLE scheduled_triggers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_payload_json TEXT NOT NULL DEFAULT '{}',
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_triggers_due ON scheduled_triggers (enabled, next_run_at);

-- Kasıtlı olarak FK yok: kural/webhook/görev silinse bile "dün gece niye tetiklendi" cevaplanabilsin.
CREATE TABLE rule_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref_id INTEGER,
  account_id INTEGER,
  message_id INTEGER,
  summary TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
CREATE INDEX idx_rulelog_ts ON rule_log (ts DESC);
