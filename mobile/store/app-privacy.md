# App Store App Privacy yanıtları

| Soru | Yanıt |
|---|---|
| Veri toplanıyor mu | Evet |
| Veri türü | Identifiers > Device ID (APNs belirteci) |
| Kullanım | App Functionality |
| Kimliğe bağlı mı | Hayır |
| İzleme | Hayır |

Manifest: `NSPrivacyTracking=false`, `NSPrivacyCollectedDataTypeDeviceID` işlev amaçlı, kimliğe bağlı değil, izleme yok. Gerekçeli API: `UserDefaults` `CA92.1`, dosya zamanı `C617.1`.

Geliştirici yalnız push belirteci ve zamanı işler: amaç bildirim, paylaşım yok, aktarımda şifreli, 90 gün trafiksizde silinir. Posta ve kimlik bilgileri kullanıcının kendi sunucusundadır.

Röle ayrıca platform, APNs ortamı, motor açık anahtarı, sabit boylu şifreli kutu ve bağlantı anında IP görür. IP yazılmaz; oran sınırı önyüklemede üretilen rastgele tuzla özetlenip yalnız bellekte tutulur. Seviye, boyut ve gruplama röleden gizlenir: sabit öncelik, sabit TTL, `apns-collapse-id` yok, sabit doldurma.

Şifreleme uyumu: yalnız standart TLS, bildirim yükü için RFC 8291 ve çevrimdışı önbellek için AES-256-GCM (`ITSAppUsesNonExemptEncryption` değeri sahibi hukukçusuyla kesinleştirir).
