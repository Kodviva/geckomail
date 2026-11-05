// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './en/acct'
import auto from './en/auto'
import calendar from './en/calendar'
import common from './en/common'
import compose from './en/compose'
import contacts from './en/contacts'
import invite from './en/invite'
import mail from './en/mail'
import main from './en/main'
import mobile from './en/mobile'
import pim from './en/pim'
import set from './en/set'
import smime from './en/smime'
import sync from './en/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
