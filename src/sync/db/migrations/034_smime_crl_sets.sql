-- CRL başına iptal edilmiş seri kümesi: gönderim denetimi zaman uyumludur, listeyi ayrıştırmaz, bu tabloyu okur.
-- Küme nesil nesil yazılır, okuyucu yalnız set_generation'ı görür. set_key listenin özetini ve yayımcıyı kapsar: uymayan küme kullanılmaz.
-- Satırlar önbellektir ve özetsiz kalamaz: boşaltılır, gerektiğinde yeniden çekilir.
DELETE FROM smime_crls;
ALTER TABLE smime_crls ADD COLUMN der_sha256 TEXT;
ALTER TABLE smime_crls ADD COLUMN set_generation INTEGER;
ALTER TABLE smime_crls ADD COLUMN set_key TEXT;
ALTER TABLE smime_crls ADD COLUMN set_scope TEXT;
CREATE TABLE smime_crl_serials (
  url TEXT NOT NULL,
  generation INTEGER NOT NULL,
  serial BLOB NOT NULL,
  PRIMARY KEY (url, generation, serial)
) WITHOUT ROWID;
