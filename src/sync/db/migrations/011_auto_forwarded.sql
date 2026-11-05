-- Forward döngü koruması (R37): X-GeckoMail-Forwarded başlığıyla gelen (bizim otomatik ilettiğimiz)
-- mailde kural motoru forward çalıştırmaz — A→B, B→A kuralları sonsuz döngü kurmasın.
ALTER TABLE messages ADD COLUMN auto_forwarded INTEGER NOT NULL DEFAULT 0;
