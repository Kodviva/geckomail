// Çalışma zamanı özdenetimi: CI Node + OpenSSL'de, sunucu Node 22'de, masaüstü BoringSSL'de çalışır.
// Aynı kod farklı şifre kümesi görür; burada eksik olan bir yetenek üretimde sessizce değil, imaj
// hattında veya smoke'ta yüksek sesle düşer (eski Node 22'de RSA_PKCS1_PADDING ERR_INVALID_ARG_VALUE atar).
import { constants, createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, webcrypto, type KeyObject } from 'node:crypto'
import { Integer, PrintableString } from 'asn1js'
import { AttributeTypeAndValue, Certificate } from 'pkijs'
import { ensurePkiEngine } from './engine'
import { pkcs12Kdf, pkcs12KdfInWorker } from './p12'

function roundTripRsa(publicKey: KeyObject, privateKey: KeyObject): void {
  const secret = randomBytes(32)
  const modes = [{ padding: constants.RSA_PKCS1_PADDING }, { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }]
  for (const mode of modes) {
    const out = privateDecrypt({ key: privateKey, ...mode }, publicEncrypt({ key: publicKey, ...mode }, secret))
    if (!out.equals(secret)) throw new Error(`smime selftest: rsa padding ${mode.padding}`)
  }
}

function roundTripCipher(name: string, keyLen: number, ivLen: number): void {
  const key = randomBytes(keyLen)
  const iv = randomBytes(ivLen)
  const plain = randomBytes(40)
  const enc = createCipheriv(name, key, iv)
  const ct = Buffer.concat([enc.update(plain), enc.final()])
  const dec = createDecipheriv(name, key, iv)
  if (!Buffer.concat([dec.update(ct), dec.final()]).equals(plain)) throw new Error(`smime selftest: ${name}`)
}

async function pkiSignVerify(keys: { publicKey: CryptoKey; privateKey: CryptoKey }): Promise<void> {
  ensurePkiEngine()
  const cert = new Certificate()
  cert.version = 2
  cert.serialNumber = new Integer({ value: 1 })
  const name = new AttributeTypeAndValue({ type: '2.5.4.3', value: new PrintableString({ value: 'selftest' }) })
  cert.issuer.typesAndValues.push(name)
  cert.subject.typesAndValues.push(name)
  cert.notBefore.value = new Date(0)
  cert.notAfter.value = new Date(86_400_000)
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey)
  await cert.sign(keys.privateKey, 'SHA-256')
  if (!(await cert.verify())) throw new Error('smime selftest: pkijs verify')
}

export async function smimeSelfTest(): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  roundTripRsa(publicKey, privateKey)
  roundTripCipher('aes-256-cbc', 32, 16)
  roundTripCipher('des-ede3-cbc', 24, 8)
  const kdfSalt = randomBytes(8)
  if (!(await pkcs12KdfInWorker('sha1', 'selftest', kdfSalt, 16, 1, 24)).equals(pkcs12Kdf('sha1', 'selftest', kdfSalt, 16, 1, 24))) throw new Error('smime selftest: pkcs12 worker')
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
  await pkiSignVerify({
    publicKey: (await webcrypto.subtle.importKey('spki', publicKey.export({ type: 'spki', format: 'der' }), alg, true, ['verify'])) as unknown as CryptoKey,
    privateKey: (await webcrypto.subtle.importKey('pkcs8', privateKey.export({ type: 'pkcs8', format: 'der' }), alg, false, ['sign'])) as unknown as CryptoKey
  })
}
