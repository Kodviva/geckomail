// Ayarlar › Yedek (web, sunucu modu, yalnız yönetici): sunucu yedeği HTTP ile indirilir; geri yükleme dosyası
// yüklenip doğrulanır, sunucu yeniden başlatılınca uygulanır (backupRoutes.ts). Parola yalnız istek gövdesinde.
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { fmtDateTime, t } from '../../../shared/i18n'
import type { BackupResult, ServerBackup } from '../platform'

const ERRORS = new Set(['badPassphrase', 'notABackup', 'tooNew', 'unreadable', 'tooLarge', 'storageFull', 'busy'])

/** Sunucunun reason'ı → arayüz metni (bilinmeyen: HTTP durumu) */
function errorText(r: Extract<BackupResult, { ok: false }>): string {
  if (r.reason === 'passphraseTooShort') return t('set.backup.passTooShort')
  return ERRORS.has(r.reason) ? t(`set.backup.web.err.${r.reason}`) : t('set.backup.web.err.failed', { status: r.status || r.reason })
}

export default function WebBackupSettings({ api }: { api: ServerBackup }) {
  const toast = useStore((s) => s.toast)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [backingUp, setBackingUp] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [restorePass, setRestorePass] = useState('')
  // yüklenen dosya yanlış parolada yeniden kullanılır; dosya değişince yeniden yüklenir
  const [upload, setUpload] = useState<{ file: File; id: string } | null>(null)
  const [restoring, setRestoring] = useState(false)
  // bekleyen geri yükleme: bu ekranda hazırlandıysa hesap sayısı, önceden hazırlanmışsa yalnız zamanı bilinir
  const [staged, setStaged] = useState<{ accounts?: number; at?: number } | null>(null)
  const [restarting, setRestarting] = useState(false)
  // son geri yükleme açılışta bütünlük denetiminden geçmedi
  const [rejectedAt, setRejectedAt] = useState<number | null>(null)

  useEffect(() => {
    void api.status().then((r) => {
      if (!r.ok) return
      if (r.staged) setStaged((s) => s ?? { at: r.stagedAt })
      setRejectedAt(r.rejectedAt ?? null)
    })
  }, [api])

  const cancel = async (): Promise<void> => {
    const r = await api.cancel()
    if (!r.ok) return toast(errorText(r), 'error')
    setStaged(null)
    toast(t('set.backup.web.cancelled'), 'info')
  }

  const backup = async (): Promise<void> => {
    if (pass.length < 8) return toast(t('set.backup.passTooShort'), 'error')
    if (pass !== pass2) return toast(t('set.backup.web.passMismatch'), 'error')
    setBackingUp(true)
    try {
      const r = await api.download(pass)
      if (!r.ok) return toast(errorText(r), 'error')
      if (r.restorable) toast(t('set.backup.web.downloaded'), 'info')
      else toast(t('set.backup.web.notRestorable'), 'error')
      setPass('')
      setPass2('')
    } finally {
      setBackingUp(false)
    }
  }

  const restore = async (): Promise<void> => {
    if (!file) return
    setRestoring(true)
    try {
      let id = upload?.file === file ? upload.id : null
      if (!id) {
        const u = await api.upload(file)
        if (!u.ok) return toast(errorText(u), 'error')
        id = u.uploadId
        setUpload({ file, id })
      }
      const r = await api.stage(id, restorePass)
      if (!r.ok) {
        // yükleme tüketilmedi: doğru parolayla aynı dosya yeniden denenir; bulunamadıysa yeniden yüklenir
        if (r.status === 404) setUpload(null)
        return toast(errorText(r), 'error')
      }
      setUpload(null)
      setRestorePass('')
      setStaged({ accounts: r.accounts })
    } finally {
      setRestoring(false)
    }
  }

  const restart = async (): Promise<void> => {
    setRestarting(true)
    const r = await api.restart()
    if (!r.ok) {
      setRestarting(false)
      return toast(errorText(r), 'error')
    }
    // bildirim 'server:restarting' olayıyla gelir; bağlantı kopar, taşıma yeniden dener
    useStore.setState({ serverRestarting: true })
  }

  return (
    <>
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('set.backup.create')}</div>
          <div className="sf-h">{t('set.backup.web.createHint')}</div>
        </div>
        <div className="sf-c sf-stack">
          <input type="password" aria-label={t('set.backup.web.pass')} placeholder={t('set.backup.web.pass')} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          <input type="password" aria-label={t('set.backup.web.passConfirm')} placeholder={t('set.backup.web.passConfirm')} value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
          <button type="button" onClick={() => void backup()} disabled={backingUp || !pass}>{backingUp ? t('set.backup.working') : t('set.backup.web.download')}</button>
        </div>
      </div>
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('set.backup.restore')}</div>
          <div className="sf-h">{t('set.backup.web.restoreHint')}</div>
          {rejectedAt != null && staged == null && (
            <div className="sf-h" role="status">{t('set.backup.web.lastRejected', { when: fmtDateTime(rejectedAt) })}</div>
          )}
        </div>
        <div className="sf-c sf-stack">
          {staged == null ? (
            <>
              <input type="file" aria-label={t('set.backup.web.file')} accept=".geckobak,.sqlite,application/octet-stream" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <input type="password" aria-label={t('set.backup.restorePass')} placeholder={t('set.backup.restorePass')} value={restorePass} onChange={(e) => setRestorePass(e.target.value)} autoComplete="off" />
              <button type="button" className="danger" onClick={() => void restore()} disabled={restoring || !file}>{restoring ? t('set.backup.web.uploading') : t('set.backup.web.verify')}</button>
            </>
          ) : (
            <>
              <div role="status">
                {staged.accounts != null
                  ? t('set.backup.web.staged', { accounts: staged.accounts })
                  : t('set.backup.web.pendingStaged', { when: staged.at ? fmtDateTime(staged.at) : '' })}
              </div>
              <button type="button" className="danger" onClick={() => void restart()} disabled={restarting}>{t('set.backup.web.restartNow')}</button>
              <button type="button" onClick={() => void cancel()} disabled={restarting}>{t('set.backup.web.cancel')}</button>
            </>
          )}
        </div>
      </div>
    </>
  )
}
