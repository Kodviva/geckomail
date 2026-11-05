# Güvenlik

## Açık bildirimi

Herkese açık issue açmayın. `guvenlik@kodviva.com` adresine yazın ya da GitHub'ın özel güvenlik bildirimini kullanın.

Bildiriminizde sürümü, kurulum biçimini (masaüstü, sunucu, mobil) ve yeniden üretme adımlarını yazın. Üç iş günü içinde yanıt, düzeltme hazır olana dek gizlilik bekliyoruz. Gerçek kullanıcı verisine erişmeyin, başkasının hesabını denemeyin, kendi kurulumunuzda sınayın.

Bildirim ödülü yoktur. İsterseniz sürüm notunda adınız yazılır.

## Kapsam

Desteklenen: son kararlı sürüm. Ayrıntılı tehdit modeli ve bilinen sınırlar: `docs/GIZLILIK.md`.

## Tarayıcı uyarıları

`src/sync/smime/__tests__/fixtures/` altındaki `.key`, `.p12` ve `.pem` dosyaları yalnız test içindir, üretimde hiçbir yerde geçerli değildir. `.gitleaks.toml` bu dizini dışlar.
