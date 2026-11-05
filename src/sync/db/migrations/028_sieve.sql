-- Sunucu tarafı filtreler. run_on_server: hesapta Sieve açıksa kural sunucuya aday; 0 ise hep istemcide.
-- Betik içeriği yerelde tutulmaz, yalnız özeti (script_hash).
ALTER TABLE rules ADD COLUMN run_on_server INTEGER NOT NULL DEFAULT 1;

CREATE TABLE sieve_accounts (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  host TEXT,                                -- boş: imap_host
  port INTEGER,                             -- boş: 4190
  tls TEXT,                                 -- 'starttls' | 'tls'; algılanır
  caps_json TEXT,
  caps_at INTEGER,
  state TEXT NOT NULL DEFAULT 'unknown',
  state_detail TEXT,
  detail_enc INTEGER NOT NULL DEFAULT 0,    -- 1: state_detail kasa anahtarıyla şifreli
  script_hash TEXT,
  deployed_at INTEGER,
  consent_script TEXT,                      -- onaylanan kullanıcı betiği adı: ad değişirse onay geçersiz
  consent_at INTEGER,
  wrapper_of TEXT,                          -- sarmalanan kullanıcı betiği; NULL: sarmalayıcı yok
  watched_json TEXT NOT NULL DEFAULT '[]',  -- izlenen klasör yolları
  updated_at INTEGER NOT NULL
);

CREATE TABLE sieve_vacation (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  days INTEGER NOT NULL DEFAULT 1,
  start_date TEXT,                          -- YYYY-MM-DD
  end_date TEXT,                            -- YYYY-MM-DD
  enc INTEGER NOT NULL DEFAULT 0,           -- 1: konu ve gövde kasa anahtarıyla şifreli
  updated_at INTEGER NOT NULL
);
