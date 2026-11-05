-- Şablonlar (R28): localStorage'dan DB'ye — cihaz senkronuna girer, kullanıcılar arasında ortak.
-- deleted_at: mezar taşı (diğer cihazdaki eski kopya geri gelmesin); son yazan kazanır (updated_at).
CREATE TABLE templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  subject TEXT,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
