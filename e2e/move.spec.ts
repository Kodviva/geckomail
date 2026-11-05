// Postaları taşıma uçtan uca: sürükle bırak (tek satır, seçim, birleşik görünümde geçici klasörler, kapalı grup),
// Taşı penceresi (arama, klavye), Geri Al, hesaplar arası ret, dar ekranda Seç + Taşı, çevrimdışı kapalı.
// Örnek hesapların IMAP'i yok: taşıma op_queue'da bekler, satırlar hidden olur.
import type { BrowserContext, Locator, Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import common from '../src/shared/i18n/locales/tr/common'
import mail from '../src/shared/i18n/locales/tr/mail'
import set from '../src/shared/i18n/locales/tr/set'
import sync from '../src/shared/i18n/locales/tr/sync'

const A = 'birinci@example.test'
const B = 'ikinci@example.test'
const S = ['A ileti bir', 'A ileti iki', 'A ileti üç']

type Seeded = { a: number; b: number; ids: number[]; projeler: number; bIds: number[] }

function seed(server: GeckoServer): Seeded {
  return server.withDb((db) => {
    const first = seedMail(db, { email: A, messages: S.map((subject) => ({ subject })) })
    const second = seedMail(db, { email: B, messages: [{ subject: 'B ileti' }] })
    const folder = db.prepare(`INSERT INTO folders (account_id, path, kind, special_use) VALUES (?, ?, 'other', 0)`)
    const projeler = Number(folder.run(first.accountId, 'INBOX.Projeler').lastInsertRowid)
    folder.run(first.accountId, 'INBOX.Arşivlik')
    folder.run(second.accountId, 'INBOX.Yabancı')
    return { a: first.accountId, b: second.accountId, ids: first.messageIds, projeler, bIds: second.messageIds }
  })
}

async function signIn(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

const row = (page: Page, subject: string): Locator => page.locator('.msg-row', { hasText: subject })
const folderRow = (page: Page, name: string): Locator => page.locator('.folder-row', { hasText: name })
const moveBtn = (page: Page): Locator => page.locator('.bulk-bar').getByRole('button', { name: mail['mail.view.moveToFolder'], exact: true })
const search = (page: Page): Locator => page.getByRole('combobox', { name: mail['mail.move.search'] })

// örnek hesapların görünen adı aynı: e-posta satırın title'ında
const acctRow = (page: Page, email: string): Locator => page.locator(`.acct-row[title^="${email}"]`)

const pickAccount = async (page: Page, email: string): Promise<void> => {
  await acctRow(page, email).click()
  await expect(page.locator('.folder-tree')).toBeVisible()
}

/** Hedef yüklenmeden elle sürükleme: basılı tutup hedef belirince bırakılır */
async function dragStart(page: Page, from: Locator): Promise<void> {
  await from.hover()
  await page.mouse.down()
  const box = (await from.boundingBox())!
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 4 })
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 4 })
}
async function dragOver(page: Page, to: Locator): Promise<void> {
  const box = (await to.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 })
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2 + 1, { steps: 2 })
}

const hiddenCount = (server: GeckoServer, ids: number[]): number =>
  server.withDb((db) => (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE hidden = 1 AND id IN (${ids.join(',')})`).get() as { n: number }).n)
const moveOps = (server: GeckoServer): number =>
  server.withDb((db) => (db.prepare(`SELECT COUNT(*) AS n FROM op_queue WHERE kind = 'move'`).get() as { n: number }).n)

test('tek satır klasöre sürüklenir, sürükleme görseli ve vurgu çalışır', async ({ page, server }) => {
  const s = seed(server)
  await signIn(page, server.url)
  await pickAccount(page, A)
  await dragStart(page, row(page, S[0]))
  const target = folderRow(page, 'Projeler')
  await expect(target).toHaveClass(/droppable/)
  await dragOver(page, target)
  await expect(target).toHaveClass(/drop-over/)
  await page.mouse.up()
  await expect(row(page, S[0])).toHaveCount(0)
  await expect(row(page, S[1])).toBeVisible()
  await expect(page.locator('.toast', { hasText: '1 mail taşındı' })).toBeVisible()
  await expect.poll(() => hiddenCount(server, [s.ids[0]])).toBe(1)
  expect(moveOps(server)).toBe(1)
})

test('seçili üç satır birlikte sürüklenir; açık ileti başkasıysa kapanmaz', async ({ page, server }) => {
  const s = seed(server)
  await signIn(page, server.url)
  await pickAccount(page, A)
  for (const subject of S) await row(page, subject).click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.bulk-count')).toHaveText('3 seçili')
  await dragStart(page, row(page, S[1]))
  await dragOver(page, folderRow(page, 'Projeler'))
  await page.mouse.up()
  await expect(page.locator('.msg-row')).toHaveCount(0)
  await expect(page.locator('.bulk-bar')).toHaveCount(0)
  await expect.poll(() => hiddenCount(server, s.ids)).toBe(3)
})

test('sürüklenen satır kaydırmada sanal listeden düşmez', async ({ page, server }) => {
  server.withDb((db) => {
    const { accountId } = seedMail(db, { email: A, messages: Array.from({ length: 80 }, (_, i) => ({ subject: `Uzun liste ${i + 1}.` })) })
    db.prepare(`INSERT INTO folders (account_id, path, kind, special_use) VALUES (?, 'INBOX.Projeler', 'other', 0)`).run(accountId)
  })
  await signIn(page, server.url)
  await pickAccount(page, A)
  const first = row(page, 'Uzun liste 1.')
  await dragStart(page, first)
  await page.locator('.list-body').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(row(page, 'Uzun liste 80.')).toBeAttached()
  await expect(first).toBeAttached()
  await dragOver(page, folderRow(page, 'Projeler'))
  await page.mouse.up()
  await expect(first).toHaveCount(0)
  await expect(page.locator('.toast', { hasText: '1 mail taşındı' })).toBeVisible()
})

test('birleşik gelen kutusunda sürükleyince hesabın klasörleri geçici açılır, bitince kapanır', async ({ page, server }) => {
  const s = seed(server)
  await signIn(page, server.url)
  await expect(page.locator('.folder-tree')).toHaveCount(0)
  await dragStart(page, row(page, S[2]))
  await expect(folderRow(page, 'Projeler')).toBeVisible()
  await expect(folderRow(page, 'Yabancı')).toHaveCount(0) // yalnız sürüklenenin hesabı
  await dragOver(page, folderRow(page, 'Projeler'))
  await page.mouse.up()
  await expect(row(page, S[2])).toHaveCount(0)
  await expect(page.locator('.folder-tree')).toHaveCount(0)
  await expect.poll(() => hiddenCount(server, [s.ids[2]])).toBe(1)
})

test('başka hesaba bırakılamaz: açıklama görünür, ileti yerinde kalır', async ({ page, server }) => {
  const s = seed(server)
  await signIn(page, server.url)
  await dragStart(page, row(page, S[0]))
  await expect(folderRow(page, 'Projeler')).toBeVisible()
  const other = acctRow(page, B)
  await dragOver(page, other)
  await expect(other).toHaveClass(/no-drop/)
  await expect(page.locator('.drag-hint')).toHaveText(mail['mail.move.otherAccount'])
  await page.mouse.up()
  await expect(page.locator('.drag-hint')).toHaveCount(0)
  await expect(row(page, S[0])).toBeVisible()
  expect(moveOps(server)).toBe(0)
  expect(hiddenCount(server, s.ids)).toBe(0)
})

test('karışık hesap seçimi: sürükleme başlamaz, Taşı kapalı ve açıklamalı', async ({ page, server }) => {
  seed(server)
  await signIn(page, server.url)
  await row(page, S[0]).click({ modifiers: ['ControlOrMeta'] })
  await row(page, 'B ileti').click({ modifiers: ['ControlOrMeta'] })
  await expect(moveBtn(page)).toBeDisabled()
  await expect(page.locator('.bulk-note')).toHaveText(mail['mail.move.mixedAccounts'])
  await dragStart(page, row(page, S[0]))
  await page.mouse.up()
  await expect(page.locator('.folder-tree')).toHaveCount(0)
  await expect(row(page, S[0])).toBeVisible()
})

test('konu satırı sürüklenince klasördeki bütün iletileri taşınır', async ({ page, server }) => {
  const s = seed(server)
  server.withDb((db) => {
    db.prepare(`UPDATE messages SET thread_root = '<konu@example.test>' WHERE id IN (?, ?)`).run(s.ids[0], s.ids[1])
  })
  await page.addInitScript(() => localStorage.setItem('gecko-threads', '1'))
  await signIn(page, server.url)
  await pickAccount(page, A)
  await expect(page.locator('.msg-row')).toHaveCount(2) // konu + tek ileti
  await dragStart(page, page.locator('.msg-row', { has: page.locator('.thread-badge') }))
  await dragOver(page, folderRow(page, 'Projeler'))
  await page.mouse.up()
  await expect.poll(() => hiddenCount(server, [s.ids[0], s.ids[1]])).toBe(2)
  expect(hiddenCount(server, [s.ids[2]])).toBe(0)
  await expect(page.locator('.toast', { hasText: '2 mail taşındı' })).toBeVisible()
})

test('yalnız görme yetkili üye: sürükleme ve Taşı kapalı, neden yazar', async ({ page, server }) => {
  const s = seed(server)
  await server.createUser('uye', 'uye-parola-1234')
  server.withDb((db) => {
    const g = Number(db.prepare(`INSERT INTO groups (name, color, created_at) VALUES ('Salt', '#112233', ?)`).run(Date.now()).lastInsertRowid)
    db.prepare(`UPDATE accounts SET group_id = ? WHERE id = ?`).run(g, s.a)
    const u = db.prepare(`UPDATE users SET role = 'member' WHERE username = 'uye' RETURNING id`).get() as { id: number }
    db.prepare(`INSERT INTO user_group_permissions (user_id, group_id, can_view, can_manage) VALUES (?, ?, 1, 0)`).run(u.id, g)
  })
  await page.goto(server.url)
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill('uye')
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill('uye-parola-1234')
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(row(page, S[0])).toBeVisible()
  await expect(row(page, S[0])).not.toHaveAttribute('draggable', 'true')
  await row(page, S[0]).click({ modifiers: ['ControlOrMeta'] })
  await expect(moveBtn(page)).toBeDisabled()
  await expect(page.locator('.bulk-note')).toHaveText(sync['sync.perm.cannotManage'])
})

test('kapalı grubun üstünde 700 ms beklemek klasörleri açar', async ({ page, server }) => {
  const s = seed(server)
  server.withDb((db) => {
    const g = db.prepare(`INSERT INTO groups (name, color, created_at) VALUES ('Ekip', '#112233', ?)`).run(Date.now()).lastInsertRowid
    db.prepare(`UPDATE accounts SET group_id = ? WHERE id = ?`).run(g, s.a)
  })
  await page.addInitScript(() => localStorage.setItem('gecko-collapsed-groups', '["Ekip"]'))
  await signIn(page, server.url)
  await expect(page.locator('.acct-group-toggle.collapsed')).toBeVisible()
  await dragStart(page, row(page, S[0]))
  const head = page.locator('.acct-group-head', { hasText: 'Ekip' })
  await expect(head).toHaveClass(/drop-hold/)
  await expect(folderRow(page, 'Projeler')).toHaveCount(0)
  await dragOver(page, head)
  await expect(folderRow(page, 'Projeler')).toBeVisible({ timeout: 3000 })
  await dragOver(page, folderRow(page, 'Projeler'))
  await page.mouse.up()
  await expect(row(page, S[0])).toHaveCount(0)
  // geçici açılış kalıcı durumu değiştirmez
  await expect(page.locator('.acct-group-toggle.collapsed')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('gecko-collapsed-groups'))).toBe('["Ekip"]')
})

test('bulk-bar Taşı: arama, klavye, Enter; Geri Al iletileri döndürür', async ({ page, server }) => {
  const s = seed(server)
  await signIn(page, server.url)
  await pickAccount(page, A)
  await row(page, S[0]).click({ modifiers: ['ControlOrMeta'] })
  await row(page, S[2]).click({ modifiers: ['ControlOrMeta'] })
  await moveBtn(page).focus()
  await page.keyboard.press('Enter')
  await expect(search(page)).toBeFocused()
  await expect(page.locator('.move-list [role=option]')).toHaveCount(2) // kaynak klasör (INBOX) yok
  await page.keyboard.type('arsiv') // Türkçe katlamalı
  await expect(page.locator('.move-list [role=option]')).toHaveText(['Arşivlik'])
  await search(page).clear()
  await page.keyboard.type('proje')
  await page.keyboard.press('Enter')
  await expect(page.locator('.move-dialog')).toHaveCount(0)
  await expect(row(page, S[0])).toHaveCount(0)
  await expect(row(page, S[2])).toHaveCount(0)
  await expect(row(page, S[1])).toBeVisible()
  await expect.poll(() => moveOps(server)).toBe(1)
  await expect.poll(() => hiddenCount(server, s.ids)).toBe(2)

  await page.locator('.toast').getByRole('button', { name: mail['mail.toast.undo'], exact: true }).click()
  await expect(page.locator('.toast', { hasText: mail['mail.toast.moveUndone'] })).toBeVisible()
  await expect(row(page, S[0])).toBeVisible()
  await expect(row(page, S[2])).toBeVisible()
  expect(moveOps(server)).toBe(0)
  expect(hiddenCount(server, s.ids)).toBe(0)
})

test('pencerede ok tuşları gezer, Esc kapatır ve seçim kalır; okuma araç çubuğundan da açılır', async ({ page, server }) => {
  const s = seed(server)
  server.withDb((db) =>
    db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, 'gövde', NULL, ?, ?, 10)`).run(s.ids[1], Date.now(), Date.now())
  )
  await signIn(page, server.url)
  await row(page, S[0]).click({ modifiers: ['ControlOrMeta'] })
  await moveBtn(page).focus()
  await page.keyboard.press('Enter')
  await expect(search(page)).toBeFocused()
  await expect(page.locator('.move-list [role=option]').first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.move-list [role=option]').nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(page.locator('.move-dialog')).toHaveCount(0)
  await expect(page.locator('.bulk-count')).toHaveText('1 seçili')
  await expect(moveBtn(page)).toBeFocused() // sekmeli gezinme tuşlandığı yerden sürer
  await page.getByRole('button', { name: mail['mail.list.clearSelection'] }).click()

  await row(page, S[1]).click()
  await page.locator('.view-toolbar').getByRole('button', { name: mail['mail.view.moveToFolder'], exact: true }).click()
  await page.locator('.move-list [role=option]', { hasText: 'Projeler' }).click()
  await expect(row(page, S[1])).toHaveCount(0)
  await expect.poll(() => hiddenCount(server, [s.ids[1]])).toBe(1)
})

test.describe('dar ekran', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('Seç ile seçim modu: dokunuş seçimi değiştirir, Taşı çalışır, taşma yok', async ({ page, server }) => {
    const s = seed(server)
    await signIn(page, server.url)
    await expect(row(page, S[0])).not.toHaveAttribute('draggable', 'true')
    await row(page, S[0]).click({ button: 'right' }) // uzun basmayla aynı işleyici (longPress birim testi)
    await page.getByRole('menuitem', { name: mail['mail.ctx.select'], exact: true }).click()
    await expect(page.locator('.bulk-count')).toHaveText('1 seçili')
    await row(page, S[1]).click()
    await expect(page.locator('.bulk-count')).toHaveText('2 seçili')
    await row(page, S[1]).click()
    await expect(page.locator('.bulk-count')).toHaveText('1 seçili')
    await expect(row(page, S[1])).toBeVisible() // ileti açılmadı: liste görünür
    await row(page, S[2]).click()
    const barBottom = (await page.locator('.bulk-bar').boundingBox())!
    const searchBox = (await page.locator('.list-head .search').boundingBox())!
    expect(barBottom.y).toBeLessThan(searchBox.y) // bulk-bar üstte
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const box = (await moveBtn(page).boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
    await moveBtn(page).click()
    await page.locator('.move-list [role=option]', { hasText: 'Projeler' }).click()
    await expect(page.locator('.bulk-bar')).toHaveCount(0)
    await expect.poll(() => hiddenCount(server, [s.ids[0], s.ids[2]])).toBe(2)
    // seçim modu bitti: dokunuş yeniden iletiyi açar
    await row(page, S[1]).click()
    await expect(page.locator('.bulk-bar')).toHaveCount(0)
    await expect(page.locator('.view-toolbar')).toBeVisible()
  })
})

test.describe('geniş ekranda', () => {
  test('Seç yalnız dar/orta yerleşimde; satırlar sürüklenebilir', async ({ page, server }) => {
    seed(server)
    await signIn(page, server.url)
    await expect(row(page, S[0])).toHaveAttribute('draggable', 'true')
    await row(page, S[0]).click({ button: 'right' })
    await expect(page.locator('.ctx-item', { hasText: mail['mail.ctx.open'] })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: mail['mail.ctx.select'], exact: true })).toHaveCount(0)
  })
})

async function enableOffline(page: Page): Promise<void> {
  await page.getByRole('button', { name: acct['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(set['set.sec.general'], { exact: true }).click()
  await page.getByLabel(set['set.offline.toggle'], { exact: true }).check()
  await expect(page.getByText(/ileti saklı/)).toBeVisible()
  await page.keyboard.press('Escape')
}
async function goOffline(context: BrowserContext, server: GeckoServer): Promise<void> {
  await server.stop()
  await context.setOffline(true)
}

test('çevrimdışı: sürükleme ve Taşı kapalı', async ({ page, context, server }) => {
  const s = seed(server)
  // gövdesi olmayan ileti IMAP'ten istenir, eşitleme bitmez
  server.withDb((db) => {
    const ins = db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, 'gövde', NULL, ?, ?, 10)`)
    for (const id of [...s.ids, ...s.bIds]) ins.run(id, Date.now(), Date.now())
  })
  await signIn(page, server.url)
  await enableOffline(page)
  await goOffline(context, server)
  await expect(page.locator('.list-offline')).toBeVisible()
  await expect(row(page, S[0])).not.toHaveAttribute('draggable', 'true')
  await row(page, S[0]).click({ modifiers: ['ControlOrMeta'] })
  await expect(moveBtn(page)).toBeDisabled()
  await expect(moveBtn(page)).toHaveAttribute('title', common['common.offlineReadOnly'])
})
