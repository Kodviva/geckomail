// Dilimler arası paylaşılan, render'a girmeyen oturum durumu.
export const runtime = {
  /** takip sayacı oturumda bir kez çekilir; sonrası followups:changed olayıyla */
  followupPrimed: false,
  /** web: sync:hello'su işlenmiş kullanıcı — aynı kullanıcının sonraki hello'su yeniden bağlanıştır */
  helloUserId: null as number | null,
  /** web: kendi çıkışımız sürüyor (sunucunun 4401 kapatması "oturum sona erdi" sayılmaz) */
  loggingOut: false,
  /** web: 2FA kapatma isteği gitti — sunucunun oturumları kapatması "oturum sona erdi" sayılmaz */
  twoFactorOff: false,
  /** web: son çevrimdışı eşitleme turu (ms) */
  offlineLastSync: 0,
  /** web: kopyalanabilir (görünür, kasa dışı) hesaplar; daralınca kopya temizlenir */
  offlineVisible: null as Set<number> | null,
  offlinePimScope: null as string | null
}
