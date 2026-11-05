// OTOMATİK ÜRETİLDİ — node scripts/i18n-index.mjs
// Yan etkili: tüm dilleri eşzamanlı kaydeder. main ve sync bunu içe aktarır; renderer aktarmaz.
import { CATALOGS } from './index'
import ar from './ar.bundle'
import de from './de.bundle'
import es from './es.bundle'
import fr from './fr.bundle'
import hi from './hi.bundle'
import ja from './ja.bundle'
import pt from './pt.bundle'
import ru from './ru.bundle'
import zh from './zh.bundle'

Object.assign(CATALOGS, { ar, de, es, fr, hi, ja, pt, ru, zh })
