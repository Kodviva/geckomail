# Yedek ve yükseltme

## Yedek

Ayarlar › Yedekleme'den yedek indirilir. Ana anahtar (`GECKO_KEY_FILE`) yedeğin içinde değildir, ayrı saklayın. Anahtar yoksa yedek açılmaz.

Geri yükleme yeniden başlatmada uygulanır, önceki veritabanı `/data/geckomail.db.bak-<zaman>` olarak kalır. Geri yükleme tüm oturumları ve bildirim cihazlarını siler, herkes yeniden girer. Kapsayıcının `restart: unless-stopped` ile çalışması gerekir.

## Yükseltme

1. Yedek alın.
2. `docker-compose.yml` içindeki imaj sürümünü değiştirin, `docker compose up -d`.
3. Göçler açılışta çalışır, tek yönlüdür. Geri dönmek yedekten olur: eski sürüm yeni şemayı açmaz.

Masaüstünde yükseltme otomatiktir, açılışta veritabanının yedeği alınır.

## Kurtarma

Masaüstünde terminalden, ağa çıkmadan:

```bash
npm run reset-password   # giriş parolası
npm run reset-vault      # kasa parolası kaybı, YIKICI: kasa hesapları silinir
```

Sunucuda `reset-2fa` ve `unlock` gibi işler kapsayıcı içindeki CLI ile yapılır.
