# geckomail-relay

Röle, sunucudaki motordan gelen şifreli kutuyu APNs ve FCM'e iletir. İçerik görmez. Web Push röleden geçmez, motordan doğrudan gider.

## Röle ne görür

Platform, APNs ortamı, cihaz belirteci, motor açık anahtarı, sabit boylu şifreli kutu ve bağlantı anında IP. IP yazılmaz; oran sınırı önyüklemede üretilen rastgele tuzla özetlenip yalnız bellekte tutulur. Seviye, boyut ve gruplama röleden gizlenir: sabit öncelik, sabit TTL, `apns-collapse-id` yok, sabit doldurma. 90 gün trafik almayan cihaz silinir.

## Varsayılan

Motor `https://relay.kodviva.com` kullanır. `GECKO_RELAY_URL=off` röleyi kapatır: mobil bildirim gitmez, Web Push sürer.

## Kendi rölenizi işletmek

Yapabilirsiniz, örnek: `deploy/relay-compose.example.yml`. Motorda `GECKO_RELAY_URL` kendi adresiniz, rölede `RELAY_PUBLIC_HOST` aynı ana makine olur. Motorlar imzayı bu ada atar, uyuşmazsa istekler 401 alır. Önünde TLS sonlandıran ters vekil gerekir.

Ama mağaza uygulamasına bildirim yalnız Kodviva'nın APNs anahtarı ve FCM projesiyle gider: Apple ve Google anahtarı uygulama kimliğine bağlar. Kendi röleniz bu uygulamaya yalnız, uygulamayı kendi kimliğinizle derleyip dağıtırsanız ulaşır. `relay.kodviva.com` en iyi çaba ile işletilir, kesinti olabilir, kullanılabilirlik sözü verilmez.

## Sağlayıcı anahtarları

`RELAY_APNS_KEY_FILE`, `RELAY_APNS_KEY_ID`, `RELAY_APNS_TEAM_ID`, `RELAY_APNS_TOPIC`, `RELAY_FCM_SERVICE_ACCOUNT_FILE`. Dosyalar Docker secret olarak verilir, depoya ve günlüğe girmez. Bir sağlayıcının anahtarı yoksa süreç açılır, o platforma gönderim `retry` döner.

## Sağlık

`GET /healthz` 200. Günlük yalnız başlatma ve hata türünü yazar.
