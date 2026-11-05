import { describe, expect, it } from 'vitest'
import type { ContactDraft } from '../../shared/pim'
import { detectCardVersion, draftToCard, parseCard, splitVcf } from '../pim/vcard'

const card = (...lines: string[]): string => ['BEGIN:VCARD', ...lines, 'END:VCARD', ''].join('\r\n')
const NOW = Date.parse('2026-02-01T12:00:00Z')
const draft = (over: Partial<ContactDraft> = {}): ContactDraft => ({
  kind: 'individual', fullName: 'Ayşe Yılmaz', given: 'Ayşe', family: 'Yılmaz', org: 'Gecko', emails: [{ addr: 'ayse@t.co', label: 'work' }],
  phones: [{ value: '+90 555', label: 'cell' }], addresses: [{ value: 'Cadde 1, İstanbul', label: 'home' }], note: 'Not; virgül, satır\nsonu', birthday: '1990-01-02', ...over
})

describe('parseCard', () => {
  it('3.0 and 4.0 parse', () => {
    for (const version of ['3.0', '4.0']) {
      const c = parseCard(card(`VERSION:${version}`, 'UID:u1', 'FN:Ali Veli', 'N:Veli;Ali;;;', 'ORG:Gecko;Satış', 'EMAIL;TYPE=WORK:ali@t.co', 'EMAIL:a2@t.co', 'TEL;TYPE=CELL:+90 555', 'ADR;TYPE=HOME:;;Cadde 1;İstanbul;;34;TR', 'NOTE:Bir\\, iki\\nüç', 'BDAY:1990-01-02'))!
      expect(c).toMatchObject({ uid: 'u1', kind: 'individual', fullName: 'Ali Veli', org: 'Gecko, Satış', emails: [{ addr: 'ali@t.co', label: 'work' }, { addr: 'a2@t.co', label: null }], memberUids: [] })
      expect(c.detail).toMatchObject({
        given: 'Ali', family: 'Veli', phones: [{ value: '+90 555', label: 'cell' }], addresses: [{ value: 'Cadde 1, İstanbul, 34, TR', label: 'home' }], note: 'Bir, iki\nüç', birthday: '1990-01-02', photoDataUrl: null
      })
    }
  })
  it('kaçışlı noktalı virgül ve 3.0 NOTE virgülü', () => {
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'FN:A\\;B', 'NOTE:bir,iki'))).toMatchObject({ fullName: 'A;B', detail: { note: 'bir,iki' } })
  })
  it('INTERNET ve PREF etiket sayılmaz', () => {
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'FN:A', 'EMAIL;TYPE=INTERNET,PREF:a@t.co'))!.emails).toEqual([{ addr: 'a@t.co', label: null }])
  })
  it('Apple etiketi', () => {
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'FN:A', 'item1.EMAIL;type=INTERNET:a@t.co', 'item1.X-ABLabel:_$!<Other>!$_', 'item2.EMAIL:b@t.co', 'item2.X-ABLabel:Kulüp'))!.emails).toEqual([
      { addr: 'a@t.co', label: 'Other' }, { addr: 'b@t.co', label: 'Kulüp' }
    ])
  })
  it('Apple group member', () => {
    const c = parseCard(card('VERSION:3.0', 'UID:g1', 'FN:Ekip', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:aa', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:bb'))!
    expect(c).toMatchObject({ kind: 'group', memberUids: ['aa', 'bb'] })
  })
  it('KIND:group', () => {
    const c = parseCard(card('VERSION:4.0', 'UID:g2', 'FN:Ekip', 'KIND:group', 'MEMBER:urn:uuid:cc', 'MEMBER:mailto:x@t.co'))!
    expect(c).toMatchObject({ kind: 'group', memberUids: ['cc', 'mailto:x@t.co'] })
  })
  it('folded line', () => {
    expect(parseCard(['BEGIN:VCARD', 'VERSION:3.0', 'UID:1', 'FN:Çok uzun bir', '  isim', 'EMAIL:a', ' @t.co', 'END:VCARD', ''].join('\r\n'))).toMatchObject({ fullName: 'Çok uzun bir isim', emails: [{ addr: 'a@t.co' }] })
  })
  it('non-utf8 quoted printable name', () => {
    expect(parseCard(card('VERSION:2.1', 'UID:1', 'FN;CHARSET=ISO-8859-9;ENCODING=QUOTED-PRINTABLE:Do=F0a', 'N;CHARSET=ISO-8859-9;ENCODING=QUOTED-PRINTABLE:G=FCne=FE;Do=F0a;;;'))).toMatchObject({
      fullName: 'Doğa', detail: { family: 'Güneş', given: 'Doğa' }
    })
    expect(parseCard(card('VERSION:2.1', 'UID:1', 'FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:D=C3=B6=', 'nd=C3=BC'))!.fullName).toBe('Döndü')
  })
  it('2.1 çıplak parametreler', () => {
    expect(parseCard(card('VERSION:2.1', 'UID:1', 'FN;QUOTED-PRINTABLE:A=20B', 'TEL;CELL:123', 'EMAIL;INTERNET:a@t.co'))).toMatchObject({ fullName: 'A B', emails: [{ addr: 'a@t.co' }], detail: { phones: [{ value: '123', label: 'cell' }] } })
  })
  it('gömülü fotoğraf data URL olur', () => {
    const png = Buffer.from('png-veri').toString('base64')
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'FN:A', `PHOTO;ENCODING=b;TYPE=PNG:${png}`))!.detail.photoDataUrl).toBe(`data:image/png;base64,${png}`)
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'FN:A', `PHOTO;ENCODING=BASE64;TYPE=JPEG:${png}`))!.detail.photoDataUrl).toBe(`data:image/jpeg;base64,${png}`)
    expect(parseCard(card('VERSION:4.0', 'UID:1', 'FN:A', `PHOTO:data:image/png;base64,${png}`))!.detail.photoDataUrl).toBe(`data:image/png;base64,${png}`)
  })
  it('oversize photo dropped', () => {
    const big = Buffer.alloc(257 * 1024).toString('base64')
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'FN:A', `PHOTO;ENCODING=b;TYPE=PNG:${big}`))!.detail.photoDataUrl).toBeNull()
  })
  it('remote PHOTO uri dropped', () => {
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'FN:A', 'PHOTO;VALUE=uri:https://iz.example/p.png'))!.detail.photoDataUrl).toBeNull()
    expect(parseCard(card('VERSION:4.0', 'UID:1', 'FN:A', 'PHOTO:https://iz.example/p.png'))!.detail.photoDataUrl).toBeNull()
    expect(parseCard(card('VERSION:4.0', 'UID:1', 'FN:A', 'PHOTO:data:image/svg+xml;base64,PHN2Zz4='))!.detail.photoDataUrl).toBeNull()
  })
  it('no FN falls back to email', () => {
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'EMAIL:a@t.co'))!.fullName).toBe('a@t.co')
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'N:Veli;Ali;;;', 'EMAIL:a@t.co'))!.fullName).toBe('Ali Veli')
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'ORG:Gecko'))!.fullName).toBe('Gecko')
  })
  it('UID yoksa kararlı kimlik', () => {
    const raw = card('VERSION:3.0', 'FN:A')
    expect(parseCard(raw)!.uid).toMatch(/.+/)
    expect(parseCard(raw)!.uid).toBe(parseCard(raw)!.uid)
  })
  it('bozuk ya da 1 MB üstü kart null', () => {
    expect(parseCard('çöp')).toBeNull()
    expect(parseCard('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toBeNull()
    expect(parseCard(card('VERSION:3.0', 'UID:1', 'FN:A', `NOTE:${'x'.repeat(1_000_001)}`))).toBeNull()
  })
})

describe('splitVcf', () => {
  it('splitVcf 3 kart', () => {
    const raw = card('VERSION:3.0', 'FN:A') + card('VERSION:3.0', 'FN:B') + 'çöp\r\n' + card('VERSION:4.0', 'FN:C').toLowerCase().replace('fn:c', 'FN:C')
    const parts = splitVcf(raw)
    expect(parts).toHaveLength(3)
    expect(parts.map((p) => parseCard(p)?.fullName)).toEqual(['A', 'B', 'C'])
  })
  it('kart yoksa boş', () => expect(splitVcf('çöp')).toEqual([]))
})

describe('detectCardVersion', () => {
  it('sürümü bulur, yoksa 3.0', () => {
    expect(detectCardVersion(card('VERSION:4.0', 'FN:A'))).toBe('4.0')
    expect(detectCardVersion(card('VERSION:3.0', 'FN:A'))).toBe('3.0')
    expect(detectCardVersion(null)).toBe('3.0')
  })
})

describe('draftToCard', () => {
  for (const version of ['3.0', '4.0'] as const) {
    it(`gidiş dönüş ${version}`, () => {
      const raw = draftToCard(draft(), { uid: 'u1', version, now: NOW })
      expect(raw).toContain(`VERSION:${version}`)
      expect(raw).toMatch(/\r\n$/)
      expect(parseCard(raw)).toMatchObject({
        uid: 'u1', kind: 'individual', fullName: 'Ayşe Yılmaz', org: 'Gecko', emails: [{ addr: 'ayse@t.co', label: 'work' }],
        detail: { given: 'Ayşe', family: 'Yılmaz', phones: [{ value: '+90 555', label: 'cell' }], note: 'Not; virgül, satır\nsonu', birthday: '1990-01-02' }
      })
      expect(parseCard(raw)!.detail.addresses[0].value).toBe('Cadde 1, İstanbul')
    })
    it(`grup ${version}`, () => {
      const raw = draftToCard(draft({ kind: 'group', fullName: 'Ekip', emails: [] }), { uid: 'g', version, memberUids: ['aa', 'bb'], now: NOW })
      expect(parseCard(raw)).toMatchObject({ kind: 'group', fullName: 'Ekip', memberUids: ['aa', 'bb'] })
    })
  }
  it('noktalı virgül alan sınırını bozmaz', () => {
    const raw = draftToCard(draft({ family: 'A;B', given: 'C' }), { version: '3.0', now: NOW })
    expect(raw).toContain('N:A\\;B;C;;;')
    expect(parseCard(raw)!.detail).toMatchObject({ family: 'A;B', given: 'C' })
  })
  it('uid yoksa üretir', () => expect(parseCard(draftToCard(draft(), { version: '4.0', now: NOW }))!.uid).toMatch(/.{8,}/))
  it('75 bayt üstü satır katlanır', () => {
    const raw = draftToCard(draft({ note: 'ğ'.repeat(200) }), { version: '3.0', now: NOW })
    expect(raw.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true)
    expect(parseCard(raw)!.detail.note).toBe('ğ'.repeat(200))
  })
  it('draftToCard keeps version and unknown props', () => {
    const png = 'aGk='
    const base = card('VERSION:4.0', 'UID:u9', 'FN:Eski', 'EMAIL:eski@t.co', 'X-FOO;BAR=1:değer', `PHOTO:data:image/png;base64,${png}`, 'CATEGORIES:a,b')
    const raw = draftToCard(draft(), { base, version: '3.0', now: NOW })
    expect(raw).toContain('VERSION:4.0')
    expect(raw).not.toContain('VERSION:3.0')
    expect(raw).toContain('X-FOO;BAR=1:değer')
    expect(raw).toContain(`PHOTO:data:image/png;base64,${png}`)
    expect(raw).toContain('CATEGORIES:a,b')
    expect(raw).not.toContain('eski@t.co')
    const c = parseCard(raw)!
    expect(c).toMatchObject({ uid: 'u9', fullName: 'Ayşe Yılmaz', emails: [{ addr: 'ayse@t.co', label: 'work' }] })
    expect(c.detail.photoDataUrl).toBe(`data:image/png;base64,${png}`)
  })
  it('Apple etiketi yetim kalmaz', () => {
    const base = card('VERSION:3.0', 'UID:u9', 'FN:Eski', 'item1.EMAIL:eski@t.co', 'item1.X-ABLabel:Kulüp', 'item2.URL:https://x.co', 'item2.X-ABLabel:Site')
    const raw = draftToCard(draft(), { base, version: '3.0', now: NOW })
    expect(raw).not.toContain('Kulüp')
    expect(raw).toContain('item2.URL:https://x.co')
    expect(raw).toContain('item2.X-ABLabel:Site')
  })
  it('katlanmış taban kart bozulmaz', () => {
    const base = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:u9', 'FN:Eski', 'X-UZUN:bir', ' iki', 'END:VCARD', ''].join('\r\n')
    expect(draftToCard(draft(), { base, version: '3.0', now: NOW })).toContain('X-UZUN:biriki')
  })
})

describe('gözden geçirme düzeltmeleri', () => {
  it('uzun QP satırı ve yumuşak satır sonları doğrusal', () => {
    const started = Date.now()
    parseCard(`BEGIN:VCARD\r\nVERSION:2.1\r\nFN;${'X;'.repeat(200_000)}\r\nEND:VCARD\r\n`)
    const soft = Array.from({ length: 50_000 }, () => 'a=').join('\r\n')
    expect(parseCard(`BEGIN:VCARD\r\nVERSION:2.1\r\nFN;ENCODING=QUOTED-PRINTABLE:${soft}\r\nb\r\nEND:VCARD\r\n`)?.fullName).toMatch(/^a+b$/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('END olmadan yinelenen BEGIN doğrusal, son kart kurtulur', () => {
    const started = Date.now()
    const out = splitVcf(`${'BEGIN:VCARD\r\n'.repeat(200_000)}FN:A\r\nEND:VCARD\r\n`)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('FN:A')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('yılsız doğum günü okunur ve korunur', () => {
    const v4 = parseCard(card('VERSION:4.0', 'UID:u', 'FN:A', 'BDAY:--0102'))!
    expect(v4.detail.birthday).toBe('--01-02')
    const raw = draftToCard(draft({ birthday: '--01-02' }), { version: '4.0', now: NOW })
    expect(raw).toContain('BDAY:--0102')
    expect(parseCard(raw)!.detail.birthday).toBe('--01-02')
    const v3 = draftToCard(draft({ birthday: '--01-02' }), { version: '3.0', now: NOW })
    expect(v3).toContain('BDAY:--01-02')
    expect(parseCard(v3)!.detail.birthday).toBe('--01-02')
  })

  it('yalnız \\r satır enjekte edemez', () => {
    const raw = draftToCard(draft({ note: 'a\rTEL:+1\rb', fullName: 'x\rEMAIL:k@t.co' }), { version: '3.0', now: NOW })
    expect(raw.split(/\r\n/).some((l) => /\r/.test(l))).toBe(false)
    expect(parseCard(raw)!.emails.map((e) => e.addr)).toEqual(['ayse@t.co'])
  })
})
