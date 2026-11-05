// Windows Hello kapısının sayfası: Chromium'un CDP sanal doğrulayıcısıyla gerçek navigator.credentials çağrıları.
// Köken main'deki gibi `http://localhost:<port>`; çıktı üretimdeki verifyAssertion'dan geçer.
import { expect, test, type Page } from '@playwright/test'
import { randomBytes } from 'crypto'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { renderHelloPage, type HelloPageConfig } from '../src/main/hello/page'
import { verifyAssertion, type HelloCredential, type PageResult } from '../src/main/helloGate'

test.skip(({ browserName }) => browserName !== 'chromium', 'sanal doğrulayıcı yalnız Chromium CDP ile')

const text = { reason: 'Kasayı aç', note: 'bir kez', failed: 'olmadı', reenroll: 'yeniden', cancel: 'vazgeç' }

async function open(page: Page, cfg: Omit<HelloPageConfig, 'rpName' | 'dir' | 'text'>): Promise<{ origin: string; close(): void }> {
  const html = renderHelloPage({ ...cfg, rpName: 'GeckoMail', dir: 'ltr', text })
  const server = createServer((_q, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const url = `http://localhost:${(server.address() as AddressInfo).port}/yol`
  await page.goto(url)
  return { origin: new URL(url).origin, close: () => void server.close() }
}

const result = (page: Page): Promise<PageResult> => page.evaluate(() => (window as unknown as { __hello: Promise<PageResult> }).__hello)

async function authenticator(page: Page, isUserVerified = true): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified, automaticPresenceSimulation: true }
  })
}

async function enroll(page: Page): Promise<HelloCredential> {
  const s = await open(page, { mode: 'enroll', challenge: randomBytes(32).toString('base64url') })
  const r = await result(page)
  s.close()
  if (r.kind !== 'enrolled') throw new Error(`kayıt olmadı: ${r.kind}`)
  return { credentialId: r.credentialId, publicKeySpki: r.publicKeySpki, alg: r.alg as -7 | -257 }
}

test('kayıt ve doğrulama: gerçek çıktı verifyAssertion geçer', async ({ page }) => {
  await authenticator(page)
  const cred = await enroll(page)
  expect(cred.alg).toBe(-7)

  const challenge = randomBytes(32)
  const s = await open(page, { mode: 'verify', challenge: challenge.toString('base64url'), credentialId: cred.credentialId })
  await expect(page.locator('#reason')).toHaveText(text.reason)
  const r = await result(page)
  s.close()
  if (r.kind !== 'assertion') throw new Error(`doğrulama olmadı: ${r.kind}`)
  const parts = {
    authenticatorData: Buffer.from(r.authenticatorData, 'base64url'),
    clientDataJSON: Buffer.from(r.clientDataJSON, 'base64url'),
    signature: Buffer.from(r.signature, 'base64url')
  }
  expect(verifyAssertion({ cred, challenge, origin: s.origin, rpId: 'localhost', ...parts })).toBe(true)
  expect(verifyAssertion({ cred, challenge: randomBytes(32), origin: s.origin, rpId: 'localhost', ...parts })).toBe(false)
  expect(verifyAssertion({ cred, challenge, origin: 'http://localhost:1', rpId: 'localhost', ...parts })).toBe(false)
})

test('kimlik yoksa sayfa yeniden kayıt sunar, vazgeç iptal döner', async ({ page }) => {
  await authenticator(page)
  await open(page, { mode: 'verify', challenge: randomBytes(32).toString('base64url'), credentialId: randomBytes(32).toString('base64url') })
  await expect(page.locator('#again')).toHaveText(text.reenroll, { timeout: 70_000 })
  await page.locator('#cancel').click()
  expect((await result(page)).kind).toBe('cancel')
})

test('yeniden kayıt düğmesi missing döner', async ({ page }) => {
  await authenticator(page)
  await open(page, { mode: 'verify', challenge: randomBytes(32).toString('base64url'), credentialId: randomBytes(32).toString('base64url') })
  await page.locator('#again').click({ timeout: 70_000 })
  expect((await result(page)).kind).toBe('missing')
})
