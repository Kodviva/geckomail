-- Takip hatırlatıcısı gönderene aittir (§10.1): bildirim yalnız sahibine gider. Eski kayıtlarda sahip bilinmez
-- (NULL): hesabı gören herkese bildirilir, bugünkü gibi. Kullanıcı silinirse kayıt sahipsiz kalır.
ALTER TABLE followups ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
