// Sunucu süreci için EngineHost: sırlar ana anahtar dosyasıyla, bildirimler oturumlara RPC ile gider.
import type { RpcHub } from '../../sync/rpcHub'
import type { EngineHost } from '../../sync/host'
import { hasSealPrefix, openWithKey, sealWithKey } from '../keyfile'

/** onFatal: komut satırı ölümcül çıkış kodunu (3) seçebilsin diye */
export function createServerHost(key: Buffer, hub: () => RpcHub | null, onFatal?: () => void): EngineHost {
  return {
    async encrypt(values) {
      return values.map((v) => sealWithKey(key, Buffer.from(v, 'utf-8')))
    },
    async decrypt(blobs) {
      // GKS1 öneki yok (masaüstünden kopyalanmış safeStorage blob'u) ya da bozuk blob: sunucuda çözülemez → boş dize
      // (motor o hesabı "parola gerekli" durumuna alır). Tek bozuk blob diğer hesapları düşürmesin diye blob başına.
      return blobs.map((b) => {
        if (!hasSealPrefix(b)) return new Uint8Array(0)
        try {
          return openWithKey(key, b)
        } catch (e) {
          console.error(`gecko: parola blob'u çözülemedi (${(e as Error).message})`) // yalnız hata kodu
          return new Uint8Array(0)
        }
      })
    },
    // ana makine düzeyi bildirim (kullanıcıya özel kural yok): girişli tüm oturumlar
    notify(n) {
      hub()?.notifySessions(n, () => true)
    },
    badge() {},
    fatal(message) {
      console.error(`gecko: ölümcül hata — ${message}`)
      process.exitCode = 3
      onFatal?.()
    }
  }
}
