// Alma hattı: imza değerlendirme, imzalı iletinin saklanması, kullanıcı başına çözüm ve sertifika toplama.
// Görünüm yalnız openSmime'in `entity` baytlarından kurulur; ham iletiden kurulmaz.
import PostalMime from 'postal-mime'
import type { MessageRow } from '../../shared/rpc'
import { htmlToText } from '../../shared/searchQuery'
import { worstSig, type SmimeInfo, type SmimeKind, type SmimeNote, type SmimeSigner, type SmimeSigState } from '../../shared/smime'
import type { Queries } from '../db/queries'
import type { RpcServerDeps } from '../rpcHub'
import { parseCert, sameAddress, type ParsedCert } from './certInfo'
import type { SigResult } from './cms'
import type { DecryptedBody } from './decryptCache'
import { encodeChain, loadDecryptKeys } from './identity'
import { classifyRaw, fromHeaders } from './mime'
import { openSmime, type SigEvaluator } from './open'
import type { CrlCache } from './revocation'
import { evaluateChain, type TrustStore } from './trust'

const EMPTY = Buffer.alloc(0)
const WEAK_HASHES = new Set(['md5', 'sha1'])
const TRUST_NOTES = new Set<SmimeNote>(['self_signed', 'cert_expired_since', 'revocation_unknown'])
const VERDICT_TTL_MS = 3_600_000
const VERDICT_KEEP = 2000

function signerOf(c: ParsedCert): SmimeSigner {
  return { email: c.emails[0] ?? null, subject: c.subject, issuer: c.issuer, fingerprint: c.fingerprint, notBefore: c.notBefore, notAfter: c.notAfter }
}

export function makeEvaluator(deps: { store: TrustStore; crl: CrlCache; now?: () => number }): SigEvaluator {
  return async (r, ctx) => {
    if (!r.signer) return { sig: 'unsupported', notes: [], signer: null, canSaveCert: false }
    const c = parseCert(r.signer)
    const v = await evaluateChain({ leaf: r.signer, extra: r.certs, at: ctx.at, purpose: 'sign' }, deps.store, deps.crl, deps.now)
    const notes: SmimeNote[] = []
    if (v.selfSigned) notes.push('self_signed')
    if (v.expiredSince) notes.push('cert_expired_since')
    if (v.revocation === 'unknown') notes.push('revocation_unknown')
    const addressOk = ctx.from !== null && c.emails.some((e) => sameAddress(e, ctx.from as string))
    const sig: SmimeSigState =
      v.state === 'ok' ? (addressOk ? 'verified' : 'address_mismatch') : v.state === 'weak' ? 'weak_algorithm' : v.state
    return { sig, notes, signer: signerOf(c), canSaveCert: addressOk && sig === 'untrusted' }
  }
}

/** Güven deposu kurulmamışsa kapalı başarısızlık: hiçbir imza doğrulanmış sayılmaz */
const closedEvaluator: SigEvaluator = async (r) => ({
  sig: r.signer ? 'untrusted' : 'unsupported', notes: ['revocation_unknown'], signer: r.signer ? signerOf(parseCert(r.signer)) : null, canSaveCert: false
})

export function evaluatorFor(deps: Pick<RpcServerDeps, 'smimeTrust' | 'smimeCrl'>): SigEvaluator {
  return deps.smimeTrust && deps.smimeCrl ? makeEvaluator({ store: deps.smimeTrust, crl: deps.smimeCrl }) : closedEvaluator
}

export const closedSmimeEvaluator = closedEvaluator

interface StoredSigner {
  signer: string
  certs: string[]
  hashAlg: string
  capabilities: string[]
}

/** message_smime satırı: durum + güveni yeniden değerlendirmek için imzacı kanıtı. Kanıt istemciye gitmez. */
export interface StoredSmime extends SmimeInfo {
  evidence?: { from: string | null; at: number; signers: StoredSigner[] }
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

function restoreSigner(s: StoredSigner): SigResult {
  return { valid: true, unsupported: false, hashAlg: s.hashAlg, sigAlg: '', signer: unb64(s.signer), certs: s.certs.map(unb64), capabilities: s.capabilities }
}

function evidenceOf(raw: Buffer, at: number, signers: SigResult[]): StoredSmime['evidence'] {
  const kept = signers.filter((r) => r.signer).map((r) => ({ signer: b64(r.signer as Uint8Array), certs: r.certs.map(b64), hashAlg: r.hashAlg, capabilities: r.capabilities }))
  return kept.length ? { from: fromHeaders(raw).single, at, signers: kept } : undefined
}

const unsupportedInfo = (notes: SmimeNote[] = []): SmimeInfo => ({ sig: 'unsupported', enc: 'none', notes, signer: null, canSaveCert: false })

export function markUnsupported(q: Queries, id: number, notes: SmimeNote[] = []): void {
  q.setMessageSmime(id, unsupportedInfo(notes))
}

export function isEncryptedRoot(raw: Buffer): boolean {
  const root = classifyRaw(raw)
  return root === 'enveloped' || root === 'auth_enveloped'
}

/** İmzalı kök: durum saklanır, görünüm yalnız imzalı baytlardır. null: eski görünüm (S/MIME değil veya içerik çıkarılamadı).
 *  İmzanın içinde şifreli gövde varsa `nestedEncrypted`: çağıran diske hiçbir şey yazmaz. */
export async function processSignedFetch(
  q: Queries, msg: MessageRow, raw: Buffer, internalDate: number, evaluate: SigEvaluator
): Promise<{ signedEntity: Buffer; nestedEncrypted: boolean } | null> {
  const root = classifyRaw(raw)
  if (root === 'none') return null
  if (root === 'ambiguous' || root === 'compressed') {
    markUnsupported(q, msg.id)
    return null
  }
  const seen: SigResult[] = []
  const r = await openSmime(raw, {
    keys: () => 'locked', // burada çözüm yok: anahtar kişiye aittir
    at: internalDate,
    evaluate: (x, ctx) => {
      seen.push(x)
      return evaluate(x, ctx)
    }
  })
  if (r.info.enc !== 'none') return { signedEntity: EMPTY, nestedEncrypted: true }
  // imzalı varlık boşsa görünüm tam ham iletiden kurulur: imzanın kapsamadığı içerik "doğrulandı" diyemez
  const stored: StoredSmime = r.entity.length ? { ...r.info, evidence: evidenceOf(raw, internalDate, seen) } : { ...r.info, sig: 'unsupported', canSaveCert: false }
  q.setMessageSmime(msg.id, stored)
  q.setSmimeKind(msg.id, 'signed' satisfies SmimeKind)
  return r.entity.length ? { signedEntity: r.entity, nestedEncrypted: false } : null
}

interface Verdict {
  info: SmimeInfo
  harvest: SigResult | null
  expires: number
}

/** İmzalı iletinin güven kararı saklı kalmaz: CRL gelince, kök eklenince, sertifikanın süresi dolunca değişir.
 *  Anahtar ileti + imzacı + CRL sürümüdür, 1 saat bellekte kalır. */
export class SignedVerdicts {
  private readonly cache = new Map<string, Verdict>()

  constructor(private readonly now: () => number = Date.now) {}

  private key(deps: Pick<RpcServerDeps, 'q'>, messageId: number, signers: SigResult[]): string {
    const parts = signers.flatMap((r) => {
      const c = parseCert(r.signer as Uint8Array)
      return [c.fingerprint, ...c.crlUrls.map((u) => {
        const row = deps.q.getCrl(u)
        return `${row?.next_update ?? 0}:${row?.fetched_at ?? 0}`
      })]
    })
    // kök eklenip kaldırılınca sonuç hemen değişir
    return `${messageId}|${parts.join('|')}|${deps.q.listAnchors().map((a) => a.fingerprint).join(',')}`
  }

  async current(deps: Pick<RpcServerDeps, 'q' | 'smimeTrust' | 'smimeCrl'>, messageId: number, stored: StoredSmime): Promise<{ info: SmimeInfo; harvest: SigResult | null }> {
    const { evidence, ...info } = stored
    if (!evidence || info.sig === 'invalid' || info.sig === 'unsupported') return { info, harvest: null }
    const signers = evidence.signers.map(restoreSigner)
    const key = this.key(deps, messageId, signers)
    const hit = this.cache.get(key)
    if (hit && this.now() < hit.expires) return hit

    const evaluate = evaluatorFor(deps)
    const notes = new Set<SmimeNote>(info.notes.filter((n) => !TRUST_NOTES.has(n)))
    const sigs: SmimeSigState[] = []
    let signer: SmimeSigner | null = null
    let canSaveCert = false
    let harvest: SigResult | null = null
    for (const r of signers) {
      const e = await evaluate(r, { from: evidence.from, at: evidence.at })
      const sig = e.sig === 'verified' && WEAK_HASHES.has(r.hashAlg) ? 'weak_algorithm' : e.sig
      sigs.push(sig)
      for (const n of e.notes) notes.add(n)
      signer ??= e.signer
      canSaveCert ||= e.canSaveCert
      if (sig === 'verified') harvest ??= r
    }
    const sig = worstSig(sigs)
    const v: Verdict = { info: { ...info, sig, notes: [...notes], signer, canSaveCert }, harvest: sig === 'verified' ? harvest : null, expires: this.now() + VERDICT_TTL_MS }
    if (this.cache.size >= VERDICT_KEEP) this.cache.clear()
    this.cache.set(key, v)
    return v
  }
}

/** Yalnız oturum sahibi açınca, yalnız `verified` imzadan: sahte From ile gelen sertifika sonraki şifreli postayı saldırgana açardı */
export function harvestContactCert(q: Queries, userId: number, msg: MessageRow, r: SigResult, capabilities: string[]): void {
  if (!r.signer || q.getAccountRow(msg.accountId)?.secure !== 0) return
  const c = parseCert(r.signer)
  const email = c.emails.find((e) => msg.fromAddr && sameAddress(e, msg.fromAddr))
  if (!email) return
  q.upsertContactCert({
    userId, email, fingerprint: c.fingerprint, certDer: Buffer.from(c.der), chainDer: encodeChain(r.certs.filter((d) => Buffer.compare(d, c.der) !== 0)),
    notAfter: c.notAfter, capabilities: capabilities.length ? JSON.stringify(capabilities) : null, source: 'auto'
  })
}

/** Kullanıcı açınca çalışır; arka plan çözümü yoktur. Sonuç RAM'de kalır, içerik diske inmez. */
export async function decryptForUser(deps: RpcServerDeps, userId: number, msg: MessageRow, raw: Buffer, internalDate: number): Promise<DecryptedBody> {
  const seen: SigResult[] = []
  const evaluate = evaluatorFor(deps)
  const opened = await openSmime(raw, {
    keys: () => loadDecryptKeys(deps.q, userId),
    at: internalDate,
    evaluate: (x, ctx) => {
      seen.push(x)
      return evaluate(x, ctx)
    }
  })
  const signers = seen.filter((r) => r.signer)
  if (!opened.entity.length) return { textPlain: null, html: null, attachments: [], info: opened.info, signers }

  const info = { ...opened.info }
  if (opened.harvest) {
    if (deps.q.getAccountRow(msg.accountId)?.secure === 0) harvestContactCert(deps.q, userId, msg, opened.harvest, opened.harvest.capabilities)
    else info.canSaveCert = true
  }
  const parsed = await PostalMime.parse(opened.entity)
  // kimliksiz CBC: gadget ile HTML enjekte edilebilir, istemci bu kararı geçemez
  const plain = info.notes.includes('unauthenticated')
  const body: DecryptedBody = {
    textPlain: plain ? (parsed.text ?? htmlToText(parsed.html ?? '')) : (parsed.text ?? null),
    html: plain ? null : (parsed.html ?? null),
    info,
    signers,
    attachments: (parsed.attachments ?? []).map((a, index) => ({
      index,
      filename: a.filename ?? null,
      mime: a.mimeType ?? null,
      contentId: a.contentId?.replace(/[<>]/g, '') ?? null,
      content: Buffer.from(a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : Buffer.from(String(a.content)))
    }))
  }
  opened.entity.fill(0)
  return body
}
