// Soğuk açılış T14: kilit çözülmeden kimlik isteği de soket de başlamaz (güvenlik düzeltmesi)
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, '../store/session.ts'), 'utf8')

describe('açılışta kilit', () => {
  it('webMe kilit çözülmeden çağrılmaz', () => {
    const boot = src.slice(src.indexOf('const bounded = await hasOfflineCopy()') - 200)
    const wait = boot.indexOf('await whenUnlocked()')
    expect(wait).toBeGreaterThan(-1)
    expect(wait).toBeLessThan(boot.indexOf('webLogout()'))
    expect(wait).toBeLessThan(boot.indexOf('webMe()'))
  })

  it('kilitliyken kopuş kimlik sormaz', () => {
    const h = src.slice(src.indexOf("rpc.on('local:disconnected'"))
    expect(h.indexOf('isLocked()')).toBeLessThan(h.indexOf('webMe()'))
    expect(h.indexOf('isLocked()')).toBeGreaterThan(-1)
  })
})
