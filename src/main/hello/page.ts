// Yerel kilit için WebAuthn sayfası. `helloMain` metni sayfaya gömülür, dış değişkene dokunamaz. Sonuç
// `window.__hello` sözündedir; main onu executeJavaScript ile bekler, sayfanın ön yüklemesi ve IPC'si yoktur.
import { randomBytes } from 'crypto'

export type HelloPageConfig = {
  mode: 'enroll' | 'verify'
  /** base64url */
  challenge: string
  /** verify: base64url */
  credentialId?: string
  rpName: string
  dir: 'ltr' | 'rtl'
  text: { reason: string; note: string; failed: string; reenroll: string; cancel: string }
}

export function helloMain(cfg: HelloPageConfig): void {
  const toB64u = (b: ArrayBuffer): string =>
    btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const fromB64u = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const el = (id: string): HTMLElement => document.getElementById(id)!
  el('reason').textContent = cfg.text.reason
  el('note').textContent = cfg.mode === 'enroll' ? cfg.text.note : ''
  const uv = 'required' as const
  const rpId = 'localhost'

  async function enroll(): Promise<unknown> {
    const c = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: cfg.rpName },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: cfg.rpName, displayName: cfg.rpName },
        challenge: fromB64u(cfg.challenge),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: uv, residentKey: 'discouraged' },
        attestation: 'none',
        timeout: 60_000
      }
    })) as PublicKeyCredential
    const r = c.response as AuthenticatorAttestationResponse
    const spki = r.getPublicKey()
    if (!spki) return { kind: 'cancel' }
    return { kind: 'enrolled', credentialId: toB64u(c.rawId), publicKeySpki: btoa(String.fromCharCode(...new Uint8Array(spki))), alg: r.getPublicKeyAlgorithm() }
  }

  async function verify(): Promise<unknown> {
    const c = (await navigator.credentials.get({
      publicKey: {
        rpId,
        challenge: fromB64u(cfg.challenge),
        allowCredentials: [{ type: 'public-key', id: fromB64u(cfg.credentialId ?? '') }],
        userVerification: uv,
        timeout: 60_000
      }
    })) as PublicKeyCredential
    const r = c.response as AuthenticatorAssertionResponse
    return { kind: 'assertion', authenticatorData: toB64u(r.authenticatorData), clientDataJSON: toB64u(r.clientDataJSON), signature: toB64u(r.signature) }
  }

  // Kimlik işletim sisteminden silinse de tarayıcı bunu iptalden ayırt ettirmez (ikisi de NotAllowedError):
  // yeniden kayıt kullanıcıya sunulur. Kayıt yine Hello doğrulaması ister, kapı zayıflamaz.
  function afterFailure(): Promise<unknown> {
    if (cfg.mode === 'enroll') return Promise.resolve({ kind: 'cancel' })
    return new Promise((done) => {
      const again = el('again')
      const cancel = el('cancel')
      el('note').textContent = cfg.text.failed
      again.textContent = cfg.text.reenroll
      cancel.textContent = cfg.text.cancel
      again.onclick = () => done({ kind: 'missing' })
      cancel.onclick = () => done({ kind: 'cancel' })
      el('actions').hidden = false
    })
  }

  const w = window as unknown as { __hello: Promise<unknown> }
  w.__hello = (cfg.mode === 'enroll' ? enroll() : verify()).catch(afterFailure)
}

const CSS = `:root{color-scheme:light dark}body{margin:0;font:14px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center}
main{padding:20px;max-width:360px}#reason{font-size:16px;font-weight:600;margin:0 0 8px}#note{margin:0 0 14px;opacity:.75}
#actions{display:flex;gap:8px;justify-content:center}#actions[hidden]{display:none}button{font:inherit;padding:6px 14px}`

/** Yapılandırma JSON olarak betiğe girer: `<` kaçırılır, neden metni renderer'dan gelir */
export function renderHelloPage(cfg: HelloPageConfig): Buffer {
  const nonce = randomBytes(16).toString('base64')
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c')
  return Buffer.from(
    `<!doctype html><html dir="${cfg.dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'">` +
      `<title>GeckoMail</title><style nonce="${nonce}">${CSS}</style></head>` +
      `<body><main><p id="reason"></p><p id="note"></p><div id="actions" hidden><button id="again"></button><button id="cancel"></button></div></main>` +
      `<script nonce="${nonce}">(${helloMain.toString()})(${json})</script></body></html>`
  )
}
