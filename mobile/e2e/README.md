# Mobil uçtan uca deneme

Gerçek hesap, gerçek posta ya da dış ağ kullanılmaz. Her şey geçici dizindedir, yığın kapanınca silinir.

## Yığın

```sh
npm run build:server
npx vite build --config vite.e2e.config.ts
node mobile/scripts/e2e-stack.mjs
```

- Sunucu `http://localhost:9100` (derlenmiş sunucu, TOTP açık kullanıcı `deneme`, parola `deneme-parola-1`).
- Röle: gerçek imza ve kayıt, sağlayıcı yerine yakalayan sahte gönderici (`e2e/relayServer.ts`). Yerel TLS `localhost:9101`.
- Denetim `http://localhost:9102`: `GET /totp`, `GET /seed`, `GET /sessions`, `GET /devices`, `GET /captured`, `GET /logs`, `POST /revoke` (mobil oturumlar silinir), `POST /idle` (oturum 8 gün boşta), `POST /push`.

`--chain` zinciri çalıştırır, `mobile/testdata/engine-chain.json` dosyasını yazar ve çıkar. Motor çıktısının yerel çözücüyle aynı baytlarla sınandığı `testEngineChainPayload` ve `engineChainPayload` bu dosyayı okur. Betik, sunucu ve röle günlüğünde belirteç ve içerik görürse hata verir.

## Paket

Debug paketi yerel sunucuya izin verir, üretim paketi vermez:

```sh
cd mobile && npm run build:debug && npx cap sync
```

## iOS

```sh
xcodebuild test -project mobile/ios/App/App.xcodeproj -scheme AppUITests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' -test-timeouts-enabled YES
```

Yığın kapalıysa test atlanır. `xcodebuild test -scheme App` birim testleridir; oturum açık simülatörde `testNoTokenInWebStorage` web deposunda belirteç olmadığını da doğrular.

## Android

```sh
adb reverse tcp:9100 tcp:9100 && adb reverse tcp:9102 tcp:9102
cd mobile/android && ./gradlew :app:connectedDebugAndroidTest
```

`:app:` önemlidir: Capacitor'ın üretilmiş Cordova modülü kendi androidTest yolunda çift sınıf hatası verir. Android'de sayfa `http://10.0.2.2` adresini karışık içerik diye engeller, `adb reverse` gerekir.

## Elle denenecekler

Bu adımlar sistem arayüzüne dokunur, test kodunda yoktur:

1. Posta içi bağlantı: `Betikli ileti` içindeki `Dış bağlantı` sistem tarayıcısında açılır. Görsel yüklenmez, `BETIK CALISTI` görünmez.
2. PDF: `PDF ekli rapor` eki QuickLook'ta (iOS) ya da PDF görüntüleyicide (Android) açılır.
3. Paylaş: iOS Fotoğraflar'dan GeckoMail seçilir, `GeckoMail'i açın` görünür, uygulama açılınca oluşturucuda ek durur. Android `adb shell am start -a android.intent.action.SEND -t image/png --eu android.intent.extra.STREAM <content adresi> com.kodviva.geckomail`.
4. Arka plan: uygulama 16 dakika arkada bekler, dönüşte bağlantı kendiliğinden gelir.
5. Kilit: Ayarlar'dan kilit açılır, arka plana gidilir, dönüşte kilit ekranı görünür.
6. İptal: `curl -X POST localhost:9102/revoke`, uygulama giriş ekranına döner, push anahtarı silinir.
7. Boşta: `curl -X POST localhost:9102/idle`, uygulama giriş ister, push açık kalır, yeniden girişte `GET /devices` cihazı yeni oturumda gösterir.

## Doğrulanamayanlar

Gerçek APNs ve FCM teslimi, NSE'nin gerçek akışta çalışması, `time-sensitive` etkisi: yalnız gerçek cihaz ve sahibin anahtarlarıyla.
