-- Sent/Trash/Junk çiftleri (Stalwart'a taşınan hesaplarda "Sent" + "Sent Items" …) arasında sunucunun
-- SPECIAL-USE ile işaretlediği klasör seçilsin (29 Eyl). Mevcut klasörler bilgiyi bir sonraki LIST'te
-- alsın diye listeleme önbelleği sıfırlanır.
ALTER TABLE folders ADD COLUMN special_use INTEGER NOT NULL DEFAULT 0;
DELETE FROM prefs WHERE key LIKE 'folders_listed_%';
