// Masaüstü uygulamasının "sunucuma bağlan" yoklaması: GET /api/server-info oturumsuz yanıt verir, bu yüzden yalnız
// GeckoMail sunucusu olduğunu ve kökenini söyler. Sürüm numarası yok: dışarıdan yama düzeyi okunmasın.
import type { ServerConfig } from './config'

/** Masaüstü ile sunucu arasındaki sözleşme bozulursa artar; masaüstü uyumsuzsa bağlanmaz */
export const DESKTOP_API = 1

export interface ServerInfo {
  app: 'geckomail'
  desktopApi: number
  origin: string
}

export const serverInfo = (cfg: Pick<ServerConfig, 'publicOrigin'>): ServerInfo => ({ app: 'geckomail', desktopApi: DESKTOP_API, origin: cfg.publicOrigin })
