// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './de/acct'
import auto from './de/auto'
import calendar from './de/calendar'
import common from './de/common'
import compose from './de/compose'
import contacts from './de/contacts'
import invite from './de/invite'
import mail from './de/mail'
import main from './de/main'
import mobile from './de/mobile'
import pim from './de/pim'
import set from './de/set'
import smime from './de/smime'
import sync from './de/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
