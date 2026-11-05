// Çevrimdışı salt okunur koruması: mağazanın yazma eylemleri tek yerden kesilir; düğmesi, kısayolu, komut paleti ve
// bağlam menüsü hep aynı eylemlere gelir. Panellerin doğrudan RPC çağrıları rpc.failFast ile reddedilir.
import { t } from '../../../shared/i18n'
import type { State } from './types'

const WRITES = [
  'openComposer', 'deleteMessages', 'moveMessages', 'moveRows', 'moveSpecial', 'openMoveDialog', 'snooze', 'markAllSeen', 'markSeen', 'setFlagged',
  'quickSpamRule', 'toggleStar', 'saveEventDraft', 'removeEvent', 'saveContactDraft', 'removeContact'
] as const

export function guardOfflineWrites(s: State, get: () => State): State {
  const out = { ...s } as unknown as Record<string, unknown>
  for (const name of WRITES) {
    const fn = s[name] as ((...a: unknown[]) => unknown) | undefined
    if (!fn) continue
    out[name] = (...args: unknown[]) => {
      if (!get().offlineMode) return fn(...args)
      get().toast(t('common.offlineReadOnly'), 'info')
      return undefined
    }
  }
  return out as unknown as State
}
