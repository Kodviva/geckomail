# Google Play Data Safety yanıtları

Geliştirici Kodviva'nın işlediği veri için doldurulur. Posta ve kimlik bilgileri kullanıcının kendi sunucusundadır, geliştiriciye gitmez.

| Soru | Yanıt |
|---|---|
| Veri toplanıyor mu | Evet: yalnız bildirim açıksa |
| Veri paylaşılıyor mu | Hayır |
| Aktarımda şifreli mi | Evet |
| Silme isteği | Uygulamada bildirimi kapatmak ya da çıkış yapmak kaydı siler |
| Toplanan tür | Cihaz veya diğer kimlikler: push belirteci; Uygulama etkinliği yok |
| Amaç | Uygulama işlevi (bildirim) |
| Saklama | 90 gün trafik yoksa silinir |
| İşleme | Geçici değil, zorunlu değil (bildirim isteğe bağlı) |

Röle ayrıca platform, APNs ortamı, motor açık anahtarı, sabit boylu şifreli kutu ve bağlantı anında IP görür. IP yazılmaz; oran sınırı önyüklemede üretilen rastgele tuzla özetlenip yalnız bellekte tutulur. Seviye, boyut ve gruplama röleden gizlenir: sabit öncelik, sabit TTL, `apns-collapse-id` yok, sabit doldurma.

Reklam kimliği yok. Konum, kişi, fotoğraf, dosya geliştiriciye gitmez: paylaş menüsünden seçilen dosya kullanıcının kendi sunucusuna yüklenir.
