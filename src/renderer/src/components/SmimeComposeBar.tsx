// Oluşturucu: İmzala / Şifrele. Denetim yalnız S/MIME açıkken çalışır; varsayılan oluşturucu RPC çağırmaz, uyarı göstermez.
import { useEffect, useState } from 'react'
import type { RecipientStatus } from '../../../shared/smime'
import { t } from '../../../shared/i18n'
import { platform } from '../platform'
import { rpc } from '../rpcClient'
import { composerAddresses, setEncrypt, smimeCheckKey, smimeSendBlock, type SmimeCheckResult } from '../smimeCompose'
import { useStore } from '../store'
import type { ComposerState } from '../store/types'

const CHECK_DELAY_MS = 400

/** Gönder engeli; sonuç anahtarla eşleşmezse (adres yeni değişti) denetim bitene dek kapalıdır */
export function useSmimeCheck(c: ComposerState | null): { check: SmimeCheckResult | null; block: string | null } {
  const vaultState = useStore((s) => s.vaultState)
  const [check, setCheck] = useState<SmimeCheckResult | null>(null)
  const on = !!c && (!!c.smimeSign || !!c.smimeEncrypt)
  const key = c ? smimeCheckKey(c) : ''
  const accountId = c?.fromAccountId
  useEffect(() => {
    if (!on || accountId == null) return
    let cancelled = false
    const addresses = (JSON.parse(key) as [number, string[]])[1]
    const timer = setTimeout(() => {
      void rpc.call('smimeCheckRecipients', { accountId, addresses }).then(
        (res) => { if (!cancelled) setCheck({ key, res }) },
        () => { if (!cancelled) setCheck({ key, res: null }) }
      )
    }, CHECK_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      setCheck(null)
    }
  }, [on, key, accountId, vaultState])
  return { check, block: c ? smimeSendBlock(c, check, key) : null }
}

export default function SmimeComposeBar({ c, check, block }: { c: ComposerState; check: SmimeCheckResult | null; block: string | null }) {
  const setComposer = useStore((s) => s.setComposer)
  const sending = useStore((s) => s.sending)
  const setVaultPromptOpen = useStore((s) => s.setVaultPromptOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const encrypt = !!c.smimeEncrypt
  const blocked = check?.res?.blocked ?? null
  const toggleEncrypt = (): void => {
    if (encrypt && c.smimeSensitive && !window.confirm(t('smime.compose.encryptOffConfirm'))) return
    setComposer(setEncrypt(c, !encrypt))
  }
  const statuses = encrypt ? (check?.res?.recipients ?? []) : []
  const chip = (status: RecipientStatus): string => (status === 'ok' ? 'ok' : 'bad')
  return (
    <div className="smime-bar">
      <div className="chip-row">
        <button type="button" className="chip" aria-pressed={!!c.smimeSign || encrypt} disabled={sending || encrypt} onClick={() => setComposer({ ...c, smimeSign: !c.smimeSign })}>
          <svg className="icon xs"><use href="#i-seal" /></svg> {t('smime.compose.sign')}
        </button>
        <button type="button" className="chip" aria-pressed={encrypt} disabled={sending} onClick={toggleEncrypt}>
          <svg className="icon xs"><use href="#i-lock" /></svg> {t('smime.compose.encrypt')}
        </button>
        {block && <span className="smime-block" role="status">{block}</span>}
        {blocked === 'vault_locked' && block && (
          <button type="button" className="link-btn inline" onClick={() => setVaultPromptOpen(true)}>{t('smime.detail.unlock')}</button>
        )}
        {blocked === 'no_identity' && block && (
          <button type="button" className="link-btn inline" onClick={() => setSettingsOpen(true, 'kasa')}>{t('smime.compose.toSettings')}</button>
        )}
      </div>
      {statuses.length > 0 && (
        <div className="chip-row">
          {statuses.map((r) => (
            <span key={r.address} className={`smime-recipient ${chip(r.status)}`}>{r.address}: {t(`smime.recipient.${r.status}`)}</span>
          ))}
        </div>
      )}
      {encrypt && (
        <p className="smime-hint">
          {t('smime.compose.subjectNote')}
          {platform.kind !== 'electron' ? ` ${t('smime.compose.serverNote')}` : ''}
        </p>
      )}
      {encrypt && composerAddresses({ to: '', cc: '', bcc: c.bcc }).length > 0 && <p className="smime-hint">{t('smime.compose.bccNote')}</p>}
    </div>
  )
}
