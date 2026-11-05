// Ayarlar › Kişiler ve Takvim: bağlı kaynaklar, durum, şimdi eşitle, kaldır, kişisel DAV ekleme. Parola yalnız sunucuya gider,
// kaynak bilgisi adres ve sır taşımaz.
import { useCallback, useEffect, useState } from 'react'
import type { PimSourceInfo } from '../../../shared/pim'
import { t } from '../../../shared/i18n'
import { fmtRelative } from '../accountHealth'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import { PIM_TOAST } from './useOAuthConnect'

const STATUS_KEY: Record<PimSourceInfo['status'], string> = { ok: 'pim.set.statusOk', needs_reauth: 'pim.set.statusReauth', error: 'pim.set.statusError' }

export default function PimSourcesSettings() {
  const toast = useStore((s) => s.toast)
  const [sources, setSources] = useState<PimSourceInfo[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<number | 'add' | null>(null)
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const [renewing, setRenewing] = useState<Record<number, string>>({})
  const load = useCallback((): void => {
    void rpc.call('listPimSources', {}).then(
      (list) => {
        setSources(list)
        setLoadFailed(false)
      },
      () => setLoadFailed(true)
    )
  }, [])

  useEffect(load, [load])
  useEffect(() => rpc.on('pim:changed', load), [load])

  const run = async (id: number, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    try {
      await fn()
      load()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const renew = async (id: number): Promise<void> => {
    const pw = renewing[id]
    setRenewing((r) => ({ ...r, [id]: '' }))
    await run(id, async () => {
      const { status } = await rpc.call('updatePersonalDavPassword', { id, password: pw })
      if (status !== 'connected') toast(t('pim.set.badPassword'))
    })
  }

  const add = async (): Promise<void> => {
    setBusy('add')
    try {
      const { status } = await rpc.call('addPersonalDav', { url, username, password })
      setPassword('')
      toast(t(status === 'needsConsent' ? 'pim.set.badPassword' : PIM_TOAST[status]), status === 'connected' ? 'info' : undefined)
      if (status === 'connected') {
        setAdding(false)
        setUrl('')
        setUsername('')
        load()
      }
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!sources) {
    if (!loadFailed) return null
    return (
      <div className="set-group">
        <div className="set-field">
          <div className="sf-c">
            <span className="auth-error" role="alert">{t('pim.set.loadFailed')}</span>
            <button type="button" onClick={load}>{t('action.retry')}</button>
          </div>
        </div>
      </div>
    )
  }

  const remote = sources.filter((x) => x.kind !== 'local')
  return (
    <div className="set-group" data-testid="pim-sources">
      {!remote.length && (
        <div className="set-field">
          <div className="sf-l"><div className="sf-h">{t('pim.set.empty')}</div></div>
        </div>
      )}
      {remote.map((x) => (
        <div className="set-field" key={x.id}>
          <div className="sf-l">
            <div className="sf-t">
              {x.label}{' '}
              <span className={`subs-tag ${x.status === 'ok' ? 'ok' : 'dim'}`}>{t(STATUS_KEY[x.status])}</span>
            </div>
            <div className="sf-h">
              {x.lastSyncAt ? t('pim.set.lastSync', { when: fmtRelative(x.lastSyncAt) }) : t('pim.set.neverSynced')}
              {x.status !== 'ok' && x.lastError ? ` — ${x.lastError}` : ''}
            </div>
          </div>
          {x.canManage && (
            <div className="sf-c">
              {x.status === 'needs_reauth' && x.personal && (
                <form className="pim-repassword" onSubmit={(e) => { e.preventDefault(); void renew(x.id) }}>
                  <input type="password" autoComplete="current-password" aria-label={t('pim.set.newPassword')} placeholder={t('pim.set.newPassword')} value={renewing[x.id] ?? ''} onChange={(e) => setRenewing((r) => ({ ...r, [x.id]: e.target.value }))} />
                  <button type="submit" disabled={busy === x.id || !renewing[x.id]}>{t('pim.set.updatePassword')}</button>
                </form>
              )}
              {x.status !== 'needs_reauth' && (
                <button type="button" disabled={busy === x.id} onClick={() => void run(x.id, () => rpc.call('syncPimSource', { id: x.id }))}>
                  {t('pim.set.syncNow')}
                </button>
              )}
              <button type="button" disabled={busy === x.id} onClick={() => void run(x.id, () => rpc.call('removePimSource', { id: x.id }))}>
                {t('action.remove')}
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('pim.set.addTitle')}</div>
          <div className="sf-h">{t('pim.set.addHint')}</div>
        </div>
        <div className="sf-c">
          <button type="button" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>{adding ? t('action.cancel') : t('action.add')}</button>
        </div>
      </div>
      {adding && (
        <form
          className="set-field set-field-col"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <div className="oauth-fields">
            <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://dav.example.com/" spellCheck={false} aria-label={t('pim.set.url')} />
            <input required value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('pim.set.username')} autoComplete="off" spellCheck={false} aria-label={t('pim.set.username')} />
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('pim.set.password')} autoComplete="new-password" aria-label={t('pim.set.password')} />
            <button type="submit" className="primary" disabled={busy === 'add'}>{t('action.add')}</button>
          </div>
        </form>
      )}
    </div>
  )
}
