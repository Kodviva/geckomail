// Şifreli gönderimin kuyruktaki ekleri. Yerinde mühürlenir: yeni dosya önce yazılır, ad değiştirilir. Eski blokların dosya
// sisteminden silinmesi garanti değildir (kullanıcı belgelerinde sınır olarak yazılı).
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { decrypt, encrypt } from '../vault/crypto'
import { getVaultKey } from '../vault/state'
import { SmimeLockedError } from './errors'

export function sealFile(path: string): void {
  const key = getVaultKey()
  if (!key) throw new SmimeLockedError()
  const plain = readFileSync(path)
  const tmp = `${path}.seal`
  try {
    writeFileSync(tmp, encrypt(key, plain), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  } finally {
    plain.fill(0)
  }
}

export function readSealed(path: string): Buffer {
  const key = getVaultKey()
  if (!key) throw new SmimeLockedError()
  return decrypt(key, readFileSync(path))
}
