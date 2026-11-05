# İstemciler

- **Web:** Sunucu adresi. PWA olarak kurulabilir, çevrimdışı okuma Ayarlar › Genel'den açılır.
- **Masaüstü:** macOS ve Windows. İki mod: yerel (sunucu yok) ve sunucu (pencere sunucuyu açar, arka planda bildirim alır). Yerelden sunucuya taşıma Ayarlar › Genel'dedir.
- **Mobil:** iOS ve Android. Yalnız sunucu moduyla çalışır, ilk açılışta adres girilir. Sunucu `https` ve geçerli sertifika ister.

## Mobilde tarayıcıya bırakılanlar

Mobil belirteç 15 dakikalıktır ve WebView'a düşer. Bu yüzden belirtecin ömrünü aşan her iş tarayıcıdadır:

- Hesap ekleme, sunucu adresi, parola, kasa koruması, hesap açma kapama ve silme
- Sieve yazımı ve tatil yanıtı, otomasyon kuralları, webhook'lar
- Kişi ve takvim kaynağı ekleme, kaldırma; OAuth
- Parola, 2FA, passkey, S/MIME kimliği, kişi sertifikası kaydetme ve silme
- Oturum listesi, cihaz senkronu, tüm yönetim işleri

Okuma, gönderme, taslak, taşıma, bayrak, kişi ve etkinlik düzenleme ile kendi bildirim tercihleriniz mobilde çalışır. Çalıştırılan yöntem listesi `src/sync/rpcHub.ts` içindeki izin listesidir.

## Kayıp telefon

Tarayıcıdan Ayarlar › Güvenlik & Kasa › Oturumlarım'dan telefonun oturumunu kapatın. Soketi hemen kapanır, bildirim kaydı silinir. Kaydı duran telefon için Ayarlar › Bildirimler › Kayıtlı cihazlar'dan kaldırmak da oturumu kapatır.
