-- Web Push abonelikleri: sunucuda yalnız uç nokta ve tarayıcı anahtarları tutulur. web_session_id kaydı yapan
-- oturum: cihaz oturumla birlikte ölür (çıkış, süre/boşta dolması, devre dışı, iptal). Silmeyi auth.ts yapar;
-- oturum satırı yoksa PushSink de göndermez, cihazı siler.
CREATE TABLE push_devices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  web_session_id TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
CREATE INDEX idx_push_devices_user ON push_devices(user_id);
