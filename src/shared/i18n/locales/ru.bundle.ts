// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './ru/acct'
import auto from './ru/auto'
import calendar from './ru/calendar'
import common from './ru/common'
import compose from './ru/compose'
import contacts from './ru/contacts'
import invite from './ru/invite'
import mail from './ru/mail'
import main from './ru/main'
import mobile from './ru/mobile'
import pim from './ru/pim'
import set from './ru/set'
import smime from './ru/smime'
import sync from './ru/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
