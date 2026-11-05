// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
import acct from './ja/acct'
import auto from './ja/auto'
import calendar from './ja/calendar'
import common from './ja/common'
import compose from './ja/compose'
import contacts from './ja/contacts'
import invite from './ja/invite'
import mail from './ja/mail'
import main from './ja/main'
import mobile from './ja/mobile'
import pim from './ja/pim'
import set from './ja/set'
import smime from './ja/smime'
import sync from './ja/sync'

export default { ...acct, ...auto, ...calendar, ...common, ...compose, ...contacts, ...invite, ...mail, ...main, ...mobile, ...pim, ...set, ...smime, ...sync } as Record<string, string>
