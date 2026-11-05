// Kurallardan hesap başına Sieve betiği üretir. Saf: aynı girdi bayt bayt aynı çıktı, ağ ve DB yok.
// Çevrilemeyen her şey istemcide kalır; üretilen betik yalnız ilan edilmiş eklentileri kullanır.
import { createHash } from 'crypto'
import type { RuleAction, RuleCondition } from '../../shared/rpc'
import {
  SIEVE_MAX_STRING_BYTES, SIEVE_RULES_SCRIPT, hasControlChars, validateVacation, vacationBodyCrlf,
  type ClientReason, type RulePlacement, type SieveVacation
} from '../../shared/sieve'
import type { FolderRow, RuleRow } from '../db/queries'

const MAX_SCRIPT_BYTES = 64 * 1024
const MAX_SERVER_RULES = 150
const MAX_WATCHED = 8
const CRLF = '\r\n'
const UNICODE_CMP = 'comparator-i;unicode-casemap'
const NON_ASCII = /[\u0080-\u{10ffff}]/u
const FLAG_COMMANDS: Partial<Record<RuleAction['type'], string>> = {
  markRead: 'addflag "\\\\Seen";',
  markUnread: 'removeflag "\\\\Seen";',
  flag: 'addflag "\\\\Flagged";'
}

export interface SieveGenInput {
  rules: RuleRow[]
  extensions: string[]
  folders: Pick<FolderRow, 'path' | 'kind'>[]
  delimiters: string[]
  vacation: SieveVacation | null
  accountEmail: string
  maxWatched?: number
}

export interface RulePlan {
  ruleId: number
  placement: RulePlacement
  reason: ClientReason | null
  server: RuleAction[]
  client: RuleAction[]
  targetPath: string | null
}

export interface SieveGenOutput {
  text: string | null
  hash: string | null
  plans: RulePlan[]
  watched: string[]
  requires: string[]
  /** tatil, spam dışlama testleriyle betik sınırına sığmadı ve üretilmedi: aralıklı dışlama spam'e yanıt demektir */
  vacationDropped: boolean
}

interface Code {
  code: string
  needs: string[]
}

interface Block {
  ruleId: number
  test: Code
  flags: string[]
  move: Code | null
}

const isReason = <T extends object>(v: T | ClientReason): v is ClientReason => typeof v === 'string'
const RELOCATING = new Set<unknown>(['move', 'archive', 'spam'])
/** Bu eylemler iletiyi Gelen Kutusu'nda ya da izlenen klasörde görmeden çalışamaz */
const CLIENT_ONLY = new Set<unknown>(['forward', 'webhook', 'notify'])
const KNOWN_ACTIONS = new Set<unknown>([...RELOCATING, ...CLIENT_ONLY, 'markRead', 'markUnread', 'flag'])
const isRelocating = (a: RuleAction): boolean => RELOCATING.has(a.type)
const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8')

const escapeString = (s: string): string => `"${s.replace(/[\\"]/g, '\\$&')}"`

/** Sieve dizgisi. Denetim karakteri (satır sonu dahil) enjeksiyon yüzeyidir: null döner */
export function sieveQuote(s: string): string | null {
  return hasControlChars(s) ? null : escapeString(s)
}

function valueTest(command: string, match: string, value: string, exts: Set<string>): Code | ClientReason {
  const quoted = sieveQuote(value)
  if (quoted === null) return 'unsafe_string'
  if (byteLength(value) > SIEVE_MAX_STRING_BYTES) return 'size_cap'
  // i;ascii-casemap Türkçe harflerde büyük/küçük ayırır, istemcinin toLowerCase'i ayırmaz
  if (!NON_ASCII.test(value)) return { code: `${command} ${match} ${quoted}`, needs: [] }
  if (!exts.has(UNICODE_CMP)) return 'non_ascii'
  return { code: `${command} :comparator "i;unicode-casemap" ${match} ${quoted}`, needs: [UNICODE_CMP] }
}

/** matchesAll ile aynı anlam: boş alan "fark etmez", koşullar AND */
function conditionTest(c: RuleCondition, exts: Set<string>): Code | ClientReason {
  // foreverypart test değil denetim yapısıdır, allof/elsif içine girmez
  if (c.hasAttachment !== undefined) return 'attachment'
  const tests: (Code | ClientReason)[] = []
  if (c.senderContains) tests.push(valueTest('address', ':contains "from"', c.senderContains, exts))
  if (c.domainEquals) {
    const domain = c.domainEquals.replace(/^@/, '')
    tests.push(domain ? valueTest('address', ':domain :is "from"', domain, exts) : 'unsafe_string')
  }
  if (c.subjectContains) tests.push(valueTest('header', ':contains "subject"', c.subjectContains, exts))
  const failed = tests.find(isReason)
  if (failed) return failed
  const ok = tests as Code[]
  if (ok.length === 0) return { code: 'true', needs: [] }
  if (ok.length === 1) return ok[0]
  return { code: `allof(${ok.map((t) => t.code).join(', ')})`, needs: ok.flatMap((t) => t.needs) }
}

/** opQueue move_named ile aynı eşleme: kural birden çok hesaba uygulanır, ad hesap başına çözülür */
function findFolder(folders: SieveGenInput['folders'], name: string): SieveGenInput['folders'][number] | undefined {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return undefined
  return folders.find((f) => f.path.replace(/^INBOX\.?/i, '').toLowerCase() === wanted || f.path.toLowerCase() === wanted)
}

interface Target {
  path: string
  watch: boolean
  command: Code
}

function fileinto(tag: string, need: string | null, path: string): Code | ClientReason {
  const quoted = sieveQuote(path)
  if (quoted === null) return 'unsafe_string'
  if (byteLength(path) > SIEVE_MAX_STRING_BYTES) return 'size_cap'
  return { code: `fileinto ${tag}${quoted};`, needs: need ? ['fileinto', need] : ['fileinto'] }
}

function resolveTarget(a: RuleAction, hasClientPart: boolean, input: SieveGenInput, exts: Set<string>): Target | ClientReason {
  if (a.type === 'move') {
    const name = a.folderName.trim()
    const known = findFolder(input.folders, name)
    if (known) {
      const command = fileinto('', null, known.path)
      return isReason(command) ? command : { path: known.path, watch: known.kind !== 'inbox', command }
    }
    // yeni klasörü sunucu açar; istemci kısmı olan kural klasör belli olmadan izlenemez
    if (!name || hasClientPart || !exts.has('mailbox') || input.delimiters.some((d) => d && name.includes(d))) {
      return sieveQuote(name) === null ? 'unsafe_string' : 'folder_unknown'
    }
    const command = fileinto(':create ', 'mailbox', name)
    return isReason(command) ? command : { path: name, watch: true, command }
  }
  const kind = a.type === 'spam' ? 'junk' : 'archive'
  const folder = input.folders.find((f) => f.kind === kind)
  if (!folder) return 'folder_unknown'
  const special = exts.has('special-use')
  const tag = special ? `:specialuse "\\\\${kind === 'junk' ? 'Junk' : 'Archive'}" ` : ''
  const command = fileinto(tag, special ? 'special-use' : null, folder.path)
  // spam izlenmez: istemci eylemi de taşıyan spam kuralı zaten istemcide kalır
  return isReason(command) ? command : { path: folder.path, watch: kind !== 'junk', command }
}

const isCondition = (c: unknown): c is RuleCondition => {
  if (typeof c !== 'object' || c === null) return false
  const { senderContains, domainEquals, subjectContains } = c as Record<string, unknown>
  return [senderContains, domainEquals, subjectContains].every((v) => v == null || typeof v === 'string')
}

const isAction = (a: unknown): a is RuleAction => {
  if (typeof a !== 'object' || a === null) return false
  const { type, folderName } = a as Record<string, unknown>
  return KNOWN_ACTIONS.has(type) && (type !== 'move' || typeof folderName === 'string')
}

/** Eski ya da elle yazılmış satır bütün hesabın dağıtımını düşürmesin: bozuk kural istemcide kalır */
function parseRule(r: RuleRow): { cond: RuleCondition; actions: RuleAction[] } | null {
  try {
    const cond = JSON.parse(r.conditions_json) as unknown
    const actions = JSON.parse(r.actions_json) as unknown
    if (!isCondition(cond) || !Array.isArray(actions) || !actions.every(isAction)) return null
    return { cond, actions }
  } catch {
    return null
  }
}

/** Bozuk satırda da eylem türleri: istemci yine çalıştırır, sıra ve spam kararı bunları görmeli */
function actionTypes(r: RuleRow): unknown[] {
  try {
    const actions = JSON.parse(r.actions_json) as unknown
    return Array.isArray(actions) ? actions.map((a) => (a as { type?: unknown } | null)?.type) : []
  } catch {
    return []
  }
}

interface Compiled {
  plans: RulePlan[]
  watched: string[]
  blocks: Block[]
  spamTests: Code[]
}

function compile(input: SieveGenInput, exts: Set<string>, capped: Set<number>): Compiled {
  const maxWatched = input.maxWatched ?? MAX_WATCHED
  const plans: RulePlan[] = []
  const watched: string[] = []
  const blocks: Block[] = []
  const spamTests: Code[] = []
  const rules = input.rules.filter((r) => r.enabled).sort((a, b) => a.id - b.id)
  // İstemcide ilk taşıyan kazanır. Sunucu önce çalışır: istemcide kalan taşımadan sonra gelen taşıma
  // sunucuya giderse sıra tersine döner, ileti Gelen Kutusu'na hiç düşmez
  let clientMoverSeen = false
  // Junk izlenmez: sunucu spam'e taşırsa ileti, başka kuralın istemci eylemine hiç görünmez
  const clientActionsExist = rules.some((r) => actionTypes(r).some((t) => CLIENT_ONLY.has(t)))

  for (const rule of rules) {
    const parsed = parseRule(rule)
    if (!parsed) {
      if (actionTypes(rule).some((t) => RELOCATING.has(t))) clientMoverSeen = true
      plans.push({ ruleId: rule.id, placement: 'client', reason: 'unsafe_string', server: [], client: [], targetPath: null })
      continue
    }
    const { cond, actions } = parsed
    const keepOnClient = (reason: ClientReason | null): void => {
      if (actions.some(isRelocating)) clientMoverSeen = true
      plans.push({ ruleId: rule.id, placement: 'client', reason, server: [], client: actions, targetPath: null })
    }
    if (!rule.run_on_server) {
      keepOnClient('user_choice')
      continue
    }
    const test = conditionTest(cond, exts)
    if (isReason(test)) {
      keepOnClient(test)
      continue
    }
    if (actions.some((a) => a.type === 'spam')) spamTests.push(test)

    const flagsOk = exts.has('imap4flags')
    const flagActions = actions.filter((a) => FLAG_COMMANDS[a.type])
    const relocator = actions.find(isRelocating) ?? null
    // sonraki taşımalar sayılmaz: istemcide de ilk taşıyan kazanır
    const hasClientPart = actions.some((a) => !isRelocating(a) && !(flagsOk && FLAG_COMMANDS[a.type]))
    let extMissing = !flagsOk && flagActions.length > 0
    let target: Target | null = null
    if (relocator) {
      if (!exts.has('fileinto')) extMissing = true
      else if (clientMoverSeen) {
        keepOnClient('order')
        continue
      } else if (relocator.type === 'spam' && (hasClientPart || clientActionsExist)) {
        keepOnClient('spam_split')
        continue
      } else {
        const resolved = resolveTarget(relocator, hasClientPart, input, exts)
        if (isReason(resolved)) {
          keepOnClient(resolved)
          continue
        }
        target = resolved
      }
    }
    const server = actions.filter((a) => (flagsOk && FLAG_COMMANDS[a.type]) || (target !== null && a === relocator))
    // sunucu taşıdıysa sonraki taşımalar anlamsız: istemcide de ilk taşıyan kazanır
    const client = actions.filter((a) => !server.includes(a) && !(target && isRelocating(a)))
    if (server.length === 0) {
      keepOnClient(extMissing ? 'ext_missing' : null)
      continue
    }
    if (capped.has(rule.id) || blocks.length >= MAX_SERVER_RULES) {
      keepOnClient('size_cap')
      continue
    }
    if (target?.watch && !watched.includes(target.path)) {
      if (watched.length >= maxWatched) {
        keepOnClient('watch_cap')
        continue
      }
      watched.push(target.path)
    }
    blocks.push({ ruleId: rule.id, test, flags: flagsOk ? flagActions.map((a) => FLAG_COMMANDS[a.type]!) : [], move: target?.command ?? null })
    plans.push({
      ruleId: rule.id, placement: client.length ? 'split' : 'server', reason: extMissing ? 'ext_missing' : null,
      server, client, targetPath: target?.path ?? null
    })
  }
  return { plans, watched, blocks, spamTests }
}

function vacationLines(v: SieveVacation, spamTests: Code[], email: string, exts: Set<string>, used: Set<string>): string[] {
  const dates = [
    v.startDate ? `currentdate :value "ge" "date" "${v.startDate}"` : null,
    v.endDate ? `currentdate :value "le" "date" "${v.endDate}"` : null
  ].filter((d): d is string => d !== null)
  const parts = [`vacation :days ${v.days}`]
  if (v.subject) parts.push(`:subject ${escapeString(v.subject)}`)
  const address = sieveQuote(email)
  if (address) parts.push(`:addresses [${address}]`)
  parts.push(`${escapeString(vacationBodyCrlf(v.body))};`)

  let lines = [parts.join(' ')]
  const wrap = (open: string): void => {
    lines = [`${open} {`, ...lines.map((l) => `  ${l}`), '}']
  }
  used.add('vacation')
  if (dates.length) {
    wrap(`if ${dates.length === 1 ? dates[0] : `allof(${dates.join(', ')})`}`)
    used.add('date').add('relational')
  }
  // spam gönderene yanıt gitmesin
  if (spamTests.length) {
    wrap(`if not anyof(${spamTests.map((t) => t.code).join(', ')})`)
    for (const t of spamTests) for (const n of t.needs) used.add(n)
  }
  return lines
}

const bodyHash = (body: string): string => createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

/** Üretilebilir tatil: yalnız eklentiler varken. Tarih aralığı yerine getirilemiyorsa tatil de yok: aralık dışında yanıt gitmemeli */
function usableVacation(input: SieveGenInput, exts: Set<string>): SieveVacation | null {
  if (!input.vacation?.enabled || !exts.has('vacation')) return null
  const v = validateVacation(input.vacation)
  if (typeof v === 'string') return null
  if ((v.startDate || v.endDate) && !(exts.has('date') && exts.has('relational'))) return null
  return v
}

function render(c: Compiled, vacation: SieveVacation | null, email: string, exts: Set<string>): { body: string; requires: string[] } | null {
  if (c.blocks.length === 0 && !vacation) return null
  const used = new Set<string>()
  const lines: string[] = []
  const comment = (b: Block): string => `  # geckomail:rule:${b.ruleId}`
  const need = (x: Code): void => x.needs.forEach((n) => used.add(n))

  // addflag sonraki fileinto'ya etki eder: bayraklar önce, taşımalar tek zincirde (iki kopya olmasın)
  for (const b of c.blocks.filter((x) => x.flags.length)) {
    need(b.test)
    used.add('imap4flags')
    lines.push(`if ${b.test.code} {`, comment(b), ...b.flags.map((f) => `  ${f}`), '}')
  }
  const movers = c.blocks.filter((x) => x.move)
  movers.forEach((b, i) => {
    need(b.test)
    need(b.move!)
    lines.push(`${i === 0 ? 'if' : '} elsif'} ${b.test.code} {`, comment(b), `  ${b.move!.code}`)
  })
  if (movers.length) lines.push('}')
  if (vacation) lines.push(...vacationLines(vacation, c.spamTests, email, exts, used))

  const requires = [...used].sort()
  const head = `require [${requires.map((r) => `"${r}"`).join(', ')}];`
  return { body: [head, ...lines, ''].join(CRLF), requires }
}

const withHeader = (hash: string, body: string): string => `# geckomail v1 sha256:${hash}${CRLF}${body}`
const scriptBytes = (body: string): number => byteLength(withHeader(bodyHash(body), body))

export function generateSieve(input: SieveGenInput): SieveGenOutput {
  const exts = new Set(input.extensions.map((e) => e.toLowerCase()))
  let vacation = usableVacation(input, exts)
  let vacationDropped = false
  const capped = new Set<number>()
  for (;;) {
    const c = compile(input, exts, capped)
    const alone = vacation ? render({ ...c, blocks: [] }, vacation, input.accountEmail, exts) : null
    if (alone && scriptBytes(alone.body) > MAX_SCRIPT_BYTES) {
      vacation = null
      vacationDropped = true
      continue
    }
    const rendered = render(c, vacation, input.accountEmail, exts)
    if (!rendered) return { text: null, hash: null, plans: c.plans, watched: [], requires: [], vacationDropped }
    const hash = bodyHash(rendered.body)
    const text = withHeader(hash, rendered.body)
    const last = c.blocks.at(-1)
    if (byteLength(text) <= MAX_SCRIPT_BYTES || !last) return { text, hash, plans: c.plans, watched: c.watched, requires: rendered.requires, vacationDropped }
    capped.add(last.ruleId) // aşan kurallar id sırasıyla, sondan istemciye döner
  }
}

/** K22: daha önce dağıtılmış hesapta kural ve tatil kalmadı. Etkin durum ve onay korunsun diye betik silinmez, boşalır */
export function generateEmptyRules(): { text: string; hash: string } {
  const hash = bodyHash('')
  return { text: withHeader(hash, ''), hash }
}

/** Sahipliğin kanıtı adla değil ilk satırla: başlık yoksa null, gövde özeti tutmuyorsa valid false.
 *  Sunucu satır sonunu değiştirebilir: özet satır sonundan bağımsız */
export function parseManagedHeader(text: string): { kind: 'rules' | 'wrapper'; valid: boolean } | null {
  const m = /^# geckomail( wrapper)? v1 sha256:([0-9a-f]{64})(?:\r?\n|$)/.exec(text)
  if (!m) return null
  return { kind: m[1] ? 'wrapper' : 'rules', valid: bodyHash(text.slice(m[0].length)) === m[2] }
}

/** Kullanıcının betiği etkinken etkinleştirilen sarmalayıcı: kullanıcı betiğine tek bayt yazılmaz.
 *  `:optional` yok: Dovecot 2.4.5'te derlenmiş ikilinin :optional hedefi silinince her teslimde LMTP SIGSEGV olur ve
 *  başka betik etkinleşse de sürer. :optional'sız eksik betik çalışma zamanı hatasıdır, ileti kalır, K9 kuralları uygular */
export function generateWrapper(userScript: string): string {
  const quoted = sieveQuote(userScript)
  if (quoted === null) throw new Error('invalid script name')
  const body = ['require ["include"];', `include :personal "${SIEVE_RULES_SCRIPT}";`, `include :personal ${quoted};`, ''].join(CRLF)
  return `# geckomail wrapper v1 sha256:${bodyHash(body)}${CRLF}${body}`
}

/** Sarmalayıcının içerdiği kullanıcı betiği. Başka cihazın kurduğu sarmalayıcıda satır boştur, geri alma buradan okur */
export function parseWrapperTarget(text: string): string | null {
  const targets = [...text.matchAll(/^include :personal (?::optional )?"((?:\\.|[^"\\])*)";/gm)].map((m) => m[1].replace(/\\(.)/g, '$1'))
  return targets.find((name) => name !== SIEVE_RULES_SCRIPT) ?? null
}
