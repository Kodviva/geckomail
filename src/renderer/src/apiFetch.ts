// Sunucu API'sine giden tek yol. Web ve masaüstünde aynı köken ve çerez; mobil uygulama kendi kökeninden çalışır, API başka
// köktedir: orada istemciyi yerel platform kurar (platform/native.ts, Bearer). Çağıranlar yalnız göreli yol verir.
export interface WsEndpoint { url: string; protocols?: string[] }

export interface ApiClient {
  fetch(path: string, init?: RequestInit): Promise<Response>
  wsEndpoint(): Promise<WsEndpoint>
  /** Bellekteki kimlik bırakılır (giriş, çıkış) */
  reset?(): void
}

const sameOrigin: ApiClient = {
  fetch: (path, init) => fetch(path, { credentials: 'same-origin', ...init }),
  async wsEndpoint() {
    const { protocol, host } = window.location
    return { url: `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/rpc` }
  }
}

let client = sameOrigin

/** null: varsayılan aynı köken istemcisine döner */
export function setApiClient(c: ApiClient | null): void {
  client = c ?? sameOrigin
}

export const apiFetch = (path: string, init?: RequestInit): Promise<Response> => client.fetch(path, init)

export const wsEndpoint = (): Promise<WsEndpoint> => client.wsEndpoint()

export const resetApiClient = (): void => client.reset?.()
