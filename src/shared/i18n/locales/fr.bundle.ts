// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './fr/acct'
import auto from './fr/auto'
import calendar from './fr/calendar'
import common from './fr/common'
import compose from './fr/compose'
import contacts from './fr/contacts'
import invite from './fr/invite'
import mail from './fr/mail'
import main from './fr/main'
import mobile from './fr/mobile'
import pim from './fr/pim'
import set from './fr/set'
import smime from './fr/smime'
import sync from './fr/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
