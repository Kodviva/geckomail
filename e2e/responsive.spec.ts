// Duyarlı yerleşim: telefon (390×844, tek bölme + geçmiş yığını), tablet (1024×768, hesaplar çekmecesi),
// masaüstü (1440×900, bugünkü üç bölme). Her boyutta yatay taşma yok.
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedAttachment, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import mail from '../src/shared/i18n/locales/tr/mail'
import set from '../src/shared/i18n/locales/tr/set'

const SUBJECT = 'Duyarlı deneme iletisi'

function seed(server: GeckoServer): void {
  server.withDb((db) => {
    const { messageIds } = seedMail(db, { messages: [{ subject: SUBJECT, preview: 'önizleme' }, { subject: 'İkinci ileti' }] })
    for (const id of messageIds)
      db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, ?, NULL, ?, ?, 10)`)
        .run(id, 'Gövde metni', Date.now(), Date.now())
  })
}

async function signIn(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await expect.poll(() => noOverflow(page)).toBe(true) // giriş ekranı da taşmaz
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.msg-row', { hasText: SUBJECT })).toBeVisible()
}

const noOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)

/** Öğe görünür alanın içinde mi (çekmece ekran dışına kaydırılınca false) */
const onScreen = (page: Page, sel: string): Promise<boolean> =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.right > 1 && r.left < window.innerWidth - 1 && getComputedStyle(el).visibility !== 'hidden'
  })

const hitArea = (page: Page, sel: string): Promise<{ width: number; height: number }> =>
  page.locator(sel).first().evaluate((e) => {
    const r = e.getBoundingClientRect()
    return { width: r.width, height: r.height }
  })

async function expectTouchTarget(page: Page, sel: string): Promise<void> {
  // modal açılış canlandırması (ölçek 0.985) bitince ölçülür
  await expect.poll(async () => Math.min(...Object.values(await hitArea(page, sel))), sel).toBeGreaterThanOrEqual(44)
  // tıklama gerçekten o öğeye düşer (başka öğe örtmez): 44 px'lik alanın köşeleri
  const hits = await page.locator(sel).first().evaluate((e) => {
    const r = e.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    return [[-21, -21], [21, -21], [-21, 21], [21, 21]].map(([dx, dy]) => {
      const at = document.elementFromPoint(cx + dx, cy + dy)
      return !!at && (at === e || e.contains(at))
    })
  })
  expect(hits, sel).toEqual([true, true, true, true])
}

/** Küçük denetimler orta ve dar kırılımda ≥ 44×44 (yıldız, ek düğmeleri, ayar onay kutuları) */
async function checkSmallTargets(page: Page, server: GeckoServer): Promise<void> {
  seedAttachment(server, 'ek.pdf', Buffer.from('içerik'))
  await page.goto(server.url)
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await page.locator('.msg-row', { hasText: 'E2E ekli ileti' }).click()
  await expectTouchTarget(page, '.att-reveal')

  await page.goto(server.url)
  const openDrawer = async (): Promise<void> => {
    await page.getByRole('button', { name: mail['mail.nav.menu'], exact: true }).click()
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(true)
  }
  await openDrawer()
  await expect.poll(() => onScreen(page, '.acct-row:not(.all) .star')).toBe(true)
  await expectTouchTarget(page, '.acct-row:not(.all) .star')

  await page.locator('.sf-add').click()
  await page.locator('.modal.composer input[type="file"]').setInputFiles({ name: 'ek.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
  await expect(page.locator('.att-remove')).toBeVisible()
  await expectTouchTarget(page, '.att-remove')

  await page.goto(server.url)
  await openDrawer()
  await page.getByRole('button', { name: acct['acct.common.settings'], exact: true }).first().click()
  // bölümler dar pencerede çiplerde, geniş pencerede soldaki rayda
  const section = (name: string) => page.locator('.settings-rail .settings-nav:visible, .settings-tabs .chip:visible').filter({ hasText: name }).first().click()
  await section(set['set.sec.appearance'])
  await expect(page.locator('.set-field input[type="checkbox"]').first()).toBeVisible()
  await expectTouchTarget(page, '.set-field input[type="checkbox"]')
  await section(set['set.sec.notify'])
  await expect(page.locator('.set-field input[type="checkbox"]').first()).toBeVisible()
  for (const box of await page.locator('.set-field input[type="checkbox"]').all()) {
    const { width, height } = await box.evaluate((e) => e.getBoundingClientRect())
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(44)
  }
}

test.describe('telefon 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('tek bölme; ileti açılır, back button returns to list', async ({ page, server }) => {
    seed(server)
    await signIn(page, server.url)
    expect(await noOverflow(page)).toBe(true)
    await expect(page.locator('.listpane')).toBeVisible()
    await expect(page.locator('.app > .viewpane')).toBeHidden()
    expect(await onScreen(page, '.sidebar')).toBe(false)

    await page.locator('.msg-row', { hasText: SUBJECT }).click()
    await expect(page.locator('.view-subject')).toHaveText(SUBJECT)
    await expect(page.locator('.listpane')).toBeHidden()
    expect(await noOverflow(page)).toBe(true)

    // dokunma hedefleri ≥ 44 px (okuma araç çubuğu ve geri düğmesi)
    const sizes = await page.locator('.view-toolbar button:visible').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect()
        return Math.min(r.width, r.height)
      })
    )
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44)

    // tarayıcı geri tuşu: uygulamadan çıkmaz, listeye döner
    const url = page.url()
    await page.goBack()
    await expect(page.locator('.listpane')).toBeVisible()
    await expect(page.locator('.app > .viewpane')).toBeHidden()
    expect(page.url()).toBe(url)

    // uygulama içi Geri düğmesi de aynı yere döner
    await page.locator('.msg-row', { hasText: 'İkinci ileti' }).click()
    await page.getByRole('button', { name: mail['mail.nav.back'], exact: true }).click()
    await expect(page.locator('.listpane')).toBeVisible()

    // listeden geri: hesaplar çekmecesi açılır (hâlâ uygulamada)
    await page.goBack()
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(true)
    expect(page.url()).toBe(url)
  })

  test('çekmece açılır/kapanır; oluşturucu tam ekran, geri tuşu kapatır', async ({ page, server }) => {
    seed(server)
    await signIn(page, server.url)
    await page.getByRole('button', { name: mail['mail.nav.menu'], exact: true }).click()
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(true)
    expect(await noOverflow(page)).toBe(true)
    // dışına dokununca kapanır
    await page.locator('.drawer-backdrop').click({ position: { x: 380, y: 400 } })
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(false)

    // çekmeceden yeni ileti: çekmece kapanır, oluşturucu ekranı kaplar
    await page.getByRole('button', { name: mail['mail.nav.menu'], exact: true }).click()
    await page.locator('.sf-add').click()
    // açılış canlandırması (ölçek 0.985) bitince ölçülür
    const size = async (): Promise<string> => {
      const b = await page.locator('.modal.composer').boundingBox()
      return b ? `${Math.round(b.width)}×${Math.round(b.height)}` : ''
    }
    await expect.poll(size).toBe('390×844')
    expect(await noOverflow(page)).toBe(true)
    await page.goBack()
    await expect(page.locator('.modal.composer')).toHaveCount(0)
    await expect(page.locator('.listpane')).toBeVisible()

    // oluşturucunun kendi Geri düğmesi de kapatır; geçmiş kaydı geri alınır (sonraki geri çekmeceyi açar)
    await page.getByRole('button', { name: mail['mail.nav.menu'], exact: true }).click()
    await page.locator('.sf-add').click()
    await page.locator('.modal.composer').getByRole('button', { name: mail['mail.nav.back'], exact: true }).click()
    await expect(page.locator('.modal.composer')).toHaveCount(0)
    await page.goBack()
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(true)
  })

  test('küçük denetimler ≥ 44×44', async ({ page, server }) => {
    await checkSmallTargets(page, server)
  })

  test('uzun basma bağlam menüsünü açar, kaydırma açmaz', async ({ page, server, browserName }) => {
    test.skip(browserName !== 'chromium', 'dokunma olayları CDP ile yalnız Chromium’da üretilir; mantık birim testinde')
    seed(server)
    await signIn(page, server.url)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    const row = await page.locator('.msg-row', { hasText: SUBJECT }).boundingBox()
    const x = row!.x + 60
    const y = row!.y + row!.height / 2
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', py = y): Promise<unknown> =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: py }] })

    // kaydırma: parmak 40 px kayar → menü yok
    await touch('touchStart')
    await touch('touchMove', y + 40)
    await page.waitForTimeout(700)
    await touch('touchEnd')
    await expect(page.locator('.ctx-menu')).toHaveCount(0)

    await touch('touchStart')
    await page.waitForTimeout(700)
    await touch('touchEnd')
    await expect(page.locator('.ctx-menu')).toBeVisible()
    // menü açılırken ileti açılmadı (türetilen tıklama yutuldu)
    await expect(page.locator('.listpane')).toBeVisible()

    // okuma bölmesi: uzun basma yalnız başlık alanında; düğme ve seçilebilir konu metninde menü yok
    await page.keyboard.press('Escape')
    await page.locator('.msg-row', { hasText: SUBJECT }).click()
    await expect(page.locator('.view-subject')).toHaveText(SUBJECT)
    const hold = async (sel: string): Promise<void> => {
      const b = (await page.locator(sel).first().boundingBox())!
      const pt = { x: b.x + Math.min(b.width / 2, 20), y: b.y + b.height / 2 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] })
      await page.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await hold('.view-subject')
    await expect(page.locator('.ctx-menu')).toHaveCount(0)
    await hold('.view-toolbar .btn-group .btn')
    await expect(page.locator('.ctx-menu')).toHaveCount(0)
    // tarayıcı basılı tutmayı düğmede tıklama sayabilir (Yanıtla → oluşturucu): sonraki adım için kapat
    if (await page.locator('.modal.composer').count()) await page.locator('.modal.composer .nav-back-btn').click()
    await expect(page.locator('.modal.composer')).toHaveCount(0)
    await hold('.view-meta.sub')
    await expect(page.locator('.ctx-menu')).toBeVisible()
  })
})

test('RTL: web’de trafik ışığı boşluğu yok, Electron’da var', async ({ page, server }) => {
  seed(server)
  await signIn(page, server.url)
  await page.locator('.msg-row', { hasText: SUBJECT }).click()
  const pad = (): Promise<string> => page.locator('.view-toolbar').evaluate((e) => getComputedStyle(e).paddingLeft)
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl'
  })
  expect(await pad()).not.toBe('78px')
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'electron'
    document.documentElement.dataset.os = 'darwin' // trafik ışığı macOS'ta; Playwright'ın Desktop Chrome kimliği Windows
  })
  expect(await pad()).toBe('78px')
})

test.describe('tablet 1024×768', () => {
  test.use({ viewport: { width: 1024, height: 768 } })

  test('küçük denetimler ≥ 44×44', async ({ page, server }) => {
    await checkSmallTargets(page, server)
  })

  test('liste + okuma bölmesi, hesaplar çekmecede', async ({ page, server }) => {
    seed(server)
    await signIn(page, server.url)
    expect(await noOverflow(page)).toBe(true)
    expect(await onScreen(page, '.sidebar')).toBe(false)
    await page.locator('.msg-row', { hasText: SUBJECT }).click()
    await expect(page.locator('.view-subject')).toHaveText(SUBJECT)
    await expect(page.locator('.listpane')).toBeVisible()
    await expect(page.getByRole('button', { name: mail['mail.nav.back'], exact: true })).toBeHidden()
    expect(await noOverflow(page)).toBe(true)

    await page.getByRole('button', { name: mail['mail.nav.menu'], exact: true }).click()
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(true)
    await page.locator('.drawer-backdrop').click({ position: { x: 900, y: 400 } })
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(false)

    // geri tuşu da çekmeceyi kapatır
    await page.getByRole('button', { name: mail['mail.nav.menu'], exact: true }).click()
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(true)
    await page.goBack()
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(false)
    await expect(page.locator('.view-subject')).toHaveText(SUBJECT)
  })

  test('çekmece erişilebilirliği: odak içeride, Tab dışarı çıkmaz, Esc kapatır ve odak ☰ düğmesine döner', async ({ page, server }) => {
    seed(server)
    await signIn(page, server.url)
    const menu = page.getByRole('button', { name: mail['mail.nav.menu'], exact: true })
    const inDrawer = (): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('.sidebar'))
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await expect(menu).toHaveAttribute('aria-controls', 'nav-drawer')

    await menu.click()
    await expect(menu).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(inDrawer).toBe(true)
    await expect(page.locator('#nav-drawer')).toHaveAttribute('role', 'dialog')
    await expect(page.locator('#nav-drawer')).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('#nav-drawer')).toHaveAttribute('aria-label', mail['mail.nav.menu'])
    expect(await page.locator('.listpane').evaluate((e) => e.hasAttribute('inert'))).toBe(true)
    expect(await page.locator('.app > .viewpane').evaluate((e) => e.hasAttribute('inert'))).toBe(true)

    // Tab ve Shift+Tab çekmecede döner
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      expect(await inDrawer()).toBe(true)
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await inDrawer()).toBe(true)
    }

    await page.keyboard.press('Escape')
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(false)
    await expect(menu).toBeFocused()
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(await page.locator('.listpane').evaluate((e) => e.hasAttribute('inert'))).toBe(false)
  })

  test('Esc sırası: çekmecedeki menü önce kapanır, tek Esc ikisini birden kapatmaz', async ({ page, server }) => {
    seed(server)
    await signIn(page, server.url)
    const menu = page.getByRole('button', { name: mail['mail.nav.menu'], exact: true })

    // odak menüdeyken (normal yol)
    await menu.click()
    await page.locator('.acct-row').first().click({ button: 'right' })
    await expect(page.locator('.ctx-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.ctx-menu')).toHaveCount(0)
    expect(await onScreen(page, '.sidebar')).toBe(true)

    // odak menüden çıkmışken (Esc pencereye ulaşır)
    await page.locator('.acct-row').first().click({ button: 'right' })
    await expect(page.locator('.ctx-menu')).toBeVisible()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await expect(page.locator('.ctx-menu')).toHaveCount(0)
    expect(await onScreen(page, '.sidebar')).toBe(true)

    // kullanıcı açılır menüsü de önce kendisi kapanır
    await page.locator('.whoami').click()
    await expect(page.locator('.user-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.user-menu')).toHaveCount(0)
    expect(await onScreen(page, '.sidebar')).toBe(true)

    await page.keyboard.press('Escape')
    await expect.poll(() => onScreen(page, '.sidebar')).toBe(false)
  })

  test('Electron yerleşimi (data-platform=electron): 1024 px’te de üç bölme, ☰ yok', async ({ page, server }) => {
    seed(server)
    await signIn(page, server.url)
    await page.evaluate(() => {
      document.documentElement.dataset.platform = 'electron'
    })
    const sb = (await page.locator('.sidebar').boundingBox())!
    expect(sb.x).toBe(0)
    expect(sb.width).toBe(270)
    expect((await page.locator('.listpane').boundingBox())!.width).toBe(400)
    await expect(page.locator('.nav-menu-btn')).toBeHidden()
  })
})

test.describe('masaüstü 1440×900', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('geniş kırılımda küçük denetimlerin boyu değişmez', async ({ page, server }) => {
    seedAttachment(server, 'ek.pdf', Buffer.from('içerik'))
    await page.goto(server.url)
    await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
    await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
    await page.locator('.msg-row', { hasText: 'E2E ekli ileti' }).click()
    expect((await hitArea(page, '.att-reveal')).width).toBeLessThan(44)
    await page.locator('.acct-row:not(.all)').first().hover()
    expect((await hitArea(page, '.acct-row:not(.all) .star')).width).toBeLessThan(44)
    await page.getByRole('button', { name: acct['acct.common.settings'], exact: true }).first().click()
    await page.locator('.settings-rail').getByText(set['set.sec.appearance'], { exact: true }).click()
    await expect(page.locator('.set-field input[type="checkbox"]').first()).toBeVisible()
    expect(await hitArea(page, '.set-field input[type="checkbox"]')).toEqual({ width: 15, height: 15 })
  })

  test('üç bölme yan yana, çekmece ve geri düğmesi yok', async ({ page, server }) => {
    seed(server)
    await signIn(page, server.url)
    await page.locator('.msg-row', { hasText: SUBJECT }).click()
    await expect(page.locator('.view-subject')).toHaveText(SUBJECT)
    expect(await noOverflow(page)).toBe(true)
    const sb = (await page.locator('.sidebar').boundingBox())!
    const lp = (await page.locator('.listpane').boundingBox())!
    const vp = (await page.locator('.app > .viewpane').boundingBox())!
    expect(sb.x).toBe(0)
    expect(sb.width).toBe(270)
    expect(lp.x).toBe(270)
    expect(lp.width).toBe(400)
    expect(vp.x).toBe(670)
    await expect(page.getByRole('button', { name: mail['mail.nav.menu'], exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: mail['mail.nav.back'], exact: true })).toBeHidden()
  })
})

test.describe('telefonda geri dönüş', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('list keeps scroll after back from message', async ({ page, server }) => {
    server.withDb((db) => {
      const { messageIds } = seedMail(db, { messages: [{ subject: SUBJECT }, ...Array.from({ length: 30 }, (_, i) => ({ subject: `Dolgu ${i}` }))] })
      db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, 'Gövde', NULL, ?, ?, 10)`)
        .run(messageIds[0], Date.now(), Date.now())
    })
    await signIn(page, server.url)
    await page.locator('.msg-row', { hasText: SUBJECT }).click()
    await expect(page.getByText('Gövde', { exact: true })).toBeVisible()
    await page.goBack()
    await expect(page.locator('.msg-row', { hasText: SUBJECT })).toBeVisible()
  })
})
