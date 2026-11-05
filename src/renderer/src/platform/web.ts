// Tarayıcı (sunucu modu web istemcisi): masaüstüne özgü yetenekler yok ya da indirme/yeni sekmeyle karşılanır.
import { UploadError, type BackupResult, type Platform, type ServerBackup } from '.'
import { t } from '../../../shared/i18n'
import { apiFetch } from '../apiFetch'
import { rpc } from '../rpcClient'

/** Tarayıcıya dosya indirtir (geçici <a download>) */
function download(href: string, name: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** RFC 5987 ext-value: attr-char dışı her şey yüzde kodlu */
function rfc5987(name: string): string {
  return `UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
}

/** RPC yanıtındaki bayt dizisi WebSocket JSON'unda {"0":..,"1":..} nesnesine dönüşür; ikisini de kabul et */
function toBytes(data: Uint8Array | Record<string, number>): Uint8Array<ArrayBuffer> {
  if (data instanceof Uint8Array) return data as Uint8Array<ArrayBuffer>
  return Uint8Array.from(Object.values(data))
}

/** Yedek uçlarına istek; başarısızsa sunucunun reason'ı (JSON değilse HTTP durumu) */
async function backupCall<T extends object>(path: string, init: RequestInit, read: (r: Response) => Promise<T>): Promise<BackupResult<T>> {
  let r: Response
  try {
    r = await apiFetch(path, { method: init.method ?? 'POST', ...init })
  } catch {
    return { ok: false, reason: 'network', status: 0 }
  }
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { reason?: string }
    return { ok: false, reason: j.reason ?? 'failed', status: r.status }
  }
  return { ok: true, ...(await read(r)) }
}

/** OAuth penceresini kapatma denemeleri: 250 ms arayla en çok 10 sn */
const OAUTH_CLOSE_TRIES = 40
const OAUTH_CLOSE_RETRY_MS = 250

const jsonInit = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** Sunucu yedeği: parola yalnız JSON gövdede (başlıkta/adreste değil); indirilen dosya Blob ile kaydedilir */
function createServerBackup(): ServerBackup {
  return {
    download: (passphrase) =>
      backupCall('/api/backup', jsonInit({ passphrase }), async (r) => {
        const name = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') ?? '')?.[1] ?? 'geckomail.geckobak'
        const url = URL.createObjectURL(await r.blob())
        try {
          download(url, name)
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
        return { restorable: r.headers.get('X-Gecko-Restorable') !== '0' }
      }),
    upload: (f) =>
      backupCall('/api/restore/upload', { headers: { 'Content-Type': 'application/octet-stream' }, body: f }, async (r) => {
        const { uploadId } = (await r.json()) as { uploadId: string }
        return { uploadId }
      }),
    stage: (uploadId, passphrase) =>
      backupCall('/api/restore/stage', jsonInit({ uploadId, passphrase }), async (r) => {
        const { accounts } = (await r.json()) as { accounts: number }
        return { accounts }
      }),
    status: () =>
      backupCall('/api/restore/status', { method: 'GET' }, async (r) => (await r.json()) as { staged: boolean; stagedAt?: number; rejectedAt?: number }),
    cancel: () => backupCall('/api/restore/cancel', jsonInit({}), async () => ({})),
    restart: () => backupCall('/api/restart', jsonInit({}), async () => ({}))
  }
}

/** Ek ucunun hata durumu → arayüz metni */
export function attachmentError(status: number): string {
  if (status === 401) return t('acct.session.expired')
  if (status === 423) return t('mail.list.vaultLocked')
  if (status === 502) return t('sync.body.downloadFailed')
  return String(status)
}

// tüm ekler HTTP ile yüklenir (büyüklüğüne bakılmaz): WebSocket'te Uint8Array JSON'a sayı nesnesi olarak
// dökülür (bayt başına ~6 karakter), 8 MB'lık bir ek bile çerçeveyi şişirirdi
export async function uploadFile(f: File): Promise<string> {
  const r = await apiFetch('/api/upload', {
    method: 'POST', body: f,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': rfc5987(f.name) }
  })
  if (!r.ok) throw new UploadError(r.status)
  const { uploadId } = (await r.json()) as { uploadId: string }
  return uploadId
}

export async function discardUpload(uploadId: string): Promise<void> {
  try {
    await apiFetch(`/api/upload/${encodeURIComponent(uploadId)}`, { method: 'DELETE' })
  } catch {
    /* olmazsa süpürücü 1 saatte siler */
  }
}

export function createWebPlatform(): Platform {
  // ek HTTP akışıyla iner (8 MB üstü WebSocket'e girmez). <a download> hatayı sayfaya bildirmez, büyük dosya belleğe de
  // alınmaz: önce HEAD aynı denetimlerden geçer (eksikse sunucuya çekilir), hata çağırana atılır
  const attachment = async (a: { messageId: number; attachmentId: number; name: string }): Promise<void> => {
    const url = `/api/attachment/${encodeURIComponent(a.messageId)}/${encodeURIComponent(a.attachmentId)}`
    const r = await apiFetch(url, { method: 'HEAD' })
    if (!r.ok) throw new Error(attachmentError(r.status))
    download(url, a.name)
  }

  return {
    kind: 'web',
    native: null,
    serverOrigin: null,
    // dil seçimi tarayıcının yerel deposunda (locale.ts); ayrı bir main süreci yok. Sunucunun ürettiği metinler
    // (hata iletileri) için oturuma bildirilir; bağlantı kapalıysa sync:hello'da gönderilir (store/session.ts)
    savedLocale: () => null,
    setLocale: (locale) => {
      if (rpc.isOpen) rpc.call('setSessionLocale', { locale }).catch(() => {})
    },
    biometricAvailable: async () => false,
    promptBiometric: async () => false,
    openAttachment: attachment,
    async saveSmimeAttachment(a) {
      const url = `/api/smime-attachment/${encodeURIComponent(a.messageId)}/${encodeURIComponent(a.index)}`
      const r = await apiFetch(url, { method: 'HEAD' })
      if (!r.ok) throw new Error(attachmentError(r.status))
      download(url, a.name)
    },
    revealAttachment: attachment,
    async saveBytes(name, data) {
      const url = URL.createObjectURL(new Blob([toBytes(data)]))
      try {
        download(url, name)
      } finally {
        // tıklama indirmeyi başlattıktan sonra bırakılır
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      return true
    },
    // yedek/geri yükleme web'de HTTP akışıyla (Görev 6); dosya seçici yolu yok
    chooseBackupSave: async () => null,
    chooseBackupOpen: async () => null,
    async relaunch() {
      window.location.reload()
    },
    filePath: () => null,
    trashFile: async () => false,
    // 'noopener' özelliği verilirse window.open her zaman null döner (engellenen açılır pencere ayırt
    // edilemez): pencere alınır, opener hemen kesilir.
    async openOAuthUrl(url) {
      const w = window.open(url, '_blank')
      if (!w) return false
      w.opener = null
      return true
    },
    // OAuth akışı (useOAuthConnect): pencere tıklamada boş açılır, sağlayıcı adresi oauthStart dönünce
    // verilir; dönüş sunucunun /oauth/callback sayfasına, tamamlama bu sayfadan (oauthComplete), sonuç
    // 'oauth:done' olayıyla gelir
    oauthWindow() {
      const w = window.open('about:blank', '_blank')
      if (!w) return null
      w.opener = null
      return {
        go(url) {
          w.location.href = url
        },
        close() {
          // opener'ı kesilen pencere yalnız aynı kökenli belgedeyken kapatılabilir; dönüş sayfası henüz
          // işlenmemişse (WebKit) close() sessizce yok sayılır: pencere kapanana dek yinelenir
          let left = OAUTH_CLOSE_TRIES
          const attempt = (): void => {
            try {
              w.close()
            } catch {
              /* pencere zaten kapalı */
            }
            if (!w.closed && --left > 0) setTimeout(attempt, OAUTH_CLOSE_RETRY_MS)
          }
          attempt()
        }
      }
    },
    async oauthComplete(state) {
      const r = await apiFetch('/oauth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state })
      })
      if (r.ok) return { ok: true }
      const j = (await r.json().catch(() => ({}))) as { reason?: string }
      return { ok: false, reason: j.reason ?? String(r.status) }
    },
    uploadFile,
    discardUpload,
    serverBackup: createServerBackup(),
    wallboard: null,
    nativeNotifications: false,
    oauthExternal: null,
    wrapTransport: null,
    serverMode: null,
    rendererReady: () => {},
    migration: null,
    loginItem: null
  }
}
