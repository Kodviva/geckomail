import { describe, expect, it } from 'vitest'
import { canonicalizeCrlf, classifyRaw, classifyStructure, fromHeaders, pkcs7Der, splitMultipartSigned } from '../mime'
import { SmimeFormatError } from '../errors'

const msg = (...lines: string[]): Buffer => Buffer.from(lines.join('\r\n'))
const P7 = Buffer.from('3082', 'hex')

const signed = (parts: string[], ct = 'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="b1"'): Buffer =>
  msg(`Content-Type: ${ct}`, '', 'önsöz', ...parts.flatMap((p) => ['--b1', p]), '--b1--', 'sonsöz', '')

describe('classifyRaw', () => {
  it('büyük/küçük harf ve parametre sırası', () => {
    expect(classifyRaw(msg('content-TYPE: Multipart/Signed; micalg=sha-256; boundary=x; PROTOCOL="Application/PKCS7-Signature"', '', ''))).toBe('multipart_signed')
    expect(classifyRaw(msg('Content-Type: APPLICATION/PKCS7-MIME; name=smime.p7m; SMIME-Type=Enveloped-Data', '', ''))).toBe('enveloped')
    expect(classifyRaw(msg('Content-Type: application/pkcs7-mime;', '\tsmime-type="signed-data";', ' name=a', '', ''))).toBe('opaque_signed')
    expect(classifyRaw(msg('Content-Type: application/pkcs7-mime; smime-type=authEnveloped-data', '', ''))).toBe('auth_enveloped')
    expect(classifyRaw(msg('Content-Type: application/pkcs7-mime; smime-type=compressed-data', '', ''))).toBe('compressed')
  })

  it('x-pkcs7-mime kabul', () => {
    expect(classifyRaw(msg('Content-Type: application/x-pkcs7-mime; smime-type=enveloped-data', '', ''))).toBe('enveloped')
    expect(classifyRaw(msg('Content-Type: multipart/signed; protocol="application/x-pkcs7-signature"; boundary=x', '', ''))).toBe('multipart_signed')
  })

  it('smime-type yoksa içerik türü DER gövdesinden okunur', () => {
    const der = Buffer.from('3080060b2a864886f70d010703', 'hex') // enveloped OID'si 9 baytlık: sahte önek
    const env = Buffer.from('308006092a864886f70d010703a080', 'hex')
    const sig = Buffer.from('308006092a864886f70d010702a080', 'hex')
    const head = 'Content-Type: application/pkcs7-mime; name=smime.p7m\r\nContent-Transfer-Encoding: base64\r\n\r\n'
    expect(classifyRaw(Buffer.from(head + env.toString('base64')))).toBe('enveloped')
    expect(classifyRaw(Buffer.from(head + sig.toString('base64')))).toBe('opaque_signed')
    expect(classifyRaw(Buffer.from(head + der.toString('base64')))).toBe('ambiguous')
  })

  it('two content-type headers → ambiguous', () => {
    expect(classifyRaw(msg('Content-Type: text/html', 'Content-Type: application/pkcs7-mime; smime-type=enveloped-data', '', ''))).toBe('ambiguous')
  })

  it('birden çok sınır parametresi → ambiguous', () => {
    expect(classifyRaw(msg('Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=a; boundary=b', '', ''))).toBe('ambiguous')
  })

  it('nested multipart/signed under mixed → none', () => {
    const inner = 'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; boundary=i\r\n\r\n--i\r\n\r\nx\r\n--i\r\n\r\ny\r\n--i--'
    expect(classifyRaw(msg('Content-Type: multipart/mixed; boundary=b', '', '--b', inner, '--b--', ''))).toBe('none')
  })

  it('gömülü .p7m ve PGP imzası S/MIME sayılmaz', () => {
    expect(classifyRaw(msg('Content-Type: application/octet-stream; name=smime.p7m', '', ''))).toBe('none')
    expect(classifyRaw(msg('Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary=x', '', ''))).toBe('none')
    expect(classifyRaw(msg('Subject: başlıksız', '', 'gövde'))).toBe('none')
    expect(classifyRaw(Buffer.alloc(0))).toBe('none')
  })
})

describe('classifyStructure', () => {
  it('yalnız kök', () => {
    expect(classifyStructure({ type: 'multipart/signed', parameters: { protocol: 'application/pkcs7-signature' } })).toBe('signed')
    expect(classifyStructure({ type: 'application/pkcs7-mime', parameters: { 'smime-type': 'signed-data' } })).toBe('signed')
    expect(classifyStructure({ type: 'application/x-pkcs7-mime', parameters: { 'smime-type': 'Enveloped-Data' } })).toBe('encrypted')
    expect(classifyStructure({ type: 'application/pkcs7-mime', parameters: { 'smime-type': 'authEnveloped-data' } })).toBe('encrypted')
    expect(classifyStructure({ type: 'application/pkcs7-mime', parameters: { name: 'smime.p7m' } })).toBe('encrypted')
    expect(classifyStructure({ type: 'application/pkcs7-mime', parameters: { 'smime-type': 'compressed-data' } })).toBeNull()
    expect(classifyStructure({ type: 'multipart/mixed', childNodes: [{ type: 'application/pkcs7-mime' }] })).toBeNull()
    expect(classifyStructure({ type: 'multipart/signed', parameters: { protocol: 'application/pgp-signature' } })).toBeNull()
    expect(classifyStructure(null)).toBeNull()
    expect(classifyStructure('x')).toBeNull()
  })
})

describe('splitMultipartSigned', () => {
  const sigPart = 'Content-Type: application/pkcs7-signature\r\nContent-Transfer-Encoding: base64\r\n\r\nMII='

  it('imzalı parça ham kopya: signed bytes keep exact CRLF and trailing spaces', () => {
    const body = 'Content-Type: text/plain\r\n\r\nsatır  \r\n\r\niki\t \r\n'
    const r = splitMultipartSigned(signed([body, sigPart]))
    expect(r?.signed.toString()).toBe(body)
    expect(r?.signature.toString()).toBe(sigPart)
  })

  it('three parts → null', () => {
    expect(splitMultipartSigned(signed(['a', 'b', 'c']))).toBeNull()
  })

  it('tek parça veya kapanışsız → null', () => {
    expect(splitMultipartSigned(signed(['a']))).toBeNull()
    expect(splitMultipartSigned(msg('Content-Type: multipart/signed; boundary=b1', '', '--b1', 'a', '--b1', 'b', ''))).toBeNull()
  })

  it('sınırla başlayan satır sınır değildir, sınır sonu boşluk taşıyabilir', () => {
    const r = splitMultipartSigned(msg('Content-Type: multipart/signed; boundary=b1', '', '--b1  ', '--b12 metin', '--b1', sigPart, '--b1--'))
    expect(r?.signed.toString()).toBe('--b12 metin')
  })

  it('yalnız LF ile gelen ileti', () => {
    const raw = Buffer.from('Content-Type: multipart/signed; boundary=b1\n\n--b1\nabc\n--b1\ndef\n--b1--\n')
    expect(splitMultipartSigned(raw)?.signed.toString()).toBe('abc')
  })

  it('sınırsız başlık → null', () => {
    expect(splitMultipartSigned(msg('Content-Type: multipart/signed', '', 'x'))).toBeNull()
  })
})

describe('pkcs7Der', () => {
  it('base64 ve ikili CTE', () => {
    const b64 = `Content-Type: application/pkcs7-signature\r\nContent-Transfer-Encoding: BASE64\r\n\r\n${P7.toString('base64')}\r\n`
    expect(pkcs7Der(Buffer.from(b64))).toEqual(P7)
    const bin = Buffer.concat([Buffer.from('Content-Type: application/pkcs7-mime\r\nContent-Transfer-Encoding: binary\r\n\r\n'), P7])
    expect(pkcs7Der(bin)).toEqual(P7)
  })
  it('desteklenmeyen CTE reddedilir', () => {
    expect(() => pkcs7Der(Buffer.from('Content-Transfer-Encoding: quoted-printable\r\n\r\n=30'))).toThrow(SmimeFormatError)
  })
})

describe('fromHeaders', () => {
  it('from with two addresses → single null', () => {
    expect(fromHeaders(msg('From: a@x.test, b@x.test', '', '')).single).toBeNull()
  })
  it('tek adres, görünen ad yok sayılır, Sender etkisiz', () => {
    expect(fromHeaders(msg('Sender: evil@x.test', 'From: "Ali, Veli" <A@X.test>', 'To: b@x.test', 'Subject: konu', ' devam', '', 'From: gövde@x.test')))
      .toEqual({ single: 'A@X.test', subject: 'konu devam', to: 'b@x.test' })
  })
  it('çoklu From başlığı, grup ve ayrıştırılamayan From', () => {
    expect(fromHeaders(msg('From: a@x.test', 'From: b@x.test', '', '')).single).toBeNull()
    expect(fromHeaders(msg('From: grup: a@x.test;', '', '')).single).toBeNull()
    expect(fromHeaders(msg('From: adres değil', '', '')).single).toBeNull()
    expect(fromHeaders(msg('Subject: x', '', '')).single).toBeNull()
  })
})

describe('canonicalizeCrlf', () => {
  it('yalnız tek LF dönüşür', () => {
    expect(canonicalizeCrlf(Buffer.from('a\nb\r\nc\n')).toString()).toBe('a\r\nb\r\nc\r\n')
  })
})

describe('başlık sınırı', () => {
  it('LF sonrası boş CRLF satırı başlıkları bitirir', () => {
    const raw = Buffer.from('From: a@example.test\n\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n')
    expect(classifyRaw(raw)).toBe('none')
  })
  it('bare CR içeren From tek adres sayılmaz', () => {
    expect(fromHeaders(Buffer.from('From: a@example.test\rFrom: b@example.test\r\n\r\nx')).single).toBeNull()
  })
})
