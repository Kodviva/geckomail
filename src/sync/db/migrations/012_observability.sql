-- Gözlemlenebilirlik (30 Eyl): sunucu auto-ban eşiği "günde 100 başarısız login" — uygulama kendi
-- sayacını görsün; hesap durum geçmişi "ne zamandan beri, kaç kez" sorusunu yanıtlasın.
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  host TEXT NOT NULL,
  account_id INTEGER,
  lane TEXT NOT NULL,      -- 'imap' | 'smtp'
  result TEXT NOT NULL     -- 'ok' | 'auth' | 'limit' | 'preauth' | 'net' | 'other'
);
CREATE INDEX login_attempts_ts ON login_attempts(ts);

CREATE TABLE account_status_log (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX account_status_log_acc ON account_status_log(account_id, ts);
