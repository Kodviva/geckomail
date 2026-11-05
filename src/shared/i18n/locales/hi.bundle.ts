// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './hi/acct'
import auto from './hi/auto'
import calendar from './hi/calendar'
import common from './hi/common'
import compose from './hi/compose'
import contacts from './hi/contacts'
import invite from './hi/invite'
import mail from './hi/mail'
import main from './hi/main'
import mobile from './hi/mobile'
import pim from './hi/pim'
import set from './hi/set'
import smime from './hi/smime'
import sync from './hi/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
