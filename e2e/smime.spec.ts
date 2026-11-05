// S/MIME uçtan uca: gerçek sunucu, sahte IMAP/SMTP (e2e/fakeMail.ts), test fikstürü sertifikalar. Kripto yalnız sunucuda çalışır.
import { readFileSync } from 'node:fs'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { ADMIN, expect, test, type GeckoServer } from './fixtures'
import { startFakeMail, type FakeMail } from './fakeMail'
import acct from '../src/shared/i18n/locales/tr/acct'
import compose from '../src/shared/i18n/locales/tr/compose'
import mailT from '../src/shared/i18n/locales/tr/mail'
import set from '../src/shared/i18n/locales/tr/set'
import smime from '../src/shared/i18n/locales/tr/smime'
import { sealWithKey } from '../src/server/keyfile'
import { hashPassword } from '../src/sync/auth/password'
import { wrapEnveloped, wrapSigned } from '../src/sync/smime/build'
import { encryptEnveloped, signDetached } from '../src/sync/smime/cms'

const FX = join(__dirname, '..', 'src', 'sync', 'smime', '__tests__', 'fixtures')
const fx = (n: string): Buffer => readFileSync(join(FX, n))
const der = (n: string): Buffer => Buffer.from(new X509Certificate(fx(`${n}.crt`)).raw)
const P12_PASS = fx('p12-password.txt').toString().trim()
const VAULT = 'kasa-parolasi-e2e'
const ME = 'alice@example.test'
const MEMBER = { username: 'uye', password: 'uye-parola-123' }

const head = (subject: string, from = ME): string =>
  `From: ${from}\r\nTo: ${ME}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@example.test>\r\nMIME-Version: 1.0\r\n`

async function signedMessage(subject: string, cert: string, chain: string[], html?: string): Promise<{ outer: string; signed: Buffer }> {
  const entity = Buffer.from(html ? `Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n` : `Content-Type: text/plain; charset=utf-8\r\n\r\nimzali govde\r\n`)
  const { der: sig, micalg } = await signDetached(entity, { key: createPrivateKey(fx(`${cert}.key`)), cert: der(cert), chain: chain.map(der) })
  return { outer: head(subject), signed: wrapSigned(entity, sig, micalg) }
}

async function seed(server: GeckoServer, mail: FakeMail): Promise<void> {
  const key = readFileSync(join(server.dataDir, 'master.key'))
  server.withDb((db) => {
    db.prepare(
      `INSERT INTO accounts (email, display_name, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, allow_invalid_certs, password_enc, created_at)
       VALUES (?, 'Alice', '127.0.0.1', ?, 'tls', '127.0.0.1', ?, 'tls', 1, ?, ?)`
    ).run(ME, mail.imapPort, mail.smtpPort, Buffer.from(sealWithKey(key, Buffer.from('test-parola'))), Date.now())
    db.prepare(`INSERT INTO smime_trust_anchors (fingerprint, cert_der, label, added_by, created_at) VALUES ('e2e-kok', ?, 'E2E kök', NULL, ?)`).run(der('root'), Date.now())
  })
  // parolalar açılışta çözülür
  await server.stop()
  await server.restartAfterExit()
}

async function rpcCall(page: Page, method: string, params: unknown): Promise<unknown> {
  const r = await page.evaluate(async ([m, p]) => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = rej
    })
    return new Promise<{ ok: boolean; result?: unknown; error?: string }>((res) => {
      ws.addEventListener('message', (e) => {
        const d = JSON.parse(String(e.data)) as { id?: number; ok: boolean; result?: unknown; error?: string }
        if (d.id !== 1) return
        ws.close()
        res(d)
      })
      ws.send(JSON.stringify({ id: 1, method: m, params: p }))
    })
  }, [method, params] as const)
  if (!r.ok) throw new Error(`${method}: ${r.error}`)
  return r.result
}

async function signIn(page: Page, url: string, u = ADMIN): Promise<void> {
  await page.goto(url)
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(u.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(u.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(u.username)
}

async function importAlice(page: Page): Promise<void> {
  await page.getByRole('button', { name: acct['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(set['set.sec.vault'], { exact: true }).click()
  const box = page.getByTestId('smime-identities')
  await box.locator('input[type=file]').setInputFiles(join(FX, 'alice-modern.p12'))
  await box.getByLabel(smime['smime.set.p12Password']).fill(P12_PASS)
  await box.getByRole('button', { name: smime['smime.set.importAction'], exact: true }).click()
  await expect(box.locator('.smime-badge.ok')).toHaveText(smime['smime.sig.verified'])
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('smime-identities')).toBeHidden()
}

const openMail = (page: Page, subject: string) => expect(async () => {
  await page.getByRole('button', { name: /yenile/i }).first().click({ timeout: 1000 }).catch(() => {})
  await page.getByText(subject, { exact: true }).first().click({ timeout: 2000 })
}).toPass({ timeout: 60_000 })

const memberPage = async (browser: Browser, url: string): Promise<Page> => {
  const ctx = await browser.newContext({ locale: 'tr-TR' })
  const p = await ctx.newPage()
  await p.addInitScript(() => localStorage.setItem('gecko-locale', 'tr'))
  await signIn(p, url, MEMBER)
  return p
}

test.describe('S/MIME', () => {
  let mail: FakeMail
  test.beforeEach(async ({ server }) => {
    test.slow() // sunucu yeniden başlar, gönderim ve IMAP eşitlemesi beklenir
    mail = await startFakeMail()
    await seed(server, mail)
  })
  test.afterEach(async () => {
    await mail.close()
  })

  test('.p12 içe aktarılır, kendine şifreli + imzalı gider; kasa kilitlenince içerik gider', async ({ page, server }) => {
    await signIn(page, server.url)
    await rpcCall(page, 'createVault', { password: VAULT })
    await page.reload()
    await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
    await importAlice(page)

    await page.getByRole('button', { name: acct['acct.panel.newMail'] }).click()
    const dialog = page.locator('.composer')
    await dialog.getByLabel(compose['compose.field.to'], { exact: true }).fill(ME)
    await dialog.locator('.subject-row input').fill('E2E gizli konu')
    await dialog.locator('textarea').fill('birinci satır\nikinci satır\n\ngizli-e2e-govde')
    await dialog.getByRole('button', { name: smime['smime.compose.encrypt'], exact: true }).click()
    await expect(dialog.getByRole('button', { name: smime['smime.compose.sign'], exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.locator('.smime-recipient.ok')).toContainText(ME)
    await dialog.getByRole('button', { name: compose['compose.send.button'], exact: true }).click()
    await expect(dialog).toBeHidden()

    await expect.poll(() => mail.sent.length, { timeout: 20_000 }).toBe(1)
    expect(mail.sent[0].raw.toString('latin1')).not.toContain('gizli-e2e-govde')
    expect(mail.sent[0].raw.toString('latin1')).toMatch(/smime-type=enveloped-data/)

    await page.getByRole('tab', { name: mailT['mail.folder.sent'], exact: true }).click()
    await openMail(page, 'E2E gizli konu')
    await expect(page.locator('.smime-badge.ok', { hasText: smime['smime.enc.decrypted'] })).toBeVisible()
    await expect(page.locator('.smime-badge.ok', { hasText: smime['smime.sig.verified'] })).toBeVisible()
    await expect(page.locator('.mail-plain')).toContainText('gizli-e2e-govde')

    await rpcCall(page, 'lockVault', {})
    await expect(page.locator('.smime-badge', { hasText: smime['smime.enc.locked'] })).toBeVisible()
    await expect(page.locator('.mail-plain')).toBeHidden()
    await expect(page.getByText('gizli-e2e-govde')).toBeHidden()
  })

  test('kendinden imzalı iletide yeşil rozet yok; anahtarsız üye içerik görmez', async ({ page, server, browser }) => {
    const self = await signedMessage('E2E kendinden imzali', 'self-signed', [])
    mail.deliver('INBOX', Buffer.concat([Buffer.from(self.outer, 'latin1'), self.signed]))
    const inner = await signedMessage('E2E sifreli', 'alice', ['int'])
    mail.deliver('INBOX', Buffer.concat([Buffer.from(inner.outer, 'latin1'), wrapEnveloped(encryptEnveloped(inner.signed, [{ cert: der('alice'), oaep: false }]))]))
    server.withDb((db) => {
      const uid = Number(db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'member', ?)`).run(MEMBER.username, hashPassword(MEMBER.password), Date.now()).lastInsertRowid)
      const gid = Number(db.prepare(`INSERT INTO groups (name, color, created_at) VALUES ('E2E', '#123456', ?)`).run(Date.now()).lastInsertRowid)
      db.prepare(`UPDATE accounts SET group_id = ? WHERE email = ?`).run(gid, ME)
      db.prepare(`INSERT INTO user_group_permissions (user_id, group_id, can_view, can_manage) VALUES (?, ?, 1, 0)`).run(uid, gid)
    })
    await signIn(page, server.url)
    await rpcCall(page, 'createVault', { password: VAULT })

    await openMail(page, 'E2E kendinden imzali')
    await expect(page.locator('.smime-badge', { hasText: smime['smime.sig.selfSigned'] })).toBeVisible()
    await expect(page.locator('.smime-badge.ok')).toHaveCount(0)

    const member = await memberPage(browser, server.url)
    await openMail(member, 'E2E sifreli')
    await expect(member.locator('.smime-badge', { hasText: smime['smime.enc.noKey'] })).toBeVisible()
    await expect(member.locator('.view-body').getByText('imzali govde')).toBeHidden()
    await member.context().close()
  })

  test('şifreli görünüm açıkken dış istek yok', async ({ page, server }) => {
    let hits = 0
    const pixel = createServer((_q, r) => {
      hits++
      r.end()
    })
    await new Promise<void>((r) => pixel.listen(0, '127.0.0.1', r))
    const port = (pixel.address() as { port: number }).port
    const inner = await signedMessage('E2E uzak resimli', 'alice', ['int'], `<p>html-govde</p><img src="http://127.0.0.1:${port}/iz.png">`)
    mail.deliver('INBOX', Buffer.concat([Buffer.from(inner.outer, 'latin1'), wrapEnveloped(encryptEnveloped(inner.signed, [{ cert: der('alice'), oaep: false }]))]))
    await signIn(page, server.url)
    await rpcCall(page, 'createVault', { password: VAULT })
    await page.reload()
    await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
    await importAlice(page)

    const external: string[] = []
    page.on('request', (r) => {
      if (!r.url().startsWith(server.url) && !r.url().startsWith('data:') && !r.url().startsWith('about:')) external.push(r.url())
    })
    await openMail(page, 'E2E uzak resimli')
    await expect(page.locator('.smime-badge.ok', { hasText: smime['smime.sig.verified'] })).toBeVisible()
    await expect(page.frameLocator('iframe.mail-frame').getByText('html-govde')).toBeVisible()
    await expect(page.locator('iframe.mail-frame')).not.toHaveAttribute('srcdoc', new RegExp(`127\\.0\\.0\\.1:${port}`))
    await expect(page.locator('.remote-bar')).toHaveCount(0)
    expect(external).toEqual([])
    expect(hits).toBe(0)
    await new Promise<void>((r) => pixel.close(() => r()))
  })
})
