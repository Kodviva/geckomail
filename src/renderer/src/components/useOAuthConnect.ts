// OAuth2 bağlama akışı (Gmail / Microsoft 365): sync yerel yönlendirme sunucusunu açar, main sistem
// tarayıcısında izin sayfasını açar, kullanıcı izin verince hesap eklenir ya da yeniden yetkilendirilir.
// Web'de dönüş sunucunun /oauth/callback adresine gelir: açılır pencere tıklamada senkron açılır (engelleyici),
// sonuç oauthFinish yerine 'oauth:done' olayıyla beklenir.
import { useCallback, useRef, useState } from 'react'
import type { PimConnectStatus } from '../../../shared/pim'
import type { OAuthProvider } from '../../../shared/rpc'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import { t } from '../../../shared/i18n'
import { platform, type OAuthWindow } from '../platform'

// sunucu akışı 10 dk'da kendisi düşer (olay gelir); 'oauth:returned' yeni sokette yinelenir, 'oauth:done' kaybolabilir
// — istemci de bırakır
const WEB_WAIT_MS = 11 * 60_000

export interface ConnectResult {
  email: string
  added: boolean
  pimStatus?: PimConnectStatus
}

export type ConnectOptions = { email?: string; accountId?: number; /** kişi ve takvim kapsamları da istenir */ pim?: boolean }

export const PIM_TOAST: Record<PimConnectStatus, string> = {
  connected: 'pim.connect.connected',
  needsConsent: 'pim.connect.needsConsent',
  notFound: 'pim.connect.notFound',
  noSecret: 'pim.connect.noSecret',
  confirmHost: 'pim.connect.notFound'
}

/** Web: sağlayıcı dönüşünde ('oauth:returned') pencereyi kapatıp akışı bu sayfadan tamamlar, sonucu
 *  ('oauth:done') bekler; abort ile bırakılır */
export function waitDone(
  flowId: string, state: string, popup: OAuthWindow, abortRef: { current: (() => void) | null }
): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    // sunucu yeni soket açılınca dönmüş akışı yeniden duyurur: ikinci tamamlama "akış yok" derdi
    let completing = false
    const finish = (): void => {
      off()
      offReturned()
      clearTimeout(timer)
      abortRef.current = null
    }
    const off = rpc.on('oauth:done', (d) => {
      if (d.flowId !== flowId) return
      finish()
      if (d.ok && d.email) resolve({ email: d.email, added: !!d.added, ...(d.pimStatus ? { pimStatus: d.pimStatus } : {}) })
      else reject(new Error(d.error || t('sync.oauth.cancelled')))
    })
    const offReturned = rpc.on('oauth:returned', (d) => {
      if (d.flowId !== flowId || completing) return
      completing = true
      void platform.oauthComplete!(state).then(
        (r) => {
          // dönüş sayfası bu kökende: pencere artık kapatılabilir (sonuç bu sekmede gösterilir)
          popup.close()
          // denied/failed ayrıntısı 'oauth:done' ile gelir; geçersiz/süresi dolmuş akışta olay yok
          if (r.ok || r.reason === 'denied' || r.reason === 'failed') return
          finish()
          reject(new Error(t('sync.oauth.flowNotFound')))
        },
        (e: Error) => {
          finish()
          reject(e)
        }
      )
    })
    const timer = setTimeout(() => {
      finish()
      reject(new Error(t('sync.oauth.webFlowTimeout')))
    }, WEB_WAIT_MS)
    abortRef.current = () => {
      finish()
      reject(new Error(t('sync.oauth.cancelled')))
    }
  })
}

export const OAUTH_LABEL: Record<OAuthProvider, string> = { google: 'Google', microsoft: 'Microsoft' }

/** Algılanan sağlayıcı etiketinden (Gmail / Outlook) OAuth sağlayıcısı */
export function oauthProviderFor(label: string | undefined | null): OAuthProvider | null {
  if (!label) return null
  if (/gmail|google/i.test(label)) return 'google'
  if (/outlook|office|microsoft|hotmail/i.test(label)) return 'microsoft'
  return null
}

export function useOAuthConnect() {
  const toast = useStore((s) => s.toast)
  const refreshAccounts = useStore((s) => s.refreshAccounts)
  const [waiting, setWaiting] = useState<OAuthProvider | null>(null)
  const flowRef = useRef<string | null>(null)
  // her bağlanma bir "nesil": eski akışın geç gelen sonucu yenisinin durumunu ezmesin
  const genRef = useRef(0)
  const lastArgs = useRef<{ provider: OAuthProvider; opts: ConnectOptions } | null>(null)
  // web: bekleyen 'oauth:done' dinleyicisi ve açılır pencere
  const abortRef = useRef<(() => void) | null>(null)
  const popupRef = useRef<OAuthWindow | null>(null)

  const cancel = useCallback((): void => {
    if (!flowRef.current && !popupRef.current) return
    if (flowRef.current) void rpc.call('oauthCancel', { flowId: flowRef.current }).catch(() => {})
    abortRef.current?.()
    popupRef.current?.close()
    popupRef.current = null
    flowRef.current = null
    genRef.current++
    setWaiting(null)
  }, [])

  const connect = async (
    provider: OAuthProvider,
    opts: ConnectOptions = {}
  ): Promise<ConnectResult | null> => {
    // masaüstü sunucu modu: akış sistem tarayıcısında, hesap sunucuda oluşur ve eşitlemeyle bu pencereye gelir (K4)
    if (platform.oauthExternal) {
      platform.oauthExternal()
      toast(t('acct.oauth.externalHint'), 'info')
      return null
    }
    // yarım kalmış akış varsa (tarayıcı kapatıldı, yanlış hesap seçildi…) önce onu kapat
    if (flowRef.current || popupRef.current) cancel()
    const gen = ++genRef.current
    lastArgs.current = { provider, opts }
    // web: pencere ilk await'ten önce, tıklamanın içinde açılır
    const popup = platform.oauthWindow ? platform.oauthWindow() : null
    if (platform.oauthWindow && !popup) {
      toast(t('acct.oauth.popupBlocked'))
      return null
    }
    popupRef.current = popup
    try {
      const { flowId, url } = await rpc.call('oauthStart', { provider, email: opts.email, accountId: opts.accountId, ...(opts.pim ? { pim: true } : {}) })
      if (gen !== genRef.current) {
        void rpc.call('oauthCancel', { flowId }).catch(() => {})
        return null
      }
      flowRef.current = flowId
      let r: ConnectResult
      if (popup) {
        popup.go(url)
        setWaiting(provider)
        r = await waitDone(flowId, new URL(url).searchParams.get('state') ?? '', popup, abortRef)
      } else {
        if (!(await platform.openOAuthUrl(url))) throw new Error(t('acct.oauth.browserFailed'))
        setWaiting(provider)
        r = await rpc.call('oauthFinish', { flowId, provider, expectedEmail: opts.email, accountId: opts.accountId, ...(opts.pim ? { pim: true } : {}) })
      }
      if (gen !== genRef.current) return null
      await refreshAccounts()
      if (r.pimStatus) toast(t(PIM_TOAST[r.pimStatus]), r.pimStatus === 'connected' ? 'info' : undefined)
      else
        toast(
          r.added
            ? t('acct.oauth.added', { email: r.email, provider: OAUTH_LABEL[provider] })
            : t('acct.oauth.reauthorized', { email: r.email }),
          'info'
        )
      return r
    } catch (e) {
      if (gen !== genRef.current) return null // iptal edilen/yerini yenisine bırakan akış: sessiz
      toast((e as Error).message)
      return null
    } finally {
      if (gen === genRef.current) {
        // web: sonuç ya da hata bu sekmede; pencere (boş ya da dönüş sayfası) kalmasın
        popup?.close()
        setWaiting(null)
        flowRef.current = null
        popupRef.current = null
      }
    }
  }

  /** bekleme sırasında: eski akışı kapatıp tarayıcıda yeniden aç */
  const retry = (): Promise<ConnectResult | null> =>
    lastArgs.current ? connect(lastArgs.current.provider, lastArgs.current.opts) : Promise.resolve(null)

  return { connect, cancel, retry, waiting }
}
