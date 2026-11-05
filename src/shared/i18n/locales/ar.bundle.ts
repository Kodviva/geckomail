// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './ar/acct'
import auto from './ar/auto'
import calendar from './ar/calendar'
import common from './ar/common'
import compose from './ar/compose'
import contacts from './ar/contacts'
import invite from './ar/invite'
import mail from './ar/mail'
import main from './ar/main'
import mobile from './ar/mobile'
import pim from './ar/pim'
import set from './ar/set'
import smime from './ar/smime'
import sync from './ar/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
