# S/MIME

`.p12` içe aktarma, imzalama, şifreleme ve doğrulama. Kripto yalnız motorda çalışır.

- Kimlikler Ayarlar › Güvenlik & Kasa'da eklenir, kasa gerekir. Özel anahtar kasa açıkken bellektedir.
- Yeşil rozet yalnız doğrulanmış imza ve sağlam şifre içindir. Kendinden imzalı sertifika "doğrulandı" sayılmaz.
- Doğrulanmış imzadaki sertifika, iletiyi açan kişinin kişilerine eklenir. Güvenilmeyen sertifika ancak adresi iletinin gönderenine uyuyorsa, parmak izi gösterilip onaylanarak elle kaydedilir. Adres uymuyorsa kaydedilemez.
- Güven listesi Mozilla e-posta kökleridir. Yönetici kurum kökü ekleyebilir.
- İptal denetimi CRL iledir, OCSP yoktur: her sorgu CA'ya kimin postasının okunduğunu söylerdi. Liste çekilemezse doğrulama sürer, rozette "iptal bilinmiyor" görünür.
- Şifreli gönderimde alıcının iptal listesi saklı ama henüz işlenmemişse gönderim bekler: arayüzde "iptal listesi hazırlanıyor" yazar, kuyruktaki ileti hazır olunca kendiliğinden gider.

## Sınırlar

Sunucu kurulumunda bu uçtan uca şifreleme değildir, ayrıntı: [`GIZLILIK.md`](GIZLILIK.md). Konu şifrelenmez. Şifreli postalar aramada çıkmaz, çevrimdışı açılmaz, diske düz yazılmaz. Şifreli davetler yanıtlanamaz.
