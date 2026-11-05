import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { LoginItemApi } from '../platform'

type State = Awaited<ReturnType<LoginItemApi['get']>>

/** Ayarlar › Genel: oturum açılışında başlat. Store paketinde anahtar yerine Windows ayarına yönlendirir */
export default function LoginItemSetting({ api }: { api: LoginItemApi }) {
  const [state, setState] = useState<State>(null)
  useEffect(() => {
    void api.get().then(setState).catch(() => {})
  }, [api])
  if (!state || state.support === 'none') return null
  const toggle = async (enabled: boolean): Promise<void> => {
    if (await api.set(enabled)) setState({ ...state, enabled })
  }
  return (
    <div className="set-group">
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('set.login.title')}</div>
          <div className="sf-h">{t(state.support === 'native' ? 'set.login.hint' : 'set.login.store')}</div>
        </div>
        {state.support === 'native' && (
          <div className="sf-c">
            <input type="checkbox" aria-label={t('set.login.title')} checked={state.enabled} onChange={(e) => void toggle(e.target.checked)} />
          </div>
        )}
      </div>
    </div>
  )
}
