// CRL önbelleği. OCSP bilinçli olarak yok: her sorgu CA'ya "bu kişinin postası şimdi okunuyor" derdi. Liste toplu
// çekildiği için CA hangi ileti olduğunu öğrenmez. Çekim açılışa bağlı değildir: eksik liste kuyruğa girer, sonuç
// bir sonraki açılışta güncellenir. Yumuşak başarısızlık: çekilemezse doğrulama sürer, not `revocation_unknown` olur.
import { createHash, X509Certificate } from 'node:crypto'
import { IssuingDistributionPoint, type GeneralName } from 'pkijs'
import type { Queries } from '../db/queries'
import type { SmimeCrlRow } from '../db/q/types'
import { safeFetch } from '../net/safeFetch'
import { parseFailed, type ParsedCert } from './certInfo'
import { parseCrl, type StoredCrl } from './crl'

const RETRY_MS = 6 * 3_600_000
const NO_NEXT_UPDATE_TTL_MS = 24 * 3_600_000
const IDP_OID = '2.5.29.28'
const DELTA_OID = '2.5.29.27'
const FETCH_LIMITS = { timeoutMs: 15_000, maxBytes: 10_000_000, maxRedirects: 2 }
const PARSED_KEEP = 8
/** Motor HTTP ve IMAP ile aynı iş parçacığında: bundan büyük liste gönderim ve doğrulama yolunda ayrıştırılmaz, drain'e bırakılır */
const INLINE_PARSE_BYTES = 256_000

async function defaultFetch(url: string): Promise<Buffer> {
  const res = await safeFetch(url, FETCH_LIMITS)
  if (!res.ok) throw new Error(`crl_http_${res.status}`)
  return res.body
}

/** Liste kapsamı. Bölümlü, nedenli, dolaylı veya delta liste "iptal değil" kanıtı olamaz: aynı CA'nın başka geçerli bölümü araya
 *  sokulup iptal gizlenebilirdi. Kapsam kümeyle saklanır, gönderim yolu listeyi okumadan karar verir. */
interface CrlScope {
  usable: boolean
  userOnly?: boolean
  caOnly?: boolean
  /** null: tüm kapsam; dizi: yalnız bu adreslerden yayımlanan sertifikalar */
  names?: string[] | null
}

const UNUSABLE: CrlScope = { usable: false }

function scopeOf(s: StoredCrl): CrlScope {
  const ext = s.info.crlExtensions?.extensions ?? []
  if (ext.some((x) => x.extnID === DELTA_OID || (x.critical && x.extnID !== IDP_OID))) return UNUSABLE
  const idp = ext.find((x) => x.extnID === IDP_OID)
  if (!idp) return { usable: true, names: null }
  const v = idp.parsedValue as unknown
  if (!(v instanceof IssuingDistributionPoint) || parseFailed(v)) return UNUSABLE
  if (v.indirectCRL || v.onlySomeReasons !== undefined || v.onlyContainsAttributeCerts) return UNUSABLE
  const scope = { usable: true, userOnly: !!v.onlyContainsUserCerts, caOnly: !!v.onlyContainsCACerts }
  if (v.distributionPoint === undefined) return { ...scope, names: null }
  if (!Array.isArray(v.distributionPoint)) return UNUSABLE
  return { ...scope, names: (v.distributionPoint as GeneralName[]).filter((n) => n.type === 6).map((n) => String(n.value)) }
}

function scopeCovers(s: CrlScope, c: ParsedCert): boolean {
  if (!s.usable || (s.userOnly && c.ca) || (s.caOnly && !c.ca)) return false
  return !s.names || s.names.some((n) => c.crlUrls.includes(n))
}

/** Her ret sonucu `unknown` yapar, `good` asla. */
const listCovers = (s: StoredCrl, c: ParsedCert): boolean => s.info.issuer.isEqual(c.cert.issuer) && scopeCovers(scopeOf(s), c)

interface ParsedEntry {
  version: number
  crl: StoredCrl
  /** imzası doğrulanmış yayımcı parmak izleri; WebCrypto doğrulaması her açılışta yinelenmesin */
  verifiedBy: Set<string>
}

/** Bellekteki taraf. `wanted` drain'i bekleyen büyük listeler, `sets` kümesi yazılacak listeler ve yayımcıları, `building` kümesi yazılan
 *  adresler (kilit), `rejected` imzası bu yayımcıyla tutmayan anahtarlar, `kick` drain'i uyandırır */
interface ParsedLists {
  entries: Map<string, ParsedEntry>
  wanted: Set<string>
  sets: Map<string, ParsedCert>
  building: Set<string>
  rejected: Set<string>
  kick?: () => void
  /** ayrıştırılamayan sürümler: her denetimde yeniden denenmez */
  bad: Map<string, number>
}
const parsedLists = new WeakMap<Queries, ParsedLists>()

function listsOf(q: Queries): ParsedLists {
  let s = parsedLists.get(q)
  if (!s) parsedLists.set(q, (s = { entries: new Map(), wanted: new Set(), sets: new Map(), building: new Set(), rejected: new Set(), bad: new Map() }))
  return s
}

function parseInto(s: ParsedLists, url: string, version: number, der: Buffer, ready?: StoredCrl): ParsedEntry | null {
  try {
    const e = { version, crl: ready ?? parseCrl(der), verifiedBy: new Set<string>() }
    s.entries.delete(url)
    if (s.entries.size >= PARSED_KEEP) s.entries.delete(s.entries.keys().next().value as string)
    s.entries.set(url, e)
    s.bad.delete(url)
    return e
  } catch {
    s.bad.set(url, version)
    return null
  }
}

/** Büyük liste burada asla ayrıştırılmaz: null döner, drain sıraya alır. Sonuç yumuşak başarısızlıktır, liste hiç yokmuş gibi sayılır */
function parsedList(q: Queries, url: string, row: SmimeCrlRow & { der: Buffer }): ParsedEntry | null {
  const s = listsOf(q)
  const version = row.fetched_at ?? 0
  const cached = s.entries.get(url)
  if (cached?.version === version) return cached
  if (s.bad.get(url) === version) return null
  if (row.der.length > INLINE_PARSE_BYTES) {
    s.wanted.add(url)
    return null
  }
  return parseInto(s, url, version, row.der)
}

export type StoredVerdict = 'revoked' | 'good' | 'pending'

const SERIAL_BATCH = 5_000
const REJECTED_KEEP = 256

/** Yayımcı kimliği: anahtar ve ad birlikte, çapraz imzalı aynı anahtar aynı sayılır */
function issuerId(issuer: ParsedCert): string {
  const spki = new X509Certificate(issuer.der).publicKey.export({ type: 'spki', format: 'der' })
  const subject = Buffer.from(issuer.cert.subject.toSchema().toBER(false))
  return createHash('sha256').update(spki).update(subject).digest('hex')
}

/** Küme yalnız aynı liste ve aynı yayımcı için geçerlidir */
const setKey = (derSha256: string, issuer: string): string => createHash('sha256').update(derSha256).update(issuer).digest('hex')

/** Yalnız imzası bu yayımcıyla doğrulanan liste. null: küme yazılmaz, var olan doğrulanmış kümeye dokunulmaz */
function verified(der: Buffer, issuer: ParsedCert): StoredCrl | null {
  try {
    const crl = parseCrl(der)
    return crl.info.issuer.isEqual(issuer.cert.subject) && crl.signatureOk(issuer) ? crl : null
  } catch {
    return null
  }
}

function reject(lists: ParsedLists, key: string): void {
  if (lists.rejected.size >= REJECTED_KEEP) lists.rejected.clear()
  lists.rejected.add(key)
}

function buildSetNow(q: Queries, lists: ParsedLists, url: string, issuer: ParsedCert, key: string): boolean {
  const crl = verified(q.getCrl(url)!.der as Buffer, issuer)
  if (!crl) {
    reject(lists, key)
    return false
  }
  const generation = q.nextCrlGeneration(url)
  q.addCrlSerials(url, generation, [...crl.serials()])
  q.commitCrlSet(url, generation, key, JSON.stringify(scopeOf(crl)))
  return true
}

/** Gönderim denetimi await içermez (sendMail): liste ayrıştırılmaz, saklı küme okunur. Bayat liste de sayılır: iptal kalıcıdır. Küme hazır
 *  değilse yanıt "iptal yok" olamaz: `pending` döner, gönderim bekler. Küçük liste burada hemen yazılır, büyüğü drain'e bırakılır, aynı
 *  adreste yazım sürerken yeni yazım başlamaz. */
export function storedRevocation(q: Queries, c: ParsedCert, issuer: ParsedCert): StoredVerdict {
  if (q.prefGet('smimeRevocation') === 'off') return 'good'
  const lists = listsOf(q)
  const id = issuerId(issuer)
  const serial = new Uint8Array(c.cert.serialNumber.valueBlock.valueHexView)
  let pending = false
  for (const url of c.crlUrls) {
    let st = q.crlSetState(url)
    if (!st?.size || !st.der_sha256) continue
    const key = setKey(st.der_sha256, id)
    if (st.set_key !== key) {
      if (lists.rejected.has(key)) continue // bu yayımcının listesi değil
      if (lists.building.has(url) || st.size > INLINE_PARSE_BYTES) {
        if (!lists.building.has(url)) {
          lists.sets.set(url, issuer)
          lists.kick?.()
        }
        pending = true
        continue
      }
      if (!buildSetNow(q, lists, url, issuer, key)) continue
      st = q.crlSetState(url)!
    }
    if (scopeCovers(JSON.parse(st.set_scope as string) as CrlScope, c) && q.crlSerialListed(url, st.set_generation as number, serial)) return 'revoked'
  }
  return pending ? 'pending' : 'good'
}

export interface CrlLists {
  fresh: StoredCrl[]
  stale: StoredCrl[]
}

export class CrlCache {
  private readonly q: Queries
  private readonly fetchUrl: (url: string) => Promise<Buffer>
  private readonly mode: () => 'crl' | 'off'
  private readonly now: () => number
  /** adres → listeyi imzalaması beklenen yayımcı */
  private readonly queue = new Map<string, ParsedCert>()
  private readonly lists: ParsedLists
  private draining = false
  private stopped = false

  constructor(o: { q: Queries; fetchUrl?: (url: string) => Promise<Buffer>; mode: () => 'crl' | 'off'; now?: () => number }) {
    this.q = o.q
    this.fetchUrl = o.fetchUrl ?? defaultFetch
    this.mode = o.mode
    this.now = o.now ?? Date.now
    this.lists = listsOf(o.q)
    this.lists.kick = () => {
      setImmediate(() => void this.drain().catch(() => {}))
    }
  }

  /** Süresi içinde mi? Tarih alanları imzasız satırdandır: yalnız imzası doğrulanmış liste için anlamlıdır. */
  private inWindow(r: SmimeCrlRow): boolean {
    if (r.this_update !== null && r.this_update > this.now()) return false
    return this.now() < (r.next_update ?? (r.fetched_at ?? 0) + NO_NEXT_UPDATE_TTL_MS)
  }

  private due(r: SmimeCrlRow | undefined): boolean {
    return this.now() - Math.max(r?.fetched_at ?? 0, r?.last_error_at ?? 0) >= RETRY_MS
  }

  /** İmzası `issuer` ile doğrulanmış, kapsamı sertifikayı içeren listeler. Eksik, bayat veya kullanılamayan adres kuyruğa girer;
   *  yanıt beklenmez. `stale` yalnız iptali görmek içindir: iptal kalıcıdır ama bayat liste "iptal değil" diyemez. */
  async forCert(c: ParsedCert, issuer: ParsedCert): Promise<CrlLists> {
    const out: CrlLists = { fresh: [], stale: [] }
    if (this.mode() === 'off') return out
    for (const url of c.crlUrls) {
      const row = this.q.getCrl(url)
      const e = row?.der ? parsedList(this.q, url, row as SmimeCrlRow & { der: Buffer }) : null
      const usable = !!e && this.usable(e, c, issuer)
      if (usable && e) (this.inWindow(row!) ? out.fresh : out.stale).push(e.crl)
      // yalnız ayrıştırılmayı bekleyen liste yeniden çekilmez
      const parsing = !!row?.der && !e && this.lists.wanted.has(url)
      if (!parsing && (!usable || !this.inWindow(row!)) && this.due(row)) this.queue.set(url, issuer)
    }
    return out
  }

  private usable(e: ParsedEntry, c: ParsedCert, issuer: ParsedCert): boolean {
    if (!listCovers(e.crl, c)) return false
    if (e.verifiedBy.has(issuer.fingerprint)) return true
    if (!e.crl.signatureOk(issuer)) return false
    e.verifiedBy.add(issuer.fingerprint)
    return true
  }

  /** Bu sertifikanın CRL adreslerinden imzası doğrulanmış taze kaydı olmayan var mı? */
  missing(c: ParsedCert): boolean {
    if (this.mode() === 'off') return false
    return c.crlUrls.some((u) => {
      const row = this.q.getCrl(u)
      const e = this.lists.entries.get(u)
      const verified = row?.der && e?.version === (row.fetched_at ?? 0) && e.verifiedBy.size > 0
      return !verified || !this.inWindow(row!)
    })
  }

  /** Büyük listeler burada ayrıştırılır: olay döngüsü listeler arasında nefes alır */
  private async parseWanted(): Promise<void> {
    const { wanted, entries } = this.lists
    for (const url of wanted) {
      if (this.stopped) return
      wanted.delete(url)
      await new Promise((r) => setImmediate(r))
      if (this.stopped) return
      const row = this.q.getCrl(url)
      if (row?.der && entries.get(url)?.version !== (row.fetched_at ?? 0)) parseInto(this.lists, url, row.fetched_at ?? 0, row.der)
    }
  }

  /** Seriler yeni nesle parça parça yazılır, olay döngüsü arada açılır. Geçiş `commit` ile tek adımda: yarım nesil okunmaz */
  private async writeSet(url: string, crl: StoredCrl, commit: (generation: number) => void): Promise<void> {
    const { building } = this.lists
    building.add(url)
    try {
      const generation = this.q.nextCrlGeneration(url)
      let batch: Uint8Array[] = []
      for (const serial of crl.serials()) {
        batch.push(serial)
        if (batch.length < SERIAL_BATCH) continue
        this.q.addCrlSerials(url, generation, batch)
        batch = []
        await new Promise((r) => setImmediate(r))
        if (this.stopped) return
      }
      if (batch.length) this.q.addCrlSerials(url, generation, batch)
      commit(generation)
    } finally {
      building.delete(url)
    }
  }

  private async buildSets(): Promise<void> {
    const { sets } = this.lists
    for (const [url, issuer] of sets) {
      if (this.stopped) return
      sets.delete(url)
      await new Promise((r) => setImmediate(r))
      const row = this.q.getCrl(url)
      const st = this.q.crlSetState(url)
      if (!row?.der || !st?.der_sha256) continue
      const key = setKey(st.der_sha256, issuerId(issuer))
      if (st.set_key === key) continue
      const crl = verified(row.der, issuer)
      if (!crl) reject(this.lists, key)
      else await this.writeSet(url, crl, (generation) => this.q.commitCrlSet(url, generation, key, JSON.stringify(scopeOf(crl))))
    }
  }

  /** Sıralı; URL başına 6 saatte bir deneme. Motor 60 sn'de bir çağırır. */
  async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      if (this.mode() !== 'off') {
        await this.parseWanted()
        await this.buildSets()
      }
      for (const [url, issuer] of this.queue) {
        if (this.stopped) return
        this.queue.delete(url)
        if (this.mode() === 'off' || !this.due(this.q.getCrl(url))) continue
        await this.fetchOne(url, issuer)
      }
    } finally {
      this.draining = false
    }
  }

  /** Önceki satır, yenisinin imzası doğrulanana dek kalır: yolda değiştirilen liste bilinen iptali silemez. Daha eski tarihli
   *  geçerli liste de yenisinin yerine geçmez (geri sarma). */
  private async fetchOne(url: string, issuer: ParsedCert): Promise<void> {
    const prev = this.q.getCrl(url)
    let row: Parameters<Queries['putCrl']>[0]
    let fresh: StoredCrl | null = null
    try {
      const der = await this.fetchUrl(url)
      const crl = parseCrl(der)
      const thisUpdate = crl.info.thisUpdate.value.getTime()
      if (!crl.signatureOk(issuer) || (prev?.der && prev.this_update !== null && thisUpdate < prev.this_update)) throw new Error('crl_rejected')
      row = { url, der, thisUpdate, nextUpdate: crl.info.nextUpdate?.value.getTime() ?? null, fetchedAt: this.now(), lastErrorAt: null }
      fresh = crl
    } catch {
      row = { url, der: prev?.der ?? null, thisUpdate: prev?.this_update ?? null, nextUpdate: prev?.next_update ?? null, fetchedAt: prev?.fetched_at ?? null, lastErrorAt: this.now() }
    }
    if (this.stopped) return // kapanışta DB kapanmış olabilir
    const crl = fresh
    if (!crl || !crl.info.issuer.isEqual(issuer.cert.subject)) return this.q.putCrl(row)
    const version = row.fetchedAt as number
    const key = setKey(createHash('sha256').update(row.der as Buffer).digest('hex'), issuerId(issuer))
    const done = (): void => {
      parseInto(this.lists, url, version, row.der as Buffer, crl) // çekim de drain'de: bir daha ayrıştırılmaz
    }
    if (this.q.crlSetState(url)?.set_key === key) { // aynı liste yeniden geldi: küme durur
      this.q.putCrl(row)
      return done()
    }
    // liste satırı ancak küme tamamlanınca değişir: yenileme sırasında gönderim eski kümeyi okur, `pending` görmez
    await this.writeSet(url, crl, (generation) => {
      this.q.tx(() => {
        this.q.putCrl(row)
        this.q.commitCrlSet(url, generation, key, JSON.stringify(scopeOf(crl)))
      })
      done()
    })
  }

  stop(): void {
    this.stopped = true
    this.queue.clear()
  }
}
