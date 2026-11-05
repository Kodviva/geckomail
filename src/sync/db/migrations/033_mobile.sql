-- Mobil uygulama: oturum türü. Mobil oturumun belirteci yalnız Keychain/Keystore'da durur, çerez olarak kabul edilmez.
-- Eski satırlar web oturumu olarak kalır. Cihaz taşıması push_devices.kind sütunundadır ('webpush','desktop','apns','fcm').
ALTER TABLE web_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web','mobile'));
