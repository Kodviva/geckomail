// İleti başlığındaki S/MIME rozetleri ve ayrıntı penceresi. Durum motorda belirlenir; burada yalnız gösterilir.
import { useState } from 'react'
import { smimeBadges, type SmimeInfo, type SmimeNote, type SmimeTone } from '../../../shared/smime'
import { fmtDateTime, t } from '../../../shared/i18n'
import { platform } from '../platform'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import { usePopover } from './usePopover'

const TONE_ICON: Record<SmimeTone, string> = { ok: 'i-check-circle', warn: 'i-alert', bad: 'i-alert', muted: 'i-lock' }
const DETAIL_NOTES: SmimeNote[] = ['cert_expired_since', 'revocation_unknown', 'header_mismatch', 'too_large']

export function SmimeDetail({ info, messageId }: { info: SmimeInfo; messageId: number }) {
  const toast = useStore((s) => s.toast)
  const refreshBody = useStore((s) => s.refreshBody)
  const [busy, setBusy] = useState(false)
  const signer = info.signer
  const save = async (fingerprint: string): Promise<void> => {
    if (!window.confirm(t('smime.detail.saveConfirm', { fingerprint }))) return
    setBusy(true)
    try {
      await rpc.call('smimeSaveContactCert', { messageId, fingerprint })
      toast(t('smime.detail.saved'), 'info')
      void refreshBody()
    } catch (e) {
      toast(String((e as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="menu smime-detail" role="dialog" aria-label={t('smime.detail.title')}>
      {smimeBadges(info).map((b) => <p key={b.labelKey}>{t(b.detailKey)}</p>)}
      {signer && (
        <dl>
          <dt>{t('smime.detail.address')}</dt><dd>{signer.email ?? '—'}</dd>
          <dt>{t('smime.detail.subject')}</dt><dd>{signer.subject}</dd>
          <dt>{t('smime.detail.issuer')}</dt><dd>{signer.issuer}</dd>
          <dt>{t('smime.detail.fingerprint')}</dt><dd className="smime-fp">{signer.fingerprint}</dd>
          <dt>{t('smime.detail.validity')}</dt><dd>{fmtDateTime(signer.notBefore)} – {fmtDateTime(signer.notAfter)}</dd>
        </dl>
      )}
      {DETAIL_NOTES.filter((n) => info.notes.includes(n)).map((n) => <p key={n} className="smime-note">{t(`smime.note.${n}`)}</p>)}
      {info.canSaveCert && signer && !platform.native && (
        <button type="button" disabled={busy} onClick={() => void save(signer.fingerprint)}>{t('smime.detail.save')}</button>
      )}
    </div>
  )
}

export default function SmimeBadges({ info, messageId }: { info: SmimeInfo; messageId: number }) {
  const { open, ref, toggle } = usePopover<HTMLDivElement>()
  const setVaultPromptOpen = useStore((s) => s.setVaultPromptOpen)
  const badges = smimeBadges(info)
  if (!badges.length) return null
  return (
    <div className="smime-row menu-anchor" ref={ref}>
      {badges.map((b) => (
        <button key={b.labelKey} type="button" className={`smime-badge ${b.tone}`} aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>
          <svg className="icon xs"><use href={`#${TONE_ICON[b.tone]}`} /></svg> {t(b.labelKey)}
        </button>
      ))}
      {info.enc === 'locked' && (
        <button type="button" className="btn btn-sm" onClick={() => setVaultPromptOpen(true)}>{t('smime.detail.unlock')}</button>
      )}
      {open && <SmimeDetail info={info} messageId={messageId} />}
    </div>
  )
}
