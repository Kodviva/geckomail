// Kişiler uçtan uca: kart ekleme, gruptan alıcı seçme, vCard indirme, sunucudaki defterden eşitleme. Masaüstü ve 375×812.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test } from './fixtures'
import { DAV_BOOK, DAV_USER } from './davServer'
import acct from '../src/shared/i18n/locales/tr/acct'
import common from '../src/shared/i18n/locales/tr/common'
import compose from '../src/shared/i18n/locales/tr/compose'
import contacts from '../src/shared/i18n/locales/tr/contacts'
import pim from '../src/shared/i18n/locales/tr/pim'

const T: Record<string, string> = { ...acct, ...common, ...compose, ...contacts, ...pim }

async function signIn(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.msg-row').first()).toBeVisible()
}

async function openContacts(page: Page): Promise<void> {
  const menu = page.locator('.nav-menu-btn').first()
  if (await menu.isVisible()) await menu.click()
  await page.locator('.app-nav').getByRole('button', { name: T['contacts.title'], exact: true }).click()
}

async function addCard(page: Page, name: string, addr: string): Promise<void> {
  await page.getByRole('button', { name: T['contacts.new'], exact: true }).click()
  await page.getByLabel(T['contacts.field.fullName'], { exact: true }).fill(name)
  await page.getByRole('textbox', { name: T['contacts.field.email'], exact: true }).fill(addr)
  await page.getByRole('button', { name: T['action.save'], exact: true }).click()
  await expect(page.locator('.pim-detail h2')).toHaveText(name)
}

const back = async (page: Page): Promise<void> => {
  if (await page.locator('.pim-listpane').count()) return
  await page.goBack()
  await expect(page.locator('.pim-listpane')).toBeVisible()
}

for (const [label, size] of [['masaüstü', { width: 1280, height: 800 }], ['telefon', { width: 375, height: 812 }]] as const) {
  test.describe(label, () => {
    test.use({ viewport: size })

    test('kişi ekle, gruptan alıcı seç, vCard indir', async ({ page, server }) => {
      server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
      await signIn(page, server.url)
      await openContacts(page)
      await addCard(page, 'Ayşe Kaya', 'ayse@example.test')
      await back(page)
      await addCard(page, 'Mehmet Demir', 'mehmet@example.test')
      await back(page)
      await page.getByRole('button', { name: T['contacts.new'], exact: true }).click()
      await page.getByLabel(T['contacts.group.make'], { exact: true }).check()
      await page.getByLabel(T['contacts.group.name'], { exact: true }).fill('Ekip')
      await page.locator('.pim-members').getByLabel('Ayşe Kaya').check()
      await page.locator('.pim-members').getByLabel('Mehmet Demir').check()
      await page.getByRole('button', { name: T['action.save'], exact: true }).click()
      await expect(page.locator('.pim-detail h2')).toHaveText('Ekip')
      await back(page)

      const book = await page.getByLabel(T['contacts.book'], { exact: true }).locator('option', { hasText: T['pim.local.contacts'] }).getAttribute('value')
      await page.getByLabel(T['contacts.book'], { exact: true }).selectOption(book!)
      const download = page.waitForEvent('download')
      await page.getByRole('button', { name: T['contacts.export'], exact: true }).click()
      const file = await (await download).path()
      const vcf = readFileSync(file!, 'utf-8')
      expect(vcf).toContain('FN:Ayşe Kaya')
      expect(vcf).toContain('ayse@example.test')

      await page.goto(server.url)
      await expect(page.locator('.msg-row').first()).toBeVisible()
      const menu = page.locator('.nav-menu-btn').first()
      if (await menu.isVisible()) await menu.click()
      await page.locator('.sf-add').click()
      const to = page.locator('.modal.composer .addr-input input').first()
      await to.fill('Ekip')
      await page.locator('.addr-suggest li', { hasText: 'Ekip' }).click()
      await expect(to).toHaveValue(/ayse@example\.test.*mehmet@example\.test|mehmet@example\.test.*ayse@example\.test/)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  })
}

test.describe('sunucu rehberi', () => {
  test.use({ withDav: true })

  test('kişisel DAV bağlanır, kart eşitlenir, eklenen kart sunucuya gider', async ({ page, server, dav }) => {
    server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
    dav!.seed(`${DAV_BOOK}1.vcf`, 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:s1\r\nFN:Sunucu Kişisi\r\nEMAIL:s@example.test\r\nEND:VCARD\r\n')
    await signIn(page, server.url)
    await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
    await page.locator('.settings-rail').getByText(T['pim.set.title'], { exact: true }).click()
    const list = page.getByTestId('pim-sources')
    await list.getByRole('button', { name: T['action.add'], exact: true }).click()
    await list.getByLabel(T['pim.set.url'], { exact: true }).fill(`${dav!.url}/`)
    await list.getByLabel(T['pim.set.username'], { exact: true }).fill(DAV_USER.username)
    await list.getByLabel(T['pim.set.password'], { exact: true }).fill(DAV_USER.password)
    await list.locator('form').getByRole('button', { name: T['action.add'], exact: true }).click()
    await expect(page.locator('.toast', { hasText: T['pim.connect.connected'] })).toBeVisible()
    await page.keyboard.press('Escape')
    await openContacts(page)
    await expect(page.locator('.contact-row', { hasText: 'Sunucu Kişisi' })).toBeVisible()
    await page.getByLabel(T['contacts.book'], { exact: true }).selectOption({ label: 'Sunucu rehberi' })
    await addCard(page, 'Yeni Kart', 'yeni@example.test')
    expect([...dav!.objects.values()].some((o) => o.data.includes('Yeni Kart'))).toBe(true)
  })
})
