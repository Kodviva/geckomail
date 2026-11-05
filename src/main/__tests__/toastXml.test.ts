import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { buildToastXml, escapeXml, parseToastArgs } from '../toastXml'

const labels = { read: 'Okundu', archive: 'Arşivle', reply: 'Yanıtla' }
const base = { title: 'Başlık', body: 'Gövde', messageId: 7, accountId: 3, actions: ['read', 'archive', 'reply'] as ('read' | 'archive' | 'reply')[], labels, urgent: false, iconPath: null }
const parse = (xml: string) => new DOMParser({ onError: (level, msg) => { throw new Error(`${level}: ${msg}`) } }).parseFromString(xml, 'text/xml')
const tags = (doc: ReturnType<typeof parse>, name: string) => Array.from(doc.getElementsByTagName(name))

describe('escapeXml', () => {
  it('beş özel karakter ve XML dışı denetim karakteri', () => {
    expect(escapeXml(`<a b="c" d='e'>&`)).toBe('&lt;a b=&quot;c&quot; d=&apos;e&apos;&gt;&amp;')
    expect(escapeXml('a\u0000b\u0008c\u001Fd\uFFFEe\tf\ng')).toBe('abcde\tf\ng')
    expect(escapeXml('x\uD83Dy')).toBe('xy') // eşi olmayan vekil XML'i bozar
    expect(escapeXml('😀')).toBe('😀')
  })
})

describe('buildToastXml', () => {
  it('escapes hostile subject', () => {
    const hostile = `"><action content="x" arguments="gecko:archive:1:1"/>`
    const doc = parse(buildToastXml({ ...base, title: hostile, body: `</text><text>sahte`, actions: [] }))
    expect(tags(doc, 'action')).toHaveLength(0)
    const texts = tags(doc, 'text')
    expect(texts).toHaveLength(2)
    expect(texts[0].childNodes.length).toBe(1)
    expect(texts[0].textContent).toBe(hostile)
    expect(texts[1].textContent).toBe('</text><text>sahte')
  })

  it('etiket ve simge yolu da kaçırılır', () => {
    const doc = parse(buildToastXml({ ...base, actions: ['read'], labels: { ...labels, read: `"/><action arguments="gecko:archive:1:1` }, iconPath: 'C:\\a"b.png' }))
    expect(tags(doc, 'action')).toHaveLength(1)
    expect(tags(doc, 'action')[0].getAttribute('arguments')).toBe('gecko:read:7:3')
    expect(tags(doc, 'image')[0].getAttribute('src')).toBe('C:\\a"b.png')
  })

  it('one action per id', () => {
    const doc = parse(buildToastXml({ ...base, actions: ['read', 'read', 'archive'] }))
    expect(tags(doc, 'action').map((a) => a.getAttribute('arguments'))).toEqual(['gecko:read:7:3', 'gecko:archive:7:3'])
  })

  it('summary has no actions', () => {
    const doc = parse(buildToastXml({ ...base, messageId: null, accountId: null }))
    expect(tags(doc, 'action')).toHaveLength(0)
    expect(tags(doc, 'toast')[0].getAttribute('launch')).toBe('gecko:open::')
  })

  it('her öğe argüman taşır, içerik taşımaz', () => {
    const doc = parse(buildToastXml({ ...base, title: 'gizli konu' }))
    const args = [tags(doc, 'toast')[0].getAttribute('launch'), ...tags(doc, 'action').map((a) => a.getAttribute('arguments'))]
    for (const a of args) expect(parseToastArgs(a!), a!).not.toBeNull()
    expect(args.join(' ')).not.toContain('gizli')
  })

  it('okundu ve arşiv arka planda, yanıtla ön planda', () => {
    const doc = parse(buildToastXml(base))
    expect(tags(doc, 'action').map((a) => a.getAttribute('activationType'))).toEqual(['background', 'background', 'foreground'])
  })

  it('acil: ekranda kalır, Windows düğmesiz hatırlatıcıyı yok sayar', () => {
    const urgent = parse(buildToastXml({ ...base, urgent: true }))
    expect(tags(urgent, 'toast')[0].getAttribute('scenario')).toBe('reminder')
    const noActions = parse(buildToastXml({ ...base, urgent: true, actions: [] }))
    expect(tags(noActions, 'action').map((a) => a.getAttribute('activationType'))).toEqual(['system'])
    expect(parse(buildToastXml(base)).getElementsByTagName('toast')[0].getAttribute('scenario')).toBeFalsy()
  })
})

describe('parseToastArgs', () => {
  it('geçerli biçimler', () => {
    expect(parseToastArgs('gecko:open:7:3')).toEqual({ action: 'open', messageId: 7, accountId: 3 })
    expect(parseToastArgs('gecko:archive:7:')).toEqual({ action: 'archive', messageId: 7, accountId: null })
    expect(parseToastArgs('gecko:open::')).toEqual({ action: 'open', messageId: null, accountId: null })
  })
  it('kötü girdi null', () => {
    for (const bad of ['', 'gecko', 'gecko:open', 'gecko:delete:1:2', 'gecko:read:a:2', 'gecko:read:1:2:3', ' gecko:read:1:2', 'gecko:read:1:2\n', 'GECKO:read:1:2', 'gecko:read:-1:2', `gecko:read:${'9'.repeat(30)}:1`, 'dismiss'])
      expect(parseToastArgs(bad), bad).toBeNull()
  })
})

describe('sınırdan kaçan değerler', () => {
  const labels = { read: 'Okundu', archive: 'Arşivle', reply: 'Yanıtla' }
  const base = { title: 'T', body: 'B', accountId: 1, messageId: 2, actions: [] as never[], labels, urgent: false, iconPath: null }
  const injected = (xml: string): void => {
    expect(xml).not.toMatch(/activationType="protocol"/)
    expect(xml).not.toContain('calc:')
    expect(xml.match(/<toast /g)).toHaveLength(1)
  }
  it('metin kimlik öznitelikten çıkamaz', () => {
    const hostile = '1"/></actions><actions><action content="x" arguments="calc:" activationType="protocol"/><x y="'
    injected(buildToastXml({ ...base, messageId: hostile as never, actions: ['read'] as never[] }))
    injected(buildToastXml({ ...base, accountId: hostile as never }))
  })
  it('bilinmeyen eylem düğme üretmez, fırlatmaz', () => {
    const xml = buildToastXml({ ...base, actions: ['gecko:read" activationType="protocol', 'read'] as never[] })
    injected(xml)
    expect(xml.match(/<action /g)).toHaveLength(1)
  })
})
