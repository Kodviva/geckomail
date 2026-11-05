// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './zh/acct'
import auto from './zh/auto'
import calendar from './zh/calendar'
import common from './zh/common'
import compose from './zh/compose'
import contacts from './zh/contacts'
import invite from './zh/invite'
import mail from './zh/mail'
import main from './zh/main'
import mobile from './zh/mobile'
import pim from './zh/pim'
import set from './zh/set'
import smime from './zh/smime'
import sync from './zh/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
