#!/usr/bin/env node
// Demo sunucusuna sahte veri: demo kullanıcısı, GreenMail'de bir hesap, sahte postalar. Adresler RFC 2606 alanında, dış posta çıkışı yok.
// Parola her çalıştırmada rastgele üretilir, yalnız bu çıktıda görünür, depoya ve günlüğe girmez.
// Sunucu kapsayıcısında çalışır: docker compose exec -T geckomail node /seed/demo-seed.mjs
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import net from 'node:net'

const { WebSocket } = createRequire('/app/')('ws')
const USER = 'demo'
const MAIL_HOST = process.env.DEMO_MAIL_HOST ?? 'mail.example.test'
const ADDRESS = 'demo@example.test'
const ORIGIN = process.env.GECKO_PUBLIC_ORIGIN
const BASE = 'http://127.0.0.1:8080'
const password = randomBytes(18).toString('base64url')
// GreenMail her adrese parola sorar ama kullanıcıyı önceden açar: compose GREENMAIL_OPTS ile aynı
const MAILBOX_PASSWORD = process.env.DEMO_MAILBOX_PASSWORD ?? 'demo-yerel'

const SENDERS = [['Ayşe Yılmaz', 'ayse@example.test'], ['Mehmet Kaya', 'mehmet@example.test'], ['Elif Demir', 'elif@example.test'], ['Fatura Servisi', 'fatura@example.test']]
const SUBJECTS = [
  ['Haftalık toplantı notları', 'Notları ekledim, cuma gününe kadar yorumlarınızı bekliyorum.'],
  ['Teklif taslağı', 'Teklifin son halini inceleyebilir misiniz?'],
  ['Ekim ayı faturası', 'Faturanız hazır. Son ödeme tarihi ayın yirmisi.'],
  ['Yeni ofis adresi', 'Taşınma tarihi kesinleşti, ayrıntılar aşağıda.'],
  ['Kod incelemesi', 'Değişiklikleri gözden geçirdim, iki küçük öneri var.'],
  ['Öğle yemeği', 'Yarın öğlen uygun musunuz?'],
  ['Proje takvimi', 'Teslim tarihini bir hafta öteye aldık.'],
  ['Hoş geldiniz', 'GeckoMail demo hesabına hoş geldiniz.']
]

function smtpSend(from, name, subject, body, when) {
  return new Promise((ok, no) => {
    const lines = [`EHLO demo.example.test`, `MAIL FROM:<${from}>`, `RCPT TO:<${ADDRESS}>`, 'DATA']
    const encoded = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`
    const fromName = `=?UTF-8?B?${Buffer.from(name).toString('base64')}?=`
    const message = [`From: ${fromName} <${from}>`, `To: Demo <${ADDRESS}>`, `Subject: ${encoded}`, `Date: ${when.toUTCString()}`,
      `Message-ID: <${randomBytes(8).toString('hex')}@example.test>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, '.', ''].join('\r\n')
    const s = net.connect(3025, MAIL_HOST)
    let step = -1
    let reply = ''
    s.setEncoding('utf8')
    s.on('error', no)
    s.on('data', (d) => {
      reply += d
      // çok satırlı yanıtın son satırı "250 " ile biter
      if (!/(^|\r\n)\d{3} [^\r\n]*\r\n$/.test(reply)) return
      const code = reply.slice(reply.lastIndexOf('\r\n', reply.length - 3) + 1).trim().slice(0, 1)
      reply = ''
      if (code === '4' || code === '5') return no(new Error('smtp reddetti'))
      step++
      if (step < lines.length) s.write(`${lines[step]}\r\n`)
      else if (step === lines.length) s.write(message)
      else {
        s.end('QUIT\r\n')
        ok()
      }
    })
  })
}

async function session() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ username: USER, password })
  })
  if (!r.ok) throw new Error(`giriş ${r.status}`)
  const cookie = r.headers.get('set-cookie').split(';')[0]
  const ws = new WebSocket('ws://127.0.0.1:8080/rpc', { headers: { Cookie: cookie, Origin: ORIGIN } })
  await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no) })
  let id = 0
  return {
    call: (method, params) => new Promise((ok, no) => {
      const mine = ++id
      const on = (raw) => {
        const m = JSON.parse(raw.toString())
        if (m.id !== mine) return
        ws.off('message', on)
        if (m.error) no(new Error(`${method}: ${JSON.stringify(m.error)}`))
        else ok(m.result)
      }
      ws.on('message', on)
      ws.send(JSON.stringify({ id: mine, method, params }))
    }),
    close: () => ws.close()
  }
}

const created = spawnSync(process.execPath, ['/app/server/index.mjs', 'create-admin', USER], { input: `${password}\n`, encoding: 'utf8' })
if (created.status !== 0) throw new Error('demo kullanıcısı açılamadı: yığını down -v ile sıfırlayın')

for (const [i, [subject, body]] of SUBJECTS.entries()) {
  const [name, from] = SENDERS[i % SENDERS.length]
  await smtpSend(from, name, subject, body, new Date(Date.now() - i * 3600_000))
}

const rpc = await session()
const csv = `email,password,imap_host,imap_port,smtp_host,smtp_port\n${ADDRESS},${MAILBOX_PASSWORD},${MAIL_HOST},3993,${MAIL_HOST},3465\n`
const added = await rpc.call('importAccounts', { kind: 'csv', content: csv })
if (added.added !== 1) throw new Error(`hesap eklenmedi: ${JSON.stringify(added)}`)
const [account] = await rpc.call('getAccounts')
// GreenMail kendinden imzalı: yalnız bu iç ağda
await rpc.call('updateAccount', { accountId: account.id, patch: { imapTls: 'tls', smtpTls: 'tls', allowInvalidCerts: true } })
rpc.close()

console.log(`demo hazır: kullanıcı ${USER}, parola ${password}`)
