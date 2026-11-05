# Katkı

Hata bildirimi ve öneri için GitHub Issues kullanın. Güvenlik açıkları için bkz. `SECURITY.md`, herkese açık issue açmayın.

## Kod katkısı

1. Büyük değişiklikten önce issue açın.
2. Değişikliği ve testini aynı PR'da gönderin.
3. `npm run typecheck`, `npm run lint`, `npx vitest run` geçmeli.
4. Arayüz metni 11 dilde olmalı (`src/shared/i18n/locales/`), ardından `npm run i18n:index`.
5. Yeni bağımlılık AGPL uyumlu lisanslı (MIT, Apache-2.0, BSD, MPL) ve sabit sürümlü olmalı.
6. Gerçek ad, alan adı, adres ya da parola testlere girmez: `example.test` kullanın.

## CLA

Dışarıdan katkılar `CLA.md` ile kabul edilir. İlk PR'ınızda açıklamaya şunu yazın:

> CLA.md metnini okudum ve bu katkı ile sonraki katkılarım için kabul ediyorum.
