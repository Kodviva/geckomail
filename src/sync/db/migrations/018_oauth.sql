-- OAuth2 hesapları (Gmail / Microsoft 365): password_enc bu hesaplarda şifre yerine yenileme
-- belirtecini (refresh token) taşır — aynı Anahtar Zinciri şifrelemesi. 'password' | 'oauth:google' | 'oauth:microsoft'
ALTER TABLE accounts ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password';
