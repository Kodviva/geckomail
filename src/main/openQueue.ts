// Bildirim tıklaması: pencere yeni kuruluyorsa ya da giriş ekranındaysa bağlantı kaybolmasın, renderer girişi tamamlayınca gitsin.
export interface OpenLink { messageId: number | null; accountId: number | null; reply: boolean }

export class OpenQueue {
  private pending: OpenLink[] = []
  private send: ((l: OpenLink) => void) | null = null
  /** Geçiş sürerken duran gönderici: gezinme engellenirse sayfa yerindedir ve geri açılır */
  private held: ((l: OpenLink) => void) | null = null

  push(l: OpenLink): void {
    if (this.send) this.send(l)
    else this.pending.push(l)
  }

  /** Renderer'da kullanıcı oturumu hazır */
  ready(send: (l: OpenLink) => void): void {
    this.send = send
    this.held = null
    for (const l of this.pending.splice(0)) send(l)
  }

  /** Sayfa yeniden yükleniyor: bekleyen kalır, gönderim durur */
  pause(): void {
    this.held = this.send ?? this.held
    this.send = null
  }

  /** Yeni belge geldi: eski sayfanın göndericisi geçersiz, renderer yeniden bildirir */
  committed(): void {
    this.held = null
  }

  /** Yükleme yeni belge getirmeden bitti */
  resume(): void {
    if (this.held) this.ready(this.held)
  }

  /** Çıkış ya da pencere kapandı: bekleyen sonraki kullanıcıya kalmaz */
  reset(): void {
    this.send = null
    this.held = null
    this.pending = []
  }
}

/** Yalnız ana çerçevenin belge değişimi: posta `srcdoc` iframe'i de `did-start-loading` üretir. `will-navigate` ile engellenen ya da
 *  indirmeye dönen gezinme de başlamış sayılır, ama `did-navigate` gelmez ve `did-fail-load` da gelmeyebilir: kuyruk `did-stop-loading`de açılır */
export function trackNavigation(wc: Pick<Electron.WebContents, 'on'>, links: OpenQueue): void {
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) links.pause()
  })
  wc.on('did-navigate', () => links.committed())
  wc.on('did-stop-loading', () => links.resume())
}

/** Pencere yokken sunucu sayfası doğrudan iletiyle açılır (web istemcisinin derin bağlantısı) */
export function deepLinkPath(l: OpenLink): string | null {
  if (l.messageId == null) return null
  return `/?${l.reply ? 'reply' : 'm'}=${l.messageId}`
}
