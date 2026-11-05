// Uygulama mağazası (R24): dilimler src/renderer/src/store/*; burada birleşim. create<State> tüm
// alanların tanımlandığını derleme anında denetler.
import { create } from 'zustand'
import { adminSlice } from './store/admin'
import { composeSlice } from './store/compose'
import { initialState } from './store/initial'
import { mailSlice } from './store/mail'
import { guardOfflineWrites } from './store/offlineGuard'
import { pimSlice } from './store/pim'
import { sessionSlice } from './store/session'
import type { State } from './store/types'
import { uiSlice } from './store/ui'
import { vaultSlice } from './store/vault'

export type { ComposerAttachment, ComposerState, ListRow, State, Toast } from './store/types'

export const useStore = create<State>((set, get) => guardOfflineWrites({
  ...initialState,
  ...sessionSlice(set, get),
  ...adminSlice(set, get),
  ...mailSlice(set, get),
  ...pimSlice(set, get),
  ...vaultSlice(set, get),
  ...composeSlice(set, get),
  ...uiSlice(set, get)
}, get))
