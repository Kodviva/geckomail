-- Kurallar yalnız gerçekten yeni gelen mailde çalışsın (29 Eyl): backfill, yeni hesap ilk senkronu
-- ve UIDVALIDITY sıfırlaması eski mailleri yeni satır id'siyle ekliyordu → id watermark'ını aşıp
-- forward/webhook kurallarını geçmişe uyguluyordu. Mevcut satırlar 0 (zaten işlendi ya da eski).
ALTER TABLE messages ADD COLUMN rules_eligible INTEGER NOT NULL DEFAULT 0;
