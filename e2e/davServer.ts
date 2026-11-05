// Sahte CalDAV/CardDAV: Playwright sürecinde birim testlerinin sunucusu çalışır. Kişisel DAV bağlama ve eşitleme gerçek istek yapar.
import { Buffer } from 'node:buffer'
import { FakeDav } from '../src/sync/__tests__/helpers/fakeDav'

export const DAV_USER = { username: 'kisi', password: 'dav-parola' }
export const DAV_CAL = '/dav/cal/a/ev/'
export const DAV_BOOK = '/dav/card/a/ki/'

export async function startDav(): Promise<FakeDav> {
  const dav = await FakeDav.start()
  dav.accept = [`Basic ${Buffer.from(`${DAV_USER.username}:${DAV_USER.password}`).toString('base64')}`]
  dav.homes = { principal: '/dav/pal/a/', calendar: '/dav/cal/a/', addressbook: '/dav/card/a/' }
  dav.collections.set(DAV_CAL, { type: 'calendar', name: 'Sunucu takvimi' })
  dav.collections.set(DAV_BOOK, { type: 'addressbook', name: 'Sunucu rehberi' })
  return dav
}

export type { FakeDav }
