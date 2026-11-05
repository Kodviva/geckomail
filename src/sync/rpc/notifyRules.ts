// RPC — Kişiye ait bildirim kuralları ve hesap tercihleri (§10.1). Her girişli kullanıcı yalnız kendi kayıtlarını görür/yazar.
// Masaüstü ajanının kaydı, bildirim eylemi ve kaçan bildirimler de burada; yalnız sunucu modunda (SERVER_ONLY_METHODS).
import { MAX_RULES, validateRule } from '../../shared/notifyRules'
import type { SessionUser } from '../../shared/rpc'
import { sessionUserFromRow, userCanView } from '../auth/sessionUser'
import { applyNotifyAction, parseNotifyAction } from '../notifyActions'
import { maskNotify } from '../notifyBacklog'
import type { RpcSession } from '../rpcSession'
import type { Handler } from './common'
import { t } from '../../shared/i18n'

const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_LABEL = 100

/** Ajan kapalı pencereden eylem yapar, kuyruk içerik verir: oturumdaki kimlik (60 sn'ye dek bayat) yerine DB */
function freshUser(s: RpcSession): SessionUser {
  const row = s.deps.q.getUserById(s.currentUser!.id)
  if (!row?.enabled) throw new Error(t('sync.perm.loginRequired'))
  return sessionUserFromRow(s.deps.q, row)
}

export const notifyRulesHandlers: Record<string, Handler> = {
  /** Uç nokta `desktop:<userId>:<deviceId>`: push gönderilmez, satır oturumla yaşar (oturum uzaması, çıkış, cihaz listesi).
   *  Kullanıcı uç noktada: aynı cihazda başkası girince önceki kullanıcının satırı ona geçmez */
  async registerDesktopAgent(s: RpcSession, params: unknown) {
    const { deviceId, label } = (params ?? {}) as { deviceId?: unknown; label?: unknown }
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId) || typeof label !== 'string') throw new Error(t('sync.notify.ruleInvalid'))
    if (!s.webSessionId) throw new Error(t('sync.perm.loginRequired')) // satır oturumsuz kalırsa oturumu uzatamaz
    const id = s.deps.q.upsertPushDevice({
      userId: s.currentUser!.id, sessionId: s.webSessionId, endpoint: `desktop:${s.currentUser!.id}:${deviceId}`, p256dh: '', auth: '',
      label: label.slice(0, MAX_LABEL), now: s.hub.now(), kind: 'desktop'
    })
    return { id }
  },

  /** false: ileti yok, kasa kilitli ya da yetki yok (ayrım yapılmaz); ajan bu durumda iletiyi açar */
  async notifyAction(s: RpcSession, params: unknown) {
    const input = parseNotifyAction((params ?? {}) as Record<string, unknown>)
    const user = freshUser(s)
    return { ok: !!input && applyNotifyAction(s.hub, user, input) }
  },

  async notifyBacklog(s: RpcSession, params: unknown) {
    const afterSeq = (params as { afterSeq?: unknown } | null)?.afterSeq
    const user = freshUser(s)
    const r = s.hub.notifyBacklog.since(user.id, Number.isSafeInteger(afterSeq) ? (afterSeq as number) : 0)
    // ögeler yazıldıktan sonra hesap izni kalkmış ya da hesap kasaya alınmış olabilir
    const items = r.items.filter((i) => i.accountId == null || userCanView(s.deps.q, user, i.accountId))
    return { ...r, items: items.map((i) => (i.accountId != null && s.deps.q.isAccountSecure(i.accountId) ? maskNotify(i) : i)) }
  },

  async listNotifyRules(s: RpcSession, _params: unknown) {
    return s.deps.q.listNotifyRules(s.currentUser!.id)
  },

  async saveNotifyRule(s: RpcSession, params: unknown) {
    const v = validateRule((params as { rule?: unknown } | null)?.rule)
    if (typeof v === 'string') throw new Error(t('sync.notify.ruleInvalid'))
    // yalnız yeni kural sayılır: sınırdaki kullanıcı var olanı yine düzenleyebilir; eşzamanlı kayıt yok (await yok)
    if (!v.id && s.deps.q.countNotifyRules(s.currentUser!.id) >= MAX_RULES) throw new Error(t('sync.notify.ruleLimit', { max: MAX_RULES }))
    const saved = s.deps.q.saveNotifyRule(s.currentUser!.id, v, s.hub.now())
    if (!saved) throw new Error(t('sync.notify.ruleInvalid'))
    s.deps.scheduler.refreshHot() // sunucu IDLE kümesi kural sahibi hesapları öne alır
    return saved
  },

  async deleteNotifyRule(s: RpcSession, params: unknown) {
    const { id } = params as { id: number }
    s.deps.q.deleteNotifyRule(s.currentUser!.id, Number(id))
    s.deps.scheduler.refreshHot()
    return null
  },

  async reorderNotifyRules(s: RpcSession, params: unknown) {
    const { ids } = params as { ids: number[] }
    if (!Array.isArray(ids)) throw new Error(t('sync.notify.ruleInvalid'))
    s.deps.q.reorderNotifyRules(s.currentUser!.id, ids.map(Number))
    return null
  },

  async getNotifyAccountPrefs(s: RpcSession, _params: unknown) {
    return s.deps.q.listNotifyAccountPrefs(s.currentUser!.id)
  },

  async setNotifyAccountPref(s: RpcSession, params: unknown) {
    const p = params as { accountId: number; mode: string }
    if (p.mode !== 'on' && p.mode !== 'off' && p.mode !== 'default') throw new Error(t('sync.notify.ruleInvalid'))
    s.assertCanView(Number(p.accountId))
    s.deps.q.setNotifyAccountPref(s.currentUser!.id, Number(p.accountId), p.mode === 'default' ? null : p.mode)
    s.deps.scheduler.refreshHot() // herkesçe susturulan hesap IDLE kümesinden çıkar
    return null
  }
}
