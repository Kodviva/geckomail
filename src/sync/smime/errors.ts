// S/MIME hata türleri. İletiler sabit koddur: pkijs veya OpenSSL metni, anahtar ve parola dışarı sızmasın.
// Kullanıcıya gösterilecek metni RPC katmanı t() ile üretir.
export class SmimeFormatError extends Error {
  constructor() {
    super('smime_format')
    this.name = 'SmimeFormatError'
  }
}

export class SmimeNoKeyError extends Error {
  constructor() {
    super('smime_no_key')
    this.name = 'SmimeNoKeyError'
  }
}

export class SmimeUnsupportedError extends Error {
  constructor() {
    super('smime_unsupported')
    this.name = 'SmimeUnsupportedError'
  }
}

export class SmimeP12PasswordError extends Error {
  constructor() {
    super('smime_p12_password')
    this.name = 'SmimeP12PasswordError'
  }
}

export class SmimeLockedError extends Error {
  constructor() {
    super('smime_locked')
    this.name = 'SmimeLockedError'
  }
}

export class SmimeNoIdentityError extends Error {
  constructor() {
    super('smime_no_identity')
    this.name = 'SmimeNoIdentityError'
  }
}

/** Alıcı veya gönderen sertifikası gönderime uygun değil: yeniden denemek çözmez */
export class SmimeBlockedError extends Error {
  constructor() {
    super('smime_blocked')
    this.name = 'SmimeBlockedError'
  }
}

/** Alıcının iptal listesi saklı ama kümesi henüz yazılmadı: geçici, gönderim bekler, başarısız sayılmaz */
export class SmimePendingError extends Error {
  constructor() {
    super('smime_pending')
    this.name = 'SmimePendingError'
  }
}
