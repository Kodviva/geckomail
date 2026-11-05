# Bildirim ve röle

- **Web Push** motordan tarayıcı servisine doğrudan gider, şifrelidir, röle görmez.
- **Masaüstü** sunucu modunda WebSocket üzerinden bildirim alır.
- **Mobil** APNs ve FCM ile gider. Motor kutuyu cihaz anahtarıyla şifreler, röle iletir, içeriği görmez.

Kurallar kişi başınadır: Ayarlar › Bildirimler. Sessiz saatler, VIP listesi, hesap başına açma kapama. Kurallar yalnız bildirimi süzer, postayı yönlendirmez.

Röle ayrıntısı, ne gördüğü ve kendi rölenizi işletme: [`deploy/RELAY.md`](../deploy/RELAY.md). `relay.kodviva.com` en iyi çaba ile işletilir, kullanılabilirlik sözü verilmez.
