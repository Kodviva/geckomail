// Pahalı parola türetmeleri (kasa scrypt 64 MB, .p12 KDF) aynı sınırı paylaşır: birikmiş istekler belleği ve iş parçacıklarını tüketmesin.
const MAX_ACTIVE = 2

let active = 0
const waiting: (() => void)[] = []

export async function withKdfSlot<T>(fn: () => T | Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) await new Promise<void>((r) => waiting.push(r))
  else active++
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next() // sıra devredilir, sayaç değişmez
    else active--
  }
}
