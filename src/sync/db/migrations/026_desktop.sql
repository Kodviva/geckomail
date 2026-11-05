-- Masaüstü ajanı push_devices satırıyla kayıtlıdır: oturum uzaması, çıkış/iptal temizliği, süpürme ve cihaz listesi
-- hazır gelir. 'desktop' satırına push gönderilmez, ajan bildirimi WebSocket'ten alır; 'apns','fcm' röle cihazlarıdır.
ALTER TABLE push_devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'webpush';

-- Yerelden sunucuya taşıma: kaynak kurulum başına hangi öge aktarıldı ya da engellendi (kaldığı yerden sürdürme).
-- Düz parola girmez; detail yalnız neden kodu.
CREATE TABLE import_ledger (
  source_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done','blocked')),
  detail TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, item_key)
);
