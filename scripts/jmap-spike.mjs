#!/usr/bin/env node
// Sunucu ajanı F0 denemesi:
// Stalwart JMAP'in delege-servis-hesabı modelini taşıyıp taşımadığını iki TEST hesabıyla ölçer.
//
//   S1  A hesabı INBOX'ını B ile paylaşınca B'nin JMAP Session'ında A ayrı accountId olarak görünüyor mu?
//   S2  B, A'nın hesabında gönderim (submission) yetkisi/kimliği görüyor mu? (gerçek mail GÖNDERİLMEZ)
//   S3  B'nin EventSource push kanalına A'daki değişiklik için StateChange geliyor mu?
//   +   B, A'nın hesabında Email/query + Email/changes yapabiliyor mu?
//
// Yan etkiler (hepsi sonunda geri alınır): A'nın INBOX'ı B ile paylaşılır, A'nın INBOX'ına küçük bir
// test maili import edilir ve silinir, paylaşım kaldırılır. Gerçek hesaplarda DEĞİL, test hesaplarında çalıştırın.
//
// Kullanım:  node scripts/jmap-spike.mjs            (kullanıcı/şifre sorulur, ekrana yazılmaz)
//            JMAP_URL=https://mail.example.com node scripts/jmap-spike.mjs   (zorunlu)
//
// Şifreler yalnızca bu süreçte, Basic auth başlığında kullanılır; diske/loga yazılmaz.
// 401 alınırsa hemen durur (başarısız login = sunucu auto-ban sayacı).

import { createInterface } from 'node:readline'

if (!process.env.JMAP_URL) {
  console.error('JMAP_URL gerekli, ör. JMAP_URL=https://mail.example.com npm run jmap-spike')
  process.exit(2)
}
const BASE = process.env.JMAP_URL.replace(/\/$/, '')
const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail']
const PUSH_WAIT_MS = 20_000

const results = []
const record = (id, ok, note) => {
  results.push({ id, ok, note })
  console.log(`${ok === true ? '✔' : ok === false ? '✘' : '•'} ${id}: ${note}`)
}

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(question)
      }
    }
    rl.question(question, (a) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(a.trim())
    })
  })
}

class AuthError extends Error {}

function client(user, pass) {
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
  let session = null
  const req = async (url, init = {}) => {
    const res = await fetch(url, { ...init, headers: { authorization: auth, ...init.headers } })
    if (res.status === 401) throw new AuthError(`${user}: kimlik doğrulama reddedildi — betik durduruldu`)
    return res
  }
  return {
    user,
    async session(refresh = false) {
      if (session && !refresh) return session
      const res = await req(`${BASE}/jmap/session`)
      if (!res.ok) throw new Error(`session ${res.status}`)
      session = await res.json()
      return session
    },
    async call(methodCalls, using = USING) {
      const s = await this.session()
      const res = await req(s.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ using, methodCalls })
      })
      if (!res.ok) throw new Error(`api ${res.status}: ${await res.text()}`)
      return (await res.json()).methodResponses
    },
    async upload(accountId, body, type) {
      const s = await this.session()
      const res = await req(s.uploadUrl.replace('{accountId}', accountId), {
        method: 'POST',
        headers: { 'content-type': type },
        body
      })
      if (!res.ok) throw new Error(`upload ${res.status}`)
      return res.json()
    },
    // EventSource: fetch akışını elle ayrıştır; onEvent true dönerse kapat
    async listen(onEvent, timeoutMs) {
      const s = await this.session()
      const url = s.eventSourceUrl.replace('{types}', '*').replace('{closeafter}', 'no').replace('{ping}', '10')
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const res = await req(url, { headers: { accept: 'text/event-stream' }, signal: ac.signal })
        if (!res.ok) throw new Error(`eventsource ${res.status}`)
        const decoder = new TextDecoder()
        let buf = ''
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true })
          let i
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const ev = /^event:\s*(.*)$/m.exec(block)?.[1] ?? 'message'
            const data = /^data:\s*(.*)$/m.exec(block)?.[1]
            if (data && onEvent(ev, JSON.parse(data))) {
              ac.abort()
              return true
            }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') throw e
      } finally {
        clearTimeout(timer)
      }
      return false
    }
  }
}

const mailAccountId = (s) => s.primaryAccounts['urn:ietf:params:jmap:mail']

async function main() {
  console.log(`JMAP spike — ${BASE}\nİki TEST hesabı gerekli: A (paylaşan) ve B (servis hesabı rolünde).\n`)
  const aUser = await ask('A kullanıcı (e-posta): ')
  const aPass = await ask('A şifre: ', true)
  const bUser = await ask('B kullanıcı (e-posta): ')
  const bPass = await ask('B şifre: ', true)
  const A = client(aUser, aPass)
  const B = client(bUser, bPass)

  const sA = await A.session()
  const sB = await B.session()
  const aId = mailAccountId(sA)
  const bId = mailAccountId(sB)
  record('oturum', true, `A accountId=${aId}, B accountId=${bId}; maxCallsInRequest=${sA.capabilities['urn:ietf:params:jmap:core']?.maxCallsInRequest}`)

  // B'nin principal id'si (RFC 9670 principals:owner); yoksa accountId ile dene
  const owner = sB.accounts[bId]?.accountCapabilities?.['urn:ietf:params:jmap:principals:owner']
  const bPrincipal = owner?.principalId ?? bId
  record('principal', owner ? true : null, owner ? `B principalId=${bPrincipal}` : `principals:owner yok — accountId (${bId}) principal olarak denenecek`)

  // A: INBOX'ı bul
  const [[, mbA]] = await A.call([['Mailbox/get', { accountId: aId, properties: ['id', 'name', 'role', 'shareWith'] }, 'm']])
  const inbox = mbA.list.find((m) => m.role === 'inbox')
  if (!inbox) throw new Error('A hesabında INBOX bulunamadı')

  let shared = false
  let importedId = null
  try {
    // S1: paylaş
    const rights = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: false, mayRename: false, mayDelete: false, maySubmit: true }
    const [[name, setRes]] = await A.call(
      [['Mailbox/set', { accountId: aId, update: { [inbox.id]: { [`shareWith/${bPrincipal}`]: rights } } }, 's']],
      [...USING, 'urn:ietf:params:jmap:principals']
    )
    shared = name === 'Mailbox/set' && !!setRes.updated && inbox.id in setRes.updated
    if (!shared) {
      record('S1 paylaşım', false, `Mailbox/set reddedildi: ${JSON.stringify(setRes.notUpdated ?? setRes)}`)
      return
    }
    const sB2 = await B.session(true)
    const seen = sB2.accounts[aId]
    record('S1 paylaşılan hesap Session\'da', !!seen, seen ? `B, A'yı görüyor: name=${seen.name}, isPersonal=${seen.isPersonal}, yetenekler=${Object.keys(seen.accountCapabilities).join(', ')}` : `B'nin hesap listesi: ${Object.keys(sB2.accounts).join(', ')}`)
    if (!seen) return

    // okuma: query + changes
    const [[, q], [, st]] = await B.call([
      ['Email/query', { accountId: aId, filter: { inMailbox: inbox.id }, limit: 3 }, 'q'],
      ['Email/get', { accountId: aId, ids: [], properties: ['id'] }, 'g']
    ])
    record('okuma', Array.isArray(q.ids), `Email/query ${q.ids?.length ?? 0} id, state=${st.state}`)

    // S2: gönderim yetkisi (gerçek gönderim yok)
    const hasSubmission = !!seen.accountCapabilities['urn:ietf:params:jmap:submission']
    let idNote = ''
    if (hasSubmission) {
      const [[, ids]] = await B.call([['Identity/get', { accountId: aId }, 'i']], [...USING, 'urn:ietf:params:jmap:submission'])
      idNote = ` · Identity/get: ${ids.list?.map((x) => x.email).join(', ') || JSON.stringify(ids)}`
    }
    record('S2 send-as', hasSubmission, `A hesabında submission yeteneği ${hasSubmission ? 'var' : 'YOK'}${idNote}`)

    // S3: push — B dinlerken A'ya test maili import et
    const listening = B.listen((ev, data) => ev === 'state' && data?.changed?.[aId] !== undefined, PUSH_WAIT_MS)
    await new Promise((r) => setTimeout(r, 1500)) // bağlantı kurulsun
    const raw = `From: ${aUser}\r\nTo: ${aUser}\r\nSubject: GeckoMail JMAP spike (silinecek)\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <spike-${Date.now()}@geckomail>\r\n\r\nTest.\r\n`
    const blob = await A.upload(aId, raw, 'message/rfc822')
    const [[, imp]] = await A.call([['Email/import', { accountId: aId, emails: { t: { blobId: blob.blobId, mailboxIds: { [inbox.id]: true }, keywords: { $seen: true } } } }, 'imp']])
    importedId = imp.created?.t?.id ?? null
    const pushed = await listening
    record('S3 push', pushed, pushed ? `A'daki değişiklik B'nin EventSource kanalına ${PUSH_WAIT_MS / 1000} sn içinde geldi` : `${PUSH_WAIT_MS / 1000} sn içinde StateChange gelmedi`)
  } finally {
    // temizlik
    if (importedId) await A.call([['Email/set', { accountId: aId, destroy: [importedId] }, 'd']]).catch(() => {})
    if (shared) {
      await A.call([['Mailbox/set', { accountId: aId, update: { [inbox.id]: { [`shareWith/${bPrincipal}`]: null } } }, 'u']], [...USING, 'urn:ietf:params:jmap:principals']).catch(() => {})
      console.log('• temizlik: test maili silindi, paylaşım kaldırıldı')
    }
  }
}

main()
  .catch((e) => {
    console.error(`✘ ${e instanceof AuthError ? e.message : `hata: ${e.message}`}`)
    process.exitCode = 1
  })
  .finally(() => {
    const decisive = results.filter((r) => /^S[123]/.test(r.id))
    if (decisive.length === 3) {
      const allOk = decisive.every((r) => r.ok)
      console.log(`\nSonuç: ${allOk ? 'A PLANI UYGUN (Stalwart JMAP + delege hesap)' : 'A planı eksik — başarısız maddeleri spec §7 ile değerlendirin (B planı: kendi ajanımız)'}`)
    }
  })
