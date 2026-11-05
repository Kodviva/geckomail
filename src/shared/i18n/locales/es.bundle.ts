// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './es/acct'
import auto from './es/auto'
import calendar from './es/calendar'
import common from './es/common'
import compose from './es/compose'
import contacts from './es/contacts'
import invite from './es/invite'
import mail from './es/mail'
import main from './es/main'
import mobile from './es/mobile'
import pim from './es/pim'
import set from './es/set'
import smime from './es/smime'
import sync from './es/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
