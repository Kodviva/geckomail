// Kasa anahtarının tek-süreç tek-örnek tutucusu. YALNIZCA sync sürecinde yaşar;
// renderer'a asla gitmez, diske asla yazılmaz. Kilit/çıkışta sıfırlanır.
// Modül-singleton — "tek vault / tek süreç" gerçeğine oturuyor, DI'ye gerek yok.
let vaultKey: Buffer | null = null
const lockListeners = new Set<() => void>()

export function getVaultKey(): Buffer | null {
  return vaultKey
}

export function setVaultKey(key: Buffer | null): void {
  if (vaultKey && vaultKey !== key) vaultKey.fill(0) // eski anahtarı bellekte üzerine yaz
  vaultKey = key
  if (key !== null) return
  for (const cb of lockListeners) {
    try {
      cb()
    } catch (e) {
      console.warn('kasa kilit dinleyicisi başarısız', (e as Error).name) // kilit durmaz; ileti düz metin taşıyabilir
    }
  }
}

/** setVaultKey(null) çağrısında tetiklenir (şifresi çözülmüş önbellekler burada silinir). Dönen işlev aboneliği kaldırır. */
export function onVaultLock(cb: () => void): () => void {
  lockListeners.add(cb)
  return () => lockListeners.delete(cb)
}

export function isVaultUnlocked(): boolean {
  return vaultKey !== null
}
