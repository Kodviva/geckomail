-- Hesap-bazlı kasa modu: at-rest şifreleme bayrakları.
-- secure=1  → hesabın IMAP şifresi + içerik kolonları vaultKey (AES-GCM) ile şifreli, FTS'e girmez.
-- enc=1     → o satırın içerik kolonları / gövdesi ciphertext (base64) tutuluyor.
ALTER TABLE accounts ADD COLUMN secure INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN enc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bodies ADD COLUMN enc INTEGER NOT NULL DEFAULT 0;
