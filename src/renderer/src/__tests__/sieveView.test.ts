import { describe, expect, it } from 'vitest'
import tr from '../../../shared/i18n/locales/tr.bundle'
import { SIEVE_MAX_STRING_BYTES, SIEVE_VACATION_CONFLICT, SIEVE_VACATION_TOO_LARGE, type ClientReason, type SieveAccountInfo, type SieveState } from '../../../shared/sieve'
import {
  deployNote, detailLine, placementBadge, reasonKey, remainingBytes, sieveActions, stateHintKey, stateLabelKey, stateTone
} from '../sieveView'

const STATES: SieveState[] = [
  'unknown', 'unsupported', 'off', 'pending', 'active', 'needs_consent', 'blocked_no_include', 'blocked_user_include', 'conflict', 'drift', 'displaced',
  'invalid', 'auth_failed', 'error'
]
const REASONS: ClientReason[] = ['user_choice', 'sieve_off', 'attachment', 'ext_missing', 'unsafe_string', 'non_ascii', 'folder_unknown', 'watch_cap', 'size_cap', 'spam_split', 'order']

const info = (o: Partial<SieveAccountInfo> = {}): SieveAccountInfo => ({
  accountId: 1, enabled: true, state: 'active', detail: null, caps: { implementation: 'x', version: '1.0', sasl: ['PLAIN'], sieve: ['vacation'], maxRedirects: null },
  capsAt: 1, host: 'h.t', port: 4190, deployedAt: 1000, scriptHash: 'a', consentNeededFor: null, wrapperOf: null, customHost: null, ...o
})

describe('sieveView', () => {
  it('displaced with nothing active offers reactivation, not a named consent', () => {
    expect(sieveActions(info({ state: 'displaced', detail: null }))).toMatchObject({ reactivate: true, consent: null })
    expect(sieveActions(info({ state: 'displaced', detail: 'kisisel' }))).toMatchObject({ reactivate: false, consent: 'kisisel' })
    expect(sieveActions(info())).toMatchObject({ reactivate: false })
  })

  it('every state has a label, hint key resolves, tone set', () => {
    for (const s of STATES) {
      expect(tr[stateLabelKey(s)], s).toBeTruthy()
      const hint = stateHintKey(s)
      if (hint) expect(tr[hint], s).toBeTruthy()
      expect(stateTone(s), s).toMatch(/^(ok|wait|warn|bad|off)$/)
    }
  })

  it('every client reason has a text', () => {
    for (const r of REASONS) expect(tr[reasonKey(r)], r).toBeTruthy()
  })

  it('badge reflects a single placement or mixed', () => {
    const p = { ruleId: 1, server: 0, split: 0, client: 0, reasons: [] }
    expect(placementBadge({ ...p, server: 2 }).kind).toBe('server')
    expect(placementBadge({ ...p, split: 1 }).kind).toBe('split')
    expect(placementBadge({ ...p, client: 3 }).kind).toBe('client')
    expect(placementBadge({ ...p, server: 1, client: 1 }).kind).toBe('mixed')
    expect(placementBadge(p).kind).toBe('client')
    for (const k of [{ server: 1 }, { split: 1 }, { client: 1 }, { server: 1, split: 1 }]) expect(tr[placementBadge({ ...p, ...k }).labelKey]).toBeTruthy()
  })

  it('vacation details surface on an active account', () => {
    expect(detailLine(info({ detail: SIEVE_VACATION_CONFLICT }))).toEqual({ key: 'set.sieve.detail.vacationConflict', raw: null })
    expect(detailLine(info({ detail: SIEVE_VACATION_TOO_LARGE }))).toEqual({ key: 'set.sieve.detail.vacationTooLarge', raw: null })
    expect(tr['set.sieve.detail.vacationConflict'] && tr['set.sieve.detail.vacationTooLarge']).toBeTruthy()
  })

  it('detail mapping', () => {
    for (const r of ['no_listener', 'no_tls', 'no_sasl', 'provider']) {
      const d = detailLine(info({ state: 'unsupported', detail: r }))
      expect(tr[d.key!], r).toBeTruthy()
    }
    expect(detailLine(info({ state: 'error', detail: 'sunucu metni' }))).toEqual({ key: null, raw: 'sunucu metni' })
    expect(detailLine(info({ state: 'needs_consent', detail: 'kisisel' }))).toEqual({ key: null, raw: null }) // ad onay penceresinde
    expect(detailLine(info())).toEqual({ key: null, raw: null })
  })

  it('never-deployed active account does not claim a deployment', () => {
    expect(deployNote(info({ deployedAt: null, scriptHash: null }))).toEqual({ key: 'set.sieve.nothingDeployed' })
    expect(deployNote(info({ deployedAt: 5000 }))).toEqual({ key: 'set.sieve.deployedAt', at: 5000 })
    expect(deployNote(info({ enabled: false, state: 'off', deployedAt: null }))).toBeNull()
    expect(tr['set.sieve.nothingDeployed'] && tr['set.sieve.deployedAt']).toBeTruthy()
  })

  it('drift offers rollback and inspection, never redeploy', () => {
    expect(sieveActions(info({ state: 'drift' }))).toMatchObject({ redeploy: false, rollback: true, editor: true })
  })

  it('action table', () => {
    expect(sieveActions(info({ enabled: false, state: 'off', scriptHash: null }))).toMatchObject({ enable: true, rollback: false, redeploy: false, vacation: false })
    expect(sieveActions(info())).toMatchObject({ enable: false, rollback: true, redeploy: true, vacation: true, editor: true })
    expect(sieveActions(info({ enabled: false, state: 'unsupported', caps: null, scriptHash: null }))).toMatchObject({ enable: false, editor: false, retry: true })
    expect(sieveActions(info({ state: 'needs_consent', detail: 'k', consentNeededFor: 'k' })).consent).toBe('k')
    expect(sieveActions(info({ state: 'displaced', detail: 'k' })).consent).toBe('k')
    expect(sieveActions(info()).consent).toBeNull()
    // başarısız geri alma: hesap kapalı ama sunucuda kalıntı var
    expect(sieveActions(info({ enabled: false, state: 'error', scriptHash: 'a' })).rollback).toBe(true)
  })

  it('remaining bytes count CRLF and multibyte like the validator', () => {
    expect(remainingBytes('')).toBe(SIEVE_MAX_STRING_BYTES)
    expect(remainingBytes('a\nb')).toBe(SIEVE_MAX_STRING_BYTES - 4)
    expect(remainingBytes('ş')).toBe(SIEVE_MAX_STRING_BYTES - 2)
    expect(remainingBytes('a'.repeat(SIEVE_MAX_STRING_BYTES + 1))).toBe(-1)
  })
})
