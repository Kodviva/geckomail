// Sunucudaki betiklerle birlikte yaşama kararı. Saf: sunucu görüntüsünden ne yapılacağını söyler, yazmaz.
// Kullanıcının betiği hiçbir kolda hedef değildir: başka betik etkinse sarmalayıcı etkinleştirilir.
import { SIEVE_RULES_SCRIPT, SIEVE_WRAPPER_SCRIPT, type SieveState } from '../../shared/sieve'
import { parseManagedHeader } from './generate'
import { scriptUses } from './scriptScan'

export interface ServerView {
  scripts: { name: string; active: boolean }[]
  rulesText: string | null
  wrapperText: string | null
  activeText: string | null
  extensions: string[]
  consentScript: string | null
  wrapperOf: string | null
  /** etkin sarmalayıcının içerdiği betik: etkin değilse null */
  wrappedName?: string | null
  wrappedText?: string | null
}

export type ActivationPlan =
  | { do: 'activate_rules' }
  | { do: 'replace_only' }
  | { do: 'write_wrapper'; userScript: string }
  | { do: 'stop'; state: Extract<SieveState, 'needs_consent' | 'blocked_no_include' | 'blocked_user_include' | 'conflict' | 'drift' | 'displaced'>; userScript?: string }

type Ownership = 'none' | 'ours' | 'conflict' | 'drift'

/** Sahiplik adla değil başlıkla: başlık türü de ada uymalı, sarmalayıcı başlıklı geckomail-rules bizim değildir */
export function scriptOwnership(text: string | null, kind: 'rules' | 'wrapper'): Ownership {
  if (text === null) return 'none'
  const header = parseManagedHeader(text)
  if (!header || header.kind !== kind) return 'conflict'
  return header.valid ? 'ours' : 'drift'
}

export function planActivation(v: ServerView): ActivationPlan {
  const rules = scriptOwnership(v.rulesText, 'rules')
  const wrapper = scriptOwnership(v.wrapperText, 'wrapper')
  if (rules === 'conflict' || wrapper === 'conflict') return { do: 'stop', state: 'conflict' }
  if (rules === 'drift' || wrapper === 'drift') return { do: 'stop', state: 'drift' }

  const active = v.scripts.find((s) => s.active)?.name ?? null
  // K5 kurulumdan sonra da geçerli: sarmalanan betik sonradan include kullanmaya başlamış olabilir
  if (active === SIEVE_WRAPPER_SCRIPT && v.wrappedText != null && scriptUses(v.wrappedText, 'include')) {
    return { do: 'stop', state: 'blocked_user_include', userScript: v.wrappedName ?? undefined }
  }
  if (active === SIEVE_RULES_SCRIPT || active === SIEVE_WRAPPER_SCRIPT) return { do: 'replace_only' }
  // sarmalayıcı kuruluyken etkinlik el değiştirdi: kullanıcının kararı, geri alınmaz
  if (v.wrapperOf !== null && wrapper === 'ours') return { do: 'stop', state: 'displaced', userScript: active ?? undefined }
  if (active === null) return { do: 'activate_rules' }

  const userScript = active
  if (!v.extensions.map((e) => e.toLowerCase()).includes('include')) return { do: 'stop', state: 'blocked_no_include', userScript }
  if (v.activeText !== null && scriptUses(v.activeText, 'include')) return { do: 'stop', state: 'blocked_user_include', userScript }
  if (v.activeText === null || v.consentScript !== active) return { do: 'stop', state: 'needs_consent', userScript }
  return { do: 'write_wrapper', userScript }
}

/** RFC 5230: bir çalıştırmada iki vacation hatadır, include ile bizim betiğimiz başarısız olur (K19) */
export function vacationConflict(activeUserText: string | null): boolean {
  return activeUserText !== null && scriptUses(activeUserText, 'vacation')
}
