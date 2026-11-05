// Ayarlar › Hesaplar › OAuth istemcileri (yönetici): Gmail / Microsoft 365 ile şifresiz bağlanmak için
// Google Cloud ve Microsoft Entra'da kaydedilen uygulamanın kimlikleri. Paketli sürümde derleme sırasında da
// verilebilir (GECKO_GOOGLE_CLIENT_ID …); buradaki değer önceliklidir. Web'de her kurulum kendi istemcisini
// kullanır: sağlayıcıya kaydedilecek yönlendirme adresi (`<köken>/oauth/callback`) burada gösterilir.
import { useEffect, useState } from 'react'
import type { OAuthClientsInfo } from '../../../shared/rpc'
import { t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import { rich } from '../rich'
import { platform } from '../platform'

/** Web: sağlayıcıya kaydedilecek yönlendirme adresi ve kopyalama düğmesi */
function RedirectUri() {
  const toast = useStore((s) => s.toast)
  const uri = `${window.location.origin}/oauth/callback`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(uri)
      toast(t('set.oauth.copied'), 'info')
    } catch (e) {
      toast((e as Error).message)
    }
  }
  return (
    <div className="set-field set-field-col">
      <div className="sf-l">
        <div className="sf-t">{t('set.oauth.redirectTitle')}</div>
        <div className="sf-h">{t('set.oauth.redirectHint')}</div>
      </div>
      <div className="oauth-fields">
        <input value={uri} readOnly spellCheck={false} aria-label={t('set.oauth.redirectTitle')} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={() => void copy()}>{t('set.oauth.copy')}</button>
      </div>
    </div>
  )
}

export default function OAuthClientsSettings() {
  const toast = useStore((s) => s.toast)
  const [info, setInfo] = useState<OAuthClientsInfo | null>(null)
  const [gid, setGid] = useState('')
  const [gsecret, setGsecret] = useState('')
  const [mid, setMid] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void rpc.call('oauthGetClients', {}).then((c) => {
      setInfo(c)
      setGid(c.googleClientId)
      setMid(c.microsoftClientId)
    })
  }, [])

  const save = async () => {
    try {
      const c = await rpc.call('oauthSetClients', { googleClientId: gid, googleClientSecret: gsecret || undefined, microsoftClientId: mid })
      setInfo(c)
      setGsecret('')
      toast(t('set.oauth.saved'), 'info')
    } catch (e) {
      toast((e as Error).message)
    }
  }

  if (!info) return null
  const web = platform.kind === 'web'
  const dirty = gid !== info.googleClientId || mid !== info.microsoftClientId || !!gsecret

  return (
    <div className="set-group oauth-clients">
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">
            {t('set.oauth.title')}{' '}
            <span className={`subs-tag ${info.googleReady ? 'ok' : 'dim'}`}>Google {info.googleReady ? t('set.oauth.ready') : t('set.oauth.missing')}</span>{' '}
            <span className={`subs-tag ${info.microsoftReady ? 'ok' : 'dim'}`}>Microsoft {info.microsoftReady ? t('set.oauth.ready') : t('set.oauth.missing')}</span>
          </div>
          <div className="sf-h">{t('set.oauth.intro')}</div>
        </div>
        <div className="sf-c">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? t('set.oauth.hide') : t('action.edit')}
          </button>
        </div>
      </div>
      {open && (
        <>
          {web && <RedirectUri />}
          <div className="set-field set-field-col">
            <div className="sf-l">
              <div className="sf-t">Google</div>
              <div className="sf-h">
                {rich(t('set.oauth.googleSteps'), { desktopApp: <b>Desktop app</b>, scope: <code>https://mail.google.com/</code> })}
              </div>
              {web && <div className="sf-h">{rich(t('set.oauth.webGoogle'), { webApp: <b>Web application</b> })}</div>}
              <div className="sf-h">
                {rich(t('pim.oauth.googleNote'), {
                  scopes: (
                    <>
                      <code>calendar</code>, <code>carddav</code>
                    </>
                  ),
                  apis: <b>Google Calendar API, CalDAV API, Google Contacts CardDAV API</b>
                })}
              </div>
            </div>
            <div className="oauth-fields">
              <input value={gid} onChange={(e) => setGid(e.target.value)} placeholder="Client ID (….apps.googleusercontent.com)" spellCheck={false} aria-label="Google Client ID" />
              <input
                type="password"
                value={gsecret}
                onChange={(e) => setGsecret(e.target.value)}
                placeholder={info.googleHasSecret ? t('set.oauth.secretStored') : 'Client secret'}
                autoComplete="off"
                aria-label="Google Client secret"
              />
            </div>
          </div>
          <div className="set-field set-field-col">
            <div className="sf-l">
              <div className="sf-t">Microsoft (Outlook.com / Microsoft 365)</div>
              <div className="sf-h">
                {rich(t('set.oauth.microsoftSteps'), {
                  accountType: <b>{t('set.oauth.msAccountType')}</b>,
                  platform: <b>Mobile and desktop applications</b>,
                  redirect: <code>http://localhost</code>,
                  permissions: (
                    <>
                      <code>IMAP.AccessAsUser.All</code>, <code>SMTP.Send</code>, <code>offline_access</code>
                    </>
                  )
                })}
              </div>
              {web && <div className="sf-h">{rich(t('set.oauth.webMicrosoft'), { platform: <b>Mobile and desktop applications</b> })}</div>}
              <div className="sf-h">
                {rich(t('pim.oauth.microsoftNote'), {
                  permissions: (
                    <>
                      <code>Contacts.ReadWrite</code>, <code>Calendars.ReadWrite</code>
                    </>
                  )
                })}
              </div>
            </div>
            <div className="oauth-fields">
              <input value={mid} onChange={(e) => setMid(e.target.value)} placeholder="Application (client) ID" spellCheck={false} aria-label="Microsoft Client ID" />
            </div>
          </div>
          <div className="set-field">
            <div className="sf-l">
              <div className="sf-h">{t('set.oauth.storedNote')}</div>
            </div>
            <div className="sf-c">
              <button type="button" className="primary" onClick={() => void save()} disabled={!dirty}>
                {t('action.save')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
