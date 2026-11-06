-- Kural ve bildirim kuyruğu satırdaki rules_eligible işaretine taşındı. messages.id AUTOINCREMENT değil: silinen en yüksek
-- kimliği yeni ileti alır ve "son işlenen id" onu işlenmiş sayıyordu. Tabloyu AUTOINCREMENT ile yeniden yazmak FTS, tetikleyici
-- ve FK'leri riske atar, büyük veritabanında uzun sürerdi; işaret tek UPDATE'tir.
CREATE INDEX IF NOT EXISTS idx_msgs_rules_pending ON messages (account_id, id) WHERE rules_eligible = 1;
-- Eski işaretin gerisindeki satırlar işlenmiştir, kuralları yeniden çalışmaz
UPDATE messages SET rules_eligible = 0
WHERE rules_eligible = 1
  AND id <= COALESCE((SELECT CAST(value AS INTEGER) FROM prefs WHERE key = 'rules_watermark:' || messages.account_id), 0);
DELETE FROM prefs WHERE key LIKE 'rules!_watermark:%' ESCAPE '!';
