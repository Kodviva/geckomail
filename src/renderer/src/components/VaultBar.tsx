import { useState, type KeyboardEvent } from 'react'
import { useStore } from '../store'
import Modal from './Modal'
import { t } from '../../../shared/i18n'

// Kasa kilitliyken üstte ince bir şerit + açma modalı. Yalnızca vaultState==='locked' iken görünür.
export default function VaultBar() {
  const vaultState = useStore((s) => s.vaultState)
  const promptOpen = useStore((s) => s.vaultPromptOpen)
  const setPromptOpen = useStore((s) => s.setVaultPromptOpen)
  const unlockVault = useStore((s) => s.unlockVault)
  const unlockVaultBiometric = useStore((s) => s.unlockVaultBiometric)
  const biometricEnabled = useStore((s) => s.vaultBiometricEnabled)
  const touchIdAvailable = useStore((s) => s.touchIdAvailable)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const canBiometric = biometricEnabled && touchIdAvailable

  // banner artık sidebar akışında (AccountsPanel); burada yalnızca açma modalı
  if (vaultState !== 'locked' || !promptOpen) return null

  const submit = async () => {
    if (!password) return
    setBusy(true)
    const ok = await unlockVault(password)
    setBusy(false)
    if (ok) setPassword('')
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
  }

  return (
    <Modal onClose={() => setPromptOpen(false)} className="vault-modal" onKeyDown={onKeyDown}>
        <div className="modal-title">
          <svg className="icon"><use href="#i-lock" /></svg> {t('acct.vault.unlockTitle')}
        </div>
        <p className="auth-hint">{t('acct.vault.unlockHint')}</p>
        {canBiometric && (
          <button
            type="button"
            className="touch-id-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await unlockVaultBiometric()
              setBusy(false)
            }}
          >
            <svg className="icon"><use href="#i-unlock" /></svg> {t('acct.vault.unlockTouchId')}
          </button>
        )}
        <label>
          {t('acct.vault.password')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus disabled={busy} />
        </label>
        <div className="modal-foot">
          <button onClick={() => setPromptOpen(false)}>{t('action.cancel')}</button>
          <button className="primary" onClick={() => void submit()} disabled={busy || !password}>
            {busy ? t('acct.vault.unlocking') : t('acct.vault.unlock')}
          </button>
        </div>
    </Modal>
  )
}
