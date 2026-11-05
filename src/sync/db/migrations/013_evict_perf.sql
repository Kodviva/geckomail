-- Tahliye (R19): saatlik bütçe hesabı tüm gövde metnini okuyordu (≈1 GB, senkron → sync olay döngüsü
-- dururdu). Uzunluk kayıt anında saklanır; erişim sırası indeksli; ekler disk yoluna göre gruplanır.
ALTER TABLE bodies ADD COLUMN text_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE bodies SET text_bytes = LENGTH(COALESCE(text_plain, '')) + LENGTH(COALESCE(html, ''));
CREATE INDEX IF NOT EXISTS bodies_last_access ON bodies(last_access_at);
CREATE INDEX IF NOT EXISTS attachments_disk_path ON attachments(disk_path) WHERE disk_path IS NOT NULL;
