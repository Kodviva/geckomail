// Yerel "Kişilerim" ve "Takvimim": uzak sunucu yok, satır RPC'de yazılır, eşitlenecek bir şey yoktur.
import { randomUUID } from 'crypto'
import type { PimBackend, RemoteCollection, RemoteObject } from './backend'

export class LocalBackend implements PimBackend {
  async listCollections(): Promise<RemoteCollection[]> {
    return []
  }

  async sync(): Promise<void> {}

  async fetchObject(): Promise<null> {
    return null
  }

  private put(remoteId: string | null, data: string): RemoteObject {
    return { remoteId: remoteId ?? randomUUID(), etag: null, data }
  }

  async putContact(_c: unknown, remoteId: string | null, vcard: string): Promise<RemoteObject> {
    return this.put(remoteId, vcard)
  }

  async deleteContact(): Promise<'ok'> {
    return 'ok'
  }

  async putEvent(_c: unknown, remoteId: string | null, ics: string): Promise<RemoteObject> {
    return this.put(remoteId, ics)
  }

  async deleteEvent(): Promise<'ok'> {
    return 'ok'
  }
}
