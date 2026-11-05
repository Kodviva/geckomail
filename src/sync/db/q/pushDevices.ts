// Sorgular — push cihaz kayıtları (kişiye ait): Web Push abonelikleri ve röle üzerinden APNs/FCM cihazları.
import type { QCtx } from './ctx'

/** Kullanıcı başına kayıtlı cihaz sınırı: aşılırsa en eski gider */
export const MAX_PUSH_DEVICES = 10

export type PushDeviceKind = 'webpush' | 'desktop' | 'apns' | 'fcm'

/** Tür sütununun tek adı: uzlaştırmada `transport` buraya katıldı, bu sabit dışında sütun adı yazılmaz */
const TRANSPORT_COLUMN = 'kind' as const

export interface PushDevice {
  id: number
  user_id: number
  web_session_id: string | null
  endpoint: string
  p256dh: string
  auth: string
  label: string | null
  created_at: number
  last_ok_at: number | null
  /** 'webpush': şifreli push doğrudan gider; 'apns', 'fcm': röleden; 'desktop': push yok, ajan bildirimi WebSocket'ten alır */
  [TRANSPORT_COLUMN]: PushDeviceKind
}

export const pushTransport = (d: PushDevice): PushDeviceKind => d[TRANSPORT_COLUMN]
export const isRelayDevice = (d: PushDevice): boolean => pushTransport(d) === 'apns' || pushTransport(d) === 'fcm'

export function pushDevicesQueries(c: QCtx) {
  const { prep } = c
  return {
    /** Aynı uç nokta yeniden kaydolursa satır son kaydedene geçer: tarayıcı başka kullanıcıyla giriş yaptıysa
     *  önceki kullanıcının bildirimleri bu tarayıcıya gitmemeli; ad ve zamanlar ona taşınmaz. Sınır aşılırsa
     *  kullanıcının en eski push cihazı silinir (yeni kaydolan hiçbir zaman). Sınır desktop satırlarını saymaz:
     *  desktop satırı silinse o oturum uzamazdı; onun üst sınırı oturum başına tek satırdır. Satır kimliği döner. */
    upsertPushDevice(d: { userId: number; sessionId: string | null; endpoint: string; p256dh: string; auth: string; label: string | null; now: number; kind?: PushDeviceKind }): number {
      return c.db.transaction(() => {
        // SET'in sağ tarafı eski satırı görür: user_id karşılaştırması taşınıp taşınmadığını söyler
        const { id } = prep(
          `INSERT INTO push_devices (user_id, web_session_id, endpoint, p256dh, auth, label, ${TRANSPORT_COLUMN}, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, web_session_id = excluded.web_session_id,
             p256dh = excluded.p256dh, auth = excluded.auth, ${TRANSPORT_COLUMN} = excluded.${TRANSPORT_COLUMN},
             label = CASE WHEN user_id = excluded.user_id THEN COALESCE(excluded.label, label) ELSE excluded.label END,
             created_at = CASE WHEN user_id = excluded.user_id THEN created_at ELSE excluded.created_at END,
             last_ok_at = CASE WHEN user_id = excluded.user_id THEN last_ok_at END
           RETURNING id`
        ).get(d.userId, d.sessionId, d.endpoint, d.p256dh, d.auth, d.label, d.kind ?? 'webpush', d.now) as { id: number }
        if (d.kind === 'desktop') {
          if (d.sessionId != null) prep(`DELETE FROM push_devices WHERE web_session_id = ? AND ${TRANSPORT_COLUMN} = 'desktop' AND id <> ?`).run(d.sessionId, id)
          return id
        }
        prep(
          `DELETE FROM push_devices WHERE user_id = ? AND id <> ? AND ${TRANSPORT_COLUMN} <> 'desktop' AND id NOT IN (
             SELECT id FROM push_devices WHERE user_id = ? AND id <> ? AND ${TRANSPORT_COLUMN} <> 'desktop' ORDER BY created_at DESC, id DESC LIMIT ?
           )`
        ).run(d.userId, id, d.userId, id, MAX_PUSH_DEVICES - 1)
        return id
      })()
    },

    getPushDevice(id: number): PushDevice | undefined {
      return prep(`SELECT * FROM push_devices WHERE id = ?`).get(id) as PushDevice | undefined
    },

    listPushDevices(userId: number): PushDevice[] {
      return prep(`SELECT * FROM push_devices WHERE user_id = ? ORDER BY id`).all(userId) as PushDevice[]
    },

    touchPushDevice(id: number, now: number): void {
      prep(`UPDATE push_devices SET last_ok_at = ? WHERE id = ?`).run(now, id)
    },

    /** Uç nokta da eşleşmeli: gönderim sürerken kimlik yeniden kullanılmış olabilir (AUTOINCREMENT yok) */
    deletePushDevice(id: number, endpoint: string): void {
      prep(`DELETE FROM push_devices WHERE id = ? AND endpoint = ?`).run(id, endpoint)
    },

    /** yalnız kullanıcının kendi satırı; başkasınınki ya da yok: false */
    deleteOwnPushDevice(userId: number, id: number): boolean {
      return prep(`DELETE FROM push_devices WHERE id = ? AND user_id = ?`).run(id, userId).changes > 0
    },

    deletePushDevicesForSession(sessionId: string): void {
      prep(`DELETE FROM push_devices WHERE web_session_id = ?`).run(sessionId)
    },

    /** keepSessionId: o oturuma bağlı cihazlar kalır (oturumsuz cihazlar silinir) */
    deletePushDevicesForUser(userId: number, keepSessionId?: string): void {
      prep(`DELETE FROM push_devices WHERE user_id = ? AND web_session_id IS NOT ?`).run(userId, keepSessionId ?? null)
    },

    listPushDevicesForSession(sessionId: string): PushDevice[] {
      return prep(`SELECT * FROM push_devices WHERE web_session_id = ?`).all(sessionId) as PushDevice[]
    },

    /** Mobil oturum tek kurulumdur: jeton değişince aynı oturumun önceki röle satırı kalmaz */
    deleteOtherRelayDevices(sessionId: string, endpoint: string): void {
      prep(`DELETE FROM push_devices WHERE web_session_id = ? AND endpoint <> ? AND ${TRANSPORT_COLUMN} IN ('apns', 'fcm')`).run(sessionId, endpoint)
    },

    deleteRelayPushDevices(): void {
      prep(`DELETE FROM push_devices WHERE ${TRANSPORT_COLUMN} IN ('apns', 'fcm')`).run()
    },

    deleteAllPushDevices(): void {
      prep(`DELETE FROM push_devices`).run()
    }
  }
}
