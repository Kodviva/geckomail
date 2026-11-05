// Ayrıştırma sınırları tek yerde: IMAP'ten inen ileti en çok STREAM_HARD_LIMIT olabilir, BER sınırı buna bağlıdır.
// asn1js varsayılanları (10 000 düğüm, 16 MiB) meşru büyük iletiyi ve CRL'i kırar.
export const STREAM_HARD_LIMIT = 30_000_000

/** En küçük gerçekçi parça 256 bayt: bölünmüş OCTET STRING içeren ileti buna sığar. Derinlik varsayılanda (100) kalır. */
export const CMS_BER_LIMITS = { maxNodes: Math.ceil(STREAM_HARD_LIMIT / 256), maxContentLength: STREAM_HARD_LIMIT }
