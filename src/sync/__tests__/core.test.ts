import { describe, expect, it } from 'vitest'
import { classifyError, describeError } from '../imapClient'
import { hasAttachmentParts, messageDate } from '../imapPoll'
import { splitAddresses } from '../smtpSend'
import { smtpErrorKind } from '../opQueue'

describe('classifyError', () => {
  it('kimlik hatasını tanır', () => {
    expect(classifyError({ authenticationFailed: true, message: 'x' })).toBe('auth')
    expect(classifyError(new Error('Invalid credentials (Failure)'))).toBe('auth')
  })
  it('limit hatasını tanır', () => {
    expect(classifyError(new Error('Too many simultaneous connections'))).toBe('limit')
  })
  it('ağ hatasını tanır', () => {
    expect(classifyError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe('net')
    expect(classifyError(new Error('Socket timeout'))).toBe('net')
  })
  it('login öncesi ağ hatası preauth (IP engeli imzası)', () => {
    expect(classifyError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', phase: 'connect' }))).toBe('preauth')
    expect(classifyError(Object.assign(new Error('unexpected eof'), { phase: 'connect' }))).toBe('preauth')
    expect(classifyError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe('net')
  })
  it('bağlanırken auth hatası yine auth', () => {
    expect(classifyError({ authenticationFailed: true, message: 'x', phase: 'connect' })).toBe('auth')
  })
  it('ETHROTTLE limit sayılır', () => {
    expect(classifyError(Object.assign(new Error('x'), { code: 'ETHROTTLE' }))).toBe('limit')
  })
  it('gerisi other', () => {
    expect(classifyError(new Error('BAD parse'))).toBe('other')
  })
})

describe('hasAttachmentParts', () => {
  it('düz text mesajda ek yok', () => {
    expect(hasAttachmentParts({ type: 'text/plain' })).toBe(false)
  })
  it('attachment disposition yakalar', () => {
    expect(
      hasAttachmentParts({
        type: 'multipart/mixed',
        childNodes: [{ type: 'text/plain' }, { type: 'application/pdf', disposition: 'attachment' }]
      })
    ).toBe(true)
  })
  it('isimli text olmayan parçayı ek sayar', () => {
    expect(
      hasAttachmentParts({
        type: 'multipart/mixed',
        childNodes: [{ type: 'image/png', parameters: { name: 'a.png' } }]
      })
    ).toBe(true)
  })
})

describe('splitAddresses', () => {
  it('virgül ve noktalı virgülle böler', () => {
    expect(splitAddresses('a@x.com, b@y.com; c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com'])
    expect(splitAddresses(undefined)).toEqual([])
  })
})

describe('smtpErrorKind', () => {
  it('EAUTH/535 auth', () => {
    expect(smtpErrorKind({ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' })).toBe('auth')
  })
  it('bağlantı aşamasındaki ağ hatası preauth', () => {
    expect(smtpErrorKind({ code: 'ESOCKET', command: 'CONN' })).toBe('preauth')
    expect(smtpErrorKind({ code: 'ECONNECTION' })).toBe('preauth')
  })
  it('gönderim ortasında kopma net', () => {
    expect(smtpErrorKind({ code: 'ESOCKET', command: 'DATA' })).toBe('net')
  })
  it('421 limit, greylisting 451 limit değil', () => {
    expect(smtpErrorKind({ responseCode: 421, message: 'x' })).toBe('limit')
    expect(smtpErrorKind(Object.assign(new Error('451 greylisted'), { responseCode: 451 }))).toBe('other')
  })
})

describe('describeError', () => {
  it('sunucu cevabını ve komutu ekler (etiket atılır)', () => {
    const e = Object.assign(new Error('Command failed'), {
      responseStatus: 'NO', responseText: 'Mailbox does not exist', executedCommand: 'A7 SELECT "INBOX.Arşiv" (CONDSTORE)'
    })
    expect(describeError(e)).toBe('Command failed — NO: Mailbox does not exist [SELECT "INBOX.Arşiv" (CONDSTORE)]')
  })
  it('kodu yalnız metinde yoksa ekler', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 'ETIMEOUT' }))).toBe('x (ETIMEOUT)')
    expect(describeError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe('read ECONNRESET')
  })
})

describe('messageDate', () => {
  const arrival = new Date('2026-09-30T10:00:00Z')
  it('normal durumda başlık tarihi', () => {
    expect(messageDate(new Date('2026-09-30T09:58:00Z'), arrival)).toBe(new Date('2026-09-30T09:58:00Z').getTime())
  })
  it('varıştan 1 günden fazla ileri tarih sahte sayılır → varış', () => {
    expect(messageDate(new Date('2031-01-01T00:00:00Z'), arrival)).toBe(arrival.getTime())
  })
  it('başlık yok/bozuksa varış; ikisi de yoksa şimdi', () => {
    expect(messageDate(undefined, arrival)).toBe(arrival.getTime())
    expect(messageDate('çöp', arrival)).toBe(arrival.getTime())
    expect(messageDate(undefined, undefined, 123)).toBe(123)
  })
})
