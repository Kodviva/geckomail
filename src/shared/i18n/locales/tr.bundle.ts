// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './tr/acct'
import auto from './tr/auto'
import calendar from './tr/calendar'
import common from './tr/common'
import compose from './tr/compose'
import contacts from './tr/contacts'
import invite from './tr/invite'
import mail from './tr/mail'
import main from './tr/main'
import mobile from './tr/mobile'
import pim from './tr/pim'
import set from './tr/set'
import smime from './tr/smime'
import sync from './tr/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
