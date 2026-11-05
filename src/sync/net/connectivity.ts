// Cihazın internet bağlantısı. İnternet kesildiğinde tüm bağlantılar düşer; bunu sunucunun reddi
// ("olası IP engeli") sanmak yanlış alarm üretiyordu (30 Eyl: iki kez soğuma, IP aslında engelsizdi).
// İki kaynak: (1) işletim sistemi (main'den net.isOnline + uyku/uyanma), (2) şüpheli hata anında
// bağımsız hedeflere kısa TCP denemesi — biri bile açılırsa internet var, hata sunucuya özgü.
import { connect } from 'net'

export type NetState = 'online' | 'offline'

const PROBES: [string, number][] = [
  ['1.1.1.1', 443],
  ['8.8.8.8', 443],
  ['9.9.9.9', 443]
]

export interface ConnectivityDeps {
  now(): number
  /** tek bir TCP bağlantı denemesi (el sıkışma yeter, veri gönderilmez) */
  tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean>
}

const defaultDeps: ConnectivityDeps = {
  now: Date.now,
  tcpProbe: (host, port, timeoutMs) =>
    new Promise((resolve) => {
      const s = connect({ host, port })
      const done = (ok: boolean) => {
        clearTimeout(t)
        s.destroy()
        resolve(ok)
      }
      const t = setTimeout(() => done(false), timeoutMs)
      s.once('connect', () => done(true))
      s.once('error', () => done(false))
    })
}

export class Connectivity {
  private osOnline = true
  private wakeUntil = 0
  private probe: { at: number; ok: boolean; running: Promise<boolean> | null } = { at: 0, ok: true, running: null }
  private listeners = new Set<(s: NetState) => void>()
  private last: NetState = 'online'

  constructor(private deps: ConnectivityDeps = defaultDeps) {}

  /** main'den: işletim sistemi ağ durumu */
  setOsOnline(online: boolean): void {
    this.osOnline = online
    if (online) this.probe = { at: 0, ok: true, running: null } // eski "yok" sonucunu unut
    this.emit()
  }

  /** main'den: uykudan uyanış — ağ arayüzü birkaç saniye geç gelir; bu sürede hatalar sunucuya yazılmaz */
  onResume(graceMs = 20_000): void {
    this.wakeUntil = this.deps.now() + graceMs
    this.probe = { at: 0, ok: true, running: null }
  }

  /** Hızlı, ağa çıkmayan tahmin: bağlantı kurmayı hiç denememek için (tick) */
  get state(): NetState {
    return this.osOnline && this.probe.ok ? 'online' : 'offline'
  }

  inWakeGrace(): boolean {
    return this.deps.now() < this.wakeUntil
  }

  /**
   * Bir bağlantı hatası sunucuya mı ait, yoksa internet mi yok? İşletim sistemi "yok" diyorsa ya da
   * bağımsız hedeflerin hiçbirine ulaşılamıyorsa false (= internet yok). Sonuç 15 sn önbellekli.
   */
  async verifyOnline(): Promise<boolean> {
    if (!this.osOnline) return false
    const t = this.deps.now()
    if (this.probe.running) return this.probe.running
    if (t - this.probe.at < 15_000) return this.probe.ok
    const running = Promise.all(PROBES.map(([h, p]) => this.deps.tcpProbe(h, p, 3000).catch(() => false))).then((r) => r.some(Boolean))
    this.probe = { at: this.probe.at, ok: this.probe.ok, running }
    const ok = await running
    this.probe = { at: this.deps.now(), ok, running: null }
    this.emit()
    return ok
  }

  onChange(cb: (s: NetState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    const s = this.state
    if (s === this.last) return
    this.last = s
    for (const cb of this.listeners) cb(s)
  }
}
