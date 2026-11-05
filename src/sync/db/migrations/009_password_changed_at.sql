-- Cihazlar arası senkron: eski şifre yeniyi ezmesin (29 Eyl). Şifre plain'i değiştiğinde damgalanır;
-- senkron pull uzak şifreyi yalnız daha yeniyse uygular. Mevcut satırlar 0 = "bilinmiyor" (ezilmez).
ALTER TABLE accounts ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0;
