// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './pt/acct'
import auto from './pt/auto'
import calendar from './pt/calendar'
import common from './pt/common'
import compose from './pt/compose'
import contacts from './pt/contacts'
import invite from './pt/invite'
import mail from './pt/mail'
import main from './pt/main'
import mobile from './pt/mobile'
import pim from './pt/pim'
import set from './pt/set'
import smime from './pt/smime'
import sync from './pt/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
