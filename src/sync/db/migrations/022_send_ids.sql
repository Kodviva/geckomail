-- sendMail tekrar koruması: istemcinin ileti başına ürettiği kimlik. Yanıtı kaybolan çağrı yeniden denenince ikinci
-- kez kuyruğa girmez. content_hash: aynı içerik mi (düzenlenmiş yeniden deneme yeni gönderimdir); op_id: ilk çağrının
-- işlemi (başarısızsa yeniden deneme yeni gönderimdir). İptal edilen işlemin satırı silinir; satırlar 24 saat sonra budanır.
CREATE TABLE send_ids (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at INTEGER,
  content_hash TEXT,
  op_id INTEGER
);
