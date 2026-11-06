// utilityProcess girişi: Electron'a özgü bağlama (env, günlük, parentPort); motor engine.ts'te.
// Ağ ve disk işinin tamamı motorda yaşar; arayüz asla beklemez.
import '../shared/i18n/locales/all' // sync: tüm diller eşzamanlı (bildirim, sunucu mesajları)
import { isLocale, setLocale, setUiOs } from '../shared/i18n'
import { uiOsOf } from '../shared/platformText'
import { join } from 'path'
import { DbTooNewError } from './db'
import { startEngine } from './engine'
import { fromMessagePortMain } from './rpc/transport'
import { createParentPortHost } from './hosts/parentPortHost'
import { createLogger, mirrorConsole } from '../shared/jsonlLog'
import { setSyncLog } from './log'
import { smimeSelfTest } from './smime/selfTest'

const parentPort = process.parentPort
if (!parentPort) {
  console.error('sync: parentPort yok — utilityProcess dışında çalıştırılamaz')
  process.exit(1)
}

// production: ayrıntılı logları sustur (main süreciyle aynı; warn/error kalır)
if (process.env.GECKO_PROD === '1') {
  console.log = console.info = console.debug = () => {}
}

setUiOs(uiOsOf(process.platform))
// main'in bildiği dil: DB açılmadan üretilen iletiler (ör. sürüm düşürme) de bu dilde; DB'deki tercih sonra geçerli
if (isLocale(process.env.GECKO_LOCALE)) setLocale(process.env.GECKO_LOCALE)

const userData = process.env.GECKO_USER_DATA
if (!userData) {
  console.error('sync: GECKO_USER_DATA tanımsız')
  process.exit(1)
}

// kalıcı günlük: console.warn/error dosyaya da gider (userData/logs, 14 gün)
const log = createLogger(join(userData, 'logs'), 'sync')
mirrorConsole(log)
setSyncLog(log)
log.info('sync başlıyor', { pid: process.pid })

const bridge = createParentPortHost(parentPort)
let engine: ReturnType<typeof startEngine>
try {
  engine = startEngine({ userData, host: bridge.host, mode: 'desktop', os: process.platform })
} catch (e) {
  // sürüm düşürme: motor main'e ölümcül olarak bildirdi; yeniden başlatmak aynı hatayı üretir, dur
  if (e instanceof DbTooNewError) setTimeout(() => process.exit(3), 200)
  throw e
}
// yalnız smoke: paketli çalışma zamanının (BoringSSL) gereken şifreleri sunduğunu kanıtlar
if (process.env.GECKO_SMOKE_SMIME === '1') {
  smimeSelfTest().then(
    () => console.log('sync: smime hazır'),
    (e: Error) => console.error(`sync: smime özdenetimi başarısız: ${e.message}`)
  )
}
bridge.onSignal((s) => engine.signal(s))
// ana süreç çıkarken sync.kill(): gönderilmekte olan ileti biter, DB düzgün kapanır (Windows'ta sinyal yoktur, açılış belirsiz sayar)
process.once('SIGTERM', () => void engine.stop().finally(() => process.exit(0)))
bridge.onRpcPort((p) => engine.hub.openSession(fromMessagePortMain(p)))
