-- Toplu abonelik iptali (R29): hangi göndericiden ne zaman çıkıldığı. İptal sonrası mail gelmeye devam
-- ederse ekranda işaretlenir (kurala çevirme önerisi).
CREATE TABLE unsubscribes (
  addr TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_msgs_list_unsub ON messages (from_addr) WHERE list_unsubscribe IS NOT NULL;
