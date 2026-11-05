-- Ertele (snooze): maili belirli bir zamana kadar gelen kutusundan gizle.
-- snooze_until > 0  → ertelenmiş (liste görünümlerinde gizli).
-- Zamanı gelince periyodik resurface snooze_until'i 0'lar + maili okunmamış yapar (dikkat çeksin).
ALTER TABLE messages ADD COLUMN snooze_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_msg_snooze ON messages (snooze_until) WHERE snooze_until > 0;
