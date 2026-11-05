# Ekran görüntüleri

Yalnız demo yığını verisi (`example.test`). Gerçek adres ya da hesap yok. Her boyut için tr ve en.

| Cihaz | Piksel | Simülatör |
|---|---|---|
| iPhone 6.9" | 1320×2868 | iPhone 17 Pro Max |
| iPad 13" | 2064×2752 | iPad Pro 13-inch (M5) |
| Android telefon | 1080×2400 | `Medium_Phone_API_VanillaIceCream` |
| Android 7" tablet | 1200×1920 | sahibi |
| Android 10" tablet | 1600×2560 | sahibi |

Her cihazda sırayla:

1. Gelen kutusu
2. İleti
3. Kurallar
4. Bildirim ve eylem
5. Biyometrik kilit
6. Koyu tema

Üretim: `ops/demo` yığını kaldırılır, `scripts/demo-seed.mjs` çalışır, simülatörde `http://localhost:9006` ile girilir (Debug paketi), `xcrun simctl io booted screenshot` ile alınır. Durum çubuğu `xcrun simctl status_bar booted override --time 9:41`. Boyut denetimi: `sips -g pixelWidth -g pixelHeight`.
