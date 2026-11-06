# GeckoMail mobil uygulaması gizlilik politikası

Yürürlük: 5 Kasım 2026. Yayıncı: Kodviva Yazılım Sanayi ve Ticaret Limited Şirketi. İletişim: iletisim@kodviva.com. Yayın adresi: https://kodviva.com/geckomail/gizlilik

## Kısaca

GeckoMail, sizin ya da kuruluşunuzun işlettiği GeckoMail sunucusuna bağlanır. Posta, kişiler, hesap parolaları ve kurallar o sunucudadır. Kodviva bunlara erişemez ve bunları toplamaz. Kodviva'nın işlediği tek veri, bildirimleri cihazınıza ulaştırmak için gereken bildirim aktarım verisidir.

## Sunucunuzdaki veriler

Oturum, posta ve hesap bilgileri uygulama ile sizin sunucunuz arasında TLS ile taşınır. Bu verilerden sunucu yöneticiniz sorumludur. Uygulama cihazda yalnız şunları tutar:

- Oturum belirteci (iOS Keychain, Android Keystore ile şifreli).
- Bildirim anahtarları ve bildirim açıksa push belirteci (iOS UserDefaults, Android uygulama tercihleri). Bildirimi kapatınca ya da çıkış yapınca silinir.
- Seçili sunucu adresi ve kilit ayarı.
- Yazılan iletinin taslağı (uygulama içi localStorage, düz metin). Ekler ve kasa hesabından ya da şifreli iletiden gelen metin yazılmaz. İleti gönderilince ya da taslak atılınca silinir.
- Paylaş menüsünden seçilen dosyalar: uygulama açılana dek paylaşım kutusunda durur, 24 saatte silinir.
- Geçici ek önbelleği (24 saatte silinir, çıkışta tamamen silinir).
- Çevrimdışı önbellek, açılırsa ve cihaz destekliyorsa: iletiler AES-256-GCM ile şifreli tutulur.

## Bildirim aktarıcısı (geckomail-relay)

Bildirimi açarsanız sunucunuz `relay.kodviva.com` adresindeki aktarıcı üzerinden Apple APNs ya da Google FCM'e şifreli bir kutu gönderir.

Aktarıcı şunları görür: cihaz belirteci, platform (iOS, Android), APNs ortamı, sunucunuzun açık anahtarı, sabit boylu şifreli kutu, zaman ve bağlantı anında IP adresi.

Aktarıcı şunları görmez: gönderici, konu, ileti içeriği, hesap adresi, bildirimin seviyesi, grubu. Kutu yalnız cihazınızdaki anahtarla açılır. Sabit öncelik, sabit ömür ve sabit doldurma kullanılır, boyuttan içerik anlaşılmaz.

IP adresi yazılmaz. Oran sınırı için önyüklemede üretilen rastgele tuzla özetlenir ve yalnız bellekte tutulur. Cihaz belirteci, bildirimi ulaştırma amacıyla saklanır; 90 gün trafik olmayan kayıt silinir. Çıkış yapınca ya da bildirimi kapatınca kayıt silinir. Veriler üçüncü taraflarla paylaşılmaz, yalnız bildirimi taşıyan Apple ve Google'a şifreli kutu iletilir.

## Bildirimi kapatmak

Ayarlar'dan bildirimi kapattığınızda cihaz kaydı sunucunuzdan ve aktarıcıdan silinir, anahtarlar cihazdan silinir. Kasa kilitliyken kasa hesaplarından bildirim gelmez.

## İzleme ve reklam

Uygulama reklam, analitik ya da izleme kitaplığı içermez. Sizi başka uygulamalar arasında izlemez.

## Çocuklar

Uygulama 18 yaş altına yönelik değildir.

## Değişiklikler

Bu metin değişirse uygulama sürüm notunda duyurulur.
