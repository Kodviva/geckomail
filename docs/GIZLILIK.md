# Gizlilik ve güvenlik sınırları

Bu belge neyin korunduğunu ve neyin korunmadığını anlatır. Sözler kodun yaptığından fazla değildir.

## Kim neyi görür

| Taraf | Görür | Görmez |
|---|---|---|
| Posta sunucunuz | Postanın kendisi, parolanız | Yerel kasa içeriği |
| GeckoMail sunucusu | Düz metin posta, kişiler, takvim; kasa açıkken kasa içeriği ve S/MIME düz metni | Kasa kilitliyken kasa hesaplarının içeriği |
| Röle | Platform, cihaz belirteci, motor açık anahtarı, sabit boylu şifreli kutu, bağlantı IP'si (yazılmaz) | İçerik, gönderen, konu |
| Apple, Google | Cihaz belirteci, şifreli kutu | İçerik |
| Web Push servisleri | Şifreli kutu | İçerik |
| Kodviva | `relay.kodviva.com` kullanılıyorsa röle satırı | Sunucunuzdaki hiçbir şey. Telemetri yoktur |

## Kasa

Seçilen hesapların içeriği ve parolası AES-256-GCM ile şifrelidir. Kilitliyken açılmaz, aranmaz, bildirimi gelmez. Kasa, disk ele geçirilse bile içeriği korur; posta sunucusundaki kopyayı koruyamaz. Kasa parolası kurulum geneldir: veritabanına ve parolaya birlikte sahip olan kişi tüm kasayı açar.

## Cihaz senkronu

Hesap listesi ve kurallar, parolayla şifrelenip kendi posta sunucunuzdaki IMAP klasörüne yazılır. Sunucu yalnız şifreli veri görür, ama tüm hesap parolaları bu blob'dadır: senkron parolası çok değerlidir.

## S/MIME sunucuda uçtan uca değildir

Özel anahtar sunucuda kasadadır. Sunucu imzalama ve şifre çözme sırasında düz metni görür. Sunucuyu işleten kişi bunu görebilir. Uçtan uca istiyorsanız masaüstü yerel modunu kullanın.

## Yönetici sınırları

- Rol ve grup yetkileri uygulama katmanıdır, kiracı yalıtımı değildir.
- Sunucu yöneticisi tüm veritabanına erişir.
- Bir üyenin parolasını sıfırlayan yönetici o üye olarak girebilir, üyenin S/MIME anahtarını kullanabilir. Üye uyarılır, engellenemez.

## Mobil

- Biyometrik kilit uygulama kapısıdır, anahtar ACL'i değildir: kilidi açık telefonu eline alan kişiye karşıdır, jailbreak'li cihazdan çıkarmaya karşı değildir.
- WebView'a sızan bir betik 15 dakikalık erişim belirtecini alabilir. O süre içinde posta okuyabilir ve gönderebilir, zamanlı gönderim bırakabilir. Hesap sunucusu, yönlendirme kuralı, webhook, Sieve, kişi sertifikası gibi kalıcı izler belirteçle yapılamaz. Kendi imzanızı ve bildirim tercihlerinizi değiştirebilir.
- Kayıp telefonu tarayıcıdan kapatın: `istemciler.md`.
- Sertifika iğneleme yoktur.

## Bilinen sınırlar

- CRL çekilemezse iptal denetimi yumuşak başarısız olur: rozet "bilinmiyor" der.
- Konu satırı S/MIME ile şifrelenmez.
- Cihaz senkronu kullanan ikinci masaüstünde taşıma sonrası otomasyon duraklatılmaz.
- Uzak resimler varsayılan kapalıdır. Açıldığında sunucu üzerinden proxylenir.
