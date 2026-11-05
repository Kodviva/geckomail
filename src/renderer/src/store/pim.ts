// Mağaza — Kişiler ve takvim: üst görünüm, sayfa seçimi, koleksiyon listeleri. Ham vCard/iCalendar buraya hiç gelmez.
import { readOfflineCollections } from '../offline/pim'
import { rpc } from '../rpcClient'
import type { GetState, SetState, State } from './types'

export const pimSlice = (set: SetState, get: GetState) =>
  ({
    setAppView(v) {
      if (v === get().appView) return
      set({ appView: v, selectedContactId: null, selectedEvent: null })
      if (v !== 'mail') void get().refreshPimCollections()
    },

    setSelectedContact(id) {
      set({ selectedContactId: id })
    },

    setSelectedEvent(e) {
      set({ selectedEvent: e })
    },

    clearPimDetail() {
      set({ selectedContactId: null, selectedEvent: null })
    },

    async refreshPimCollections() {
      try {
        if (get().offlineMode) {
          const copy = await readOfflineCollections()
          if (copy) set({ pimCollections: copy })
          return
        }
        const [addressbook, calendar] = await Promise.all([rpc.call('listPimCollections', { type: 'addressbook' }), rpc.call('listPimCollections', { type: 'calendar' })])
        set({ pimCollections: { addressbook, calendar } })
      } catch {
        /* bağlantı yoksa bir sonraki olayda */
      }
    },

    // yazmalar tek yerden geçer: çevrimdışı koruması (offlineGuard) bunları keser, sonuç undefined döner
    saveEventDraft: (params) => rpc.call('saveEvent', params),
    removeEvent: (params) => rpc.call('deleteEvent', params),
    saveContactDraft: (params) => rpc.call('saveContact', params),
    removeContact: (params) => rpc.call('deleteContact', params)
  }) satisfies Partial<State>
