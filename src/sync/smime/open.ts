// İleti açma: yalnız kökteki S/MIME katmanları soyulur, en çok 3 katman. Görünüm yalnız imzalı veya şifreli baytlardan
// kurulur (`entity`), dış parça eklenmez. Güven kararı SigEvaluator ile dışarıdan gelir; matematiksel geçerlilik burada.
import { worstSig, type SmimeEncState, type SmimeInfo, type SmimeNote, type SmimeSigner, type SmimeSigState } from '../../shared/smime'
import { sameAddress } from './certInfo'
import { decryptEnveloped, verifySignedData, type DecryptKey, type SigResult } from './cms'
import { SmimeNoKeyError, SmimeUnsupportedError } from './errors'
import { addressList, canonicalizeCrlf, classifyRaw, contentTypeOf, decodeWords, entityBody, fromHeaders, headerValue, pkcs7Der, splitMultipartSigned } from './mime'

const MAX_LAYERS = 3
const WEAK_HASHES = new Set(['md5', 'sha1'])
const EMPTY = Buffer.alloc(0)

export type SigEvaluator = (
  r: SigResult,
  ctx: { from: string | null; at: number }
) => Promise<{ sig: SmimeSigState; notes: SmimeNote[]; signer: SmimeSigner | null; canSaveCert: boolean }>

export interface OpenResult {
  entity: Buffer
  info: SmimeInfo
  /** alıcı sertifikası adayı: yalnız `verified` imzadan */
  harvest: SigResult | null
}

export interface OpenOptions {
  keys: () => DecryptKey[] | 'locked'
  evaluate: SigEvaluator
  /** doğrulama anı: IMAP INTERNALDATE */
  at: number
}

interface State {
  sigs: SmimeSigState[]
  enc: SmimeEncState
  notes: Set<SmimeNote>
  signer: SmimeSigner | null
  canSaveCert: boolean
  harvest: SigResult | null
  /** son şifre çözümünden sonra bütünlük kanıtı: AEAD ya da içteki geçerli imza */
  authed: boolean
}

function info(s: State): SmimeInfo {
  return { sig: worstSig(s.sigs), enc: s.enc, notes: [...s.notes], signer: s.signer, canSaveCert: s.canSaveCert }
}

async function recordResults(results: SigResult[], s: State, o: OpenOptions, from: string | null): Promise<void> {
  if (!results.length) s.sigs.push('unsupported') // imzacısız SignedData sertifika taşır, imza değildir
  // imza yalnız altındaki baytları kanıtlar: dış imza şifreli metni kaplar, çözülen düz metni değil. Çözüm durumu sıfırladığı
  // için bu satırın etkisi ancak son çözümden sonra kalır.
  if (results.length && results.every((r) => r.valid && !r.unsupported)) s.authed = true
  for (const r of results) {
    if (r.unsupported || !r.valid) {
      s.sigs.push(r.unsupported ? 'unsupported' : 'invalid')
      continue
    }
    const e = await o.evaluate(r, { from, at: o.at })
    const sig = e.sig === 'verified' && WEAK_HASHES.has(r.hashAlg) ? 'weak_algorithm' : e.sig
    s.sigs.push(sig)
    for (const n of e.notes) s.notes.add(n)
    s.signer ??= e.signer
    s.canSaveCert ||= e.canSaveCert
    if (sig === 'verified') s.harvest ??= r
  }
}

const sigErrorState = (e: unknown): SmimeSigState => (e instanceof SmimeUnsupportedError ? 'unsupported' : 'invalid')

/** İmza kanonik CRLF üzerindedir; yalnız LF ile saklanmış ileti ikinci denemede doğrulanır */
async function verifyDetached(der: Buffer, signed: Buffer): Promise<SigResult[]> {
  const { results } = await verifySignedData(der, signed)
  if (results.every((r) => r.valid)) return results
  const canonical = canonicalizeCrlf(signed)
  return canonical.equals(signed) ? results : (await verifySignedData(der, canonical)).results
}

/** Çözülen bayt MIME varlığı olmalı: içerik dolgusu şans eseri tutmuş olabilir (K3) */
function looksLikeMime(b: Buffer): boolean {
  const head = b.subarray(0, 2048).toString('latin1')
  return /^(\r?\n|[!-9;-~]+:)/.test(head)
}

function normalizedTo(v: string): string {
  return (addressList(decodeWords(v)) ?? [v]).map((a) => a.toLowerCase()).sort().join(',')
}

function headersDiffer(raw: Buffer, inner: Buffer): boolean {
  const outer = fromHeaders(raw)
  const i = fromHeaders(inner)
  if (headerValue(inner, 'from') !== null && !(i.single && outer.single && sameAddress(i.single, outer.single))) return true
  if (i.subject !== null && decodeWords(i.subject).trim() !== decodeWords(outer.subject ?? '').trim()) return true
  return i.to !== null && normalizedTo(i.to) !== normalizedTo(outer.to ?? '')
}

export async function openSmime(raw: Buffer, o: OpenOptions): Promise<OpenResult> {
  const s: State = { sigs: [], enc: 'none', notes: new Set(), signer: null, canSaveCert: false, harvest: null, authed: false }
  const from = fromHeaders(raw).single
  const finish = (entity: Buffer): OpenResult => {
    const result = info(s)
    return { entity, info: result, harvest: result.sig === 'verified' ? s.harvest : null } // başka imza veya katman kötüyse toplanmaz
  }
  const stop = (): OpenResult => finish(EMPTY)
  let cur = raw
  let layers = 0

  for (let kind = classifyRaw(cur); kind !== 'none'; kind = classifyRaw(cur)) {
    const encrypted = kind === 'enveloped' || kind === 'auth_enveloped'
    if (++layers > MAX_LAYERS || kind === 'ambiguous' || kind === 'compressed') {
      if (encrypted) s.enc = 'unsupported'
      else s.sigs.push('unsupported')
      return stop()
    }

    if (kind === 'multipart_signed') {
      const split = splitMultipartSigned(cur)
      if (!split) {
        s.sigs.push('unsupported')
        return stop()
      }
      try {
        await recordResults(await verifyDetached(pkcs7Der(split.signature), split.signed), s, o, from)
      } catch (e) {
        s.sigs.push(sigErrorState(e))
      }
      cur = split.signed
      continue
    }

    if (kind === 'opaque_signed') {
      try {
        const { results, content } = await verifySignedData(pkcs7Der(cur), null)
        await recordResults(results, s, o, from)
        if (!content) return stop()
        cur = content
      } catch (e) {
        s.sigs.push(sigErrorState(e))
        return stop()
      }
      continue
    }

    const keys = o.keys()
    if (keys === 'locked') {
      s.enc = 'locked'
      return stop()
    }
    try {
      const r = decryptEnveloped(pkcs7Der(cur), keys)
      if (!looksLikeMime(r.content)) throw new Error('not_mime')
      s.enc = 'decrypted'
      s.authed = r.aead // öncekiler bu baytlar için hükümsüz: dış AEAD içteki CBC zarfını kanıtlamaz
      if (r.cipher === '3des' || r.cipher === 'rc2') s.notes.add('weak_cipher')
      cur = r.content
    } catch (e) {
      s.enc = e instanceof SmimeNoKeyError ? 'no_key' : e instanceof SmimeUnsupportedError ? 'unsupported' : 'failed'
      return stop()
    }
  }

  if (layers === 0) return { entity: raw, info: info(s), harvest: null }

  // sarmalı iletide korunan başlıklar içteki iletidir
  const wrapped = contentTypeOf(cur) === 'message/rfc822'
  const entity = wrapped ? Buffer.from(entityBody(cur)) : cur
  if (headersDiffer(raw, entity)) s.notes.add('header_mismatch')

  // kimliksiz CBC: CBC gadget ile içerik değiştirilebilir, son çözümden sonra AEAD veya geçerli imza yoksa bütünlük kanıtlanmaz
  if (s.enc === 'decrypted' && !s.authed) s.notes.add('unauthenticated')
  return finish(entity)
}
