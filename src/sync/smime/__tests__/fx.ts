// Fikstür yardımcısı: PEM/DER okuma. Yalnız testler kullanır.
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const fxPath = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
export const fxBytes = (name: string): Buffer => readFileSync(fxPath(name))

export function certDer(name: string): Buffer {
  return Buffer.from(new X509Certificate(fxBytes(`${name}.crt`)).raw)
}

/** deep-chain.pem gibi çok sertifikalı PEM */
export function pemCerts(name: string): Buffer[] {
  return (fxBytes(name).toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((p) => Buffer.from(new X509Certificate(p).raw))
}

export const AT = Date.UTC(2030, 0, 1)
