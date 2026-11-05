// Sorgu katmanı (R24): alan modülleri src/sync/db/q/*; burada birleşik nesne ve türler.
import type { Database } from 'better-sqlite3'
import { createCtx } from './q/ctx'
import { accountsQueries } from './q/accounts'
import { authQueries } from './q/auth'
import { automationQueries } from './q/automation'
import { featuresQueries } from './q/features'
import { messagesQueries } from './q/messages'
import { notifyRulesQueries } from './q/notifyRules'
import { pimQueries } from './q/pim'
import { pushDevicesQueries } from './q/pushDevices'
import { searchQueries } from './q/search'
import { sieveQueries } from './q/sieve'
import { smimeQueries } from './q/smime'
import { storageQueries } from './q/storage'
import { syncQueries } from './q/sync'
import { userScopeQueries } from './q/userScope'
import { webAuthQueries } from './q/webAuth'

export * from './q/types'
export type { SessionKind, WebSessionRow } from './q/webAuth'
export type { PushDevice } from './q/pushDevices'
export type { SieveAccountRow } from './q/sieve'
export type { CalendarObjectRow, ContactRow, DueAlarmRow, PimCollectionPrefRow, PimCollectionRow, PimSourceRow } from './q/pim'

export function makeQueries(db: Database) {
  const c = createCtx(db)
  const q = {
    ...accountsQueries(c),
    ...messagesQueries(c),
    ...featuresQueries(c),
    ...storageQueries(c),
    ...searchQueries(c),
    ...authQueries(c),
    ...automationQueries(c),
    ...syncQueries(c),
    ...userScopeQueries(c),
    ...webAuthQueries(c),
    ...notifyRulesQueries(c),
    ...pushDevicesQueries(c),
    ...sieveQueries(c),
    ...pimQueries(c),
    ...smimeQueries(c)
  }
  c.q = q
  return q
}

export type Queries = ReturnType<typeof makeQueries>
