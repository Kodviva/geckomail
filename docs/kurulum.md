# Sunucu kurulumu

Sunucu tek Docker kapsayıcısıdır. Web istemcisi, masaüstü sunucu modu ve mobil uygulama aynı sunucuya bağlanır.

## Docker

1. `deploy/docker-compose.example.yml` dosyasını kopyalayın.
2. `GECKO_PUBLIC_ORIGIN` değerini kendi adresinizle değiştirin.
3. Ana anahtarı üretin ve veriden ayrı yedekleyin: `head -c 32 /dev/urandom > geckomail_key`, sonra `sudo chown 10001:10001 geckomail_key && sudo chmod 0400 geckomail_key`. Bu dosya olmadan yedek açılmaz.
4. `docker compose up -d`
5. İlk yöneticiyi oluşturun: `docker compose exec geckomail node /app/server/index.mjs create-admin yonetici`. Sonra tarayıcıda adresi açın, ayarlardan kasayı kurun.

İmaj `ghcr.io/kodviva/geckomail-server`. Sürüm etiketi kullanın, `latest` yoktur.

## Ters vekil

Kapsayıcı yalnız `127.0.0.1:8080` üzerinde dinlesin, TLS ters vekilde sonlansın. WebSocket yükseltmesi `/rpc` için açık olmalı. Caddy örneği:

```
posta.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Vekil sayısını `GECKO_TRUSTED_PROXY_DEPTH` ile bildirin: yanlış değer giriş sınırlarını yanlış IP'ye yazar.

## Ortam değişkenleri

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `GECKO_PUBLIC_ORIGIN` | zorunlu | Tarayıcının kullandığı tam köken. `http` yalnız localhost için |
| `GECKO_KEY_FILE` | `<veri>/master.key` | Ana anahtar. Docker secret olarak verin |
| `GECKO_DATA_DIR` | `/data` | Veritabanı ve ekler |
| `GECKO_LISTEN` | `0.0.0.0:8080` | Dinlenen adres |
| `GECKO_TRUSTED_PROXY_DEPTH` | `0` | Önünüzdeki ters vekil sayısı |
| `GECKO_IDLE_MAX` | `40` | IMAP IDLE ile anlık izlenen hesap üst sınırı, kalanı 120 sn yoklanır |
| `GECKO_DAV_PRIVATE_HOSTS` | boş | İç ağdaki DAV sunucuları, `ad:port` virgüllü |
| `GECKO_MAIL_PRIVATE_HOSTS` | boş | İç ağdaki IMAP ve SMTP sunucuları, `ad` ya da `ad:port` virgüllü. Listede olmayan iç adrese bağlanılmaz |
| `GECKO_MOBILE` | `1` | `0` mobil yolu tümüyle kapatır |
| `GECKO_RELAY_URL` | `https://relay.kodviva.com` | Mobil bildirim rölesi, `off` kapatır |
| `GECKO_WEB_DIR` | imaj içi | Web istemcisi dosyaları |

Sunucuyu değiştirip işletiyorsanız AGPL §13 gereği kullanıcılar kaynağınıza ulaşmalı: `src/shared/brand.ts`.
