import type { Queries } from '../db/queries'

// Touch ID ile giriş: kullanıcının giriş şifresi safeStorage (macOS Keychain) ile şifrelenip
// prefs'te saklanır; girişte renderer Touch ID sorar, başarıda blob çözülüp şifreyle login yapılır.
// Kasa-biyometrisiyle aynı kolaylık/güvenlik dengesi: uygulama-seviyesi giriş içindir, mail
// şifrelemesi (kasa) ayrıdır. [[geckomail-project]]
const FLAG = 'login_bio_flag'
const USER = 'login_bio_user'
const BLOB = 'login_bio_blob' // giriş şifresinin safeStorage-şifreli hali (base64)

// Etkinse Touch ID girişinin bağlı olduğu kullanıcı adı (Login ekranında gösterilir), yoksa null.
export function loginBiometricUser(q: Queries): string | null {
  return q.prefGet(FLAG) === '1' && q.prefGet(BLOB) ? (q.prefGet(USER) ?? null) : null
}

export function setLoginBiometric(q: Queries, username: string, blobB64: string): void {
  q.prefSet(USER, username)
  q.prefSet(BLOB, blobB64)
  q.prefSet(FLAG, '1')
}

export function getLoginBiometricBlob(q: Queries): string | null {
  return q.prefGet(FLAG) === '1' ? (q.prefGet(BLOB) ?? null) : null
}

export function clearLoginBiometric(q: Queries): void {
  q.prefSet(FLAG, '0')
  q.prefSet(BLOB, '')
  q.prefSet(USER, '')
}
