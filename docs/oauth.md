# OAuth istemci kaydı

Her kurulum kendi istemcisini kaydeder. Sunucu modunda yönlendirme adresi: `https://<alan>/oauth/callback`. Ayarlar › Hesaplar › OAuth istemcileri aynı adresi gösterir ve istemci kimliğini burada girersiniz.

## Google

1. [Google Cloud Console](https://console.cloud.google.com/)'da proje açın.
2. Gmail API'yi etkinleştirin. Kişi ve takvim için CalDAV API ve People API'yi de.
3. OAuth izin ekranını kurun, kapsam olarak `https://mail.google.com/` ekleyin. Kişi ve takvim için `calendar` ve `carddav` kapsamları.
4. Kimlik bilgileri › OAuth istemci kimliği › Web uygulaması. Yetkili yönlendirme adresi olarak yukarıdaki adresi girin.
5. İstemci kimliği ve gizli anahtarı GeckoMail'e girin.

Masaüstünde yerel modda istemci türü "Masaüstü uygulaması" seçilir, geri dönüş `127.0.0.1` üzerindendir.

## Microsoft

1. [Entra yönetim merkezi](https://entra.microsoft.com/) › Uygulama kayıtları › Yeni kayıt.
2. Platform: Web. Yeniden yönlendirme adresi olarak yukarıdaki adresi girin.
3. API izinleri (temsilci): `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`. Kişi ve takvim için `Contacts.ReadWrite`, `Calendars.ReadWrite`.
4. Sertifikalar ve gizli anahtarlar › yeni istemci gizli anahtarı.
5. Uygulama kimliği ve gizli anahtarı GeckoMail'e girin.

Kişi ve takvim izinleri yalnız "Kişi ve takvimi bağla" sırasında istenir. Kiracı yöneticisi kapattıysa posta çalışmaya devam eder.
