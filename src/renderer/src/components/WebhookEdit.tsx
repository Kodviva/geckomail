import { useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import Modal from './Modal'
import { t } from '../../../shared/i18n'

export default function WebhookEdit() {
  const editWebhookId = useStore((s) => s.editWebhookId)
  const setEditWebhook = useStore((s) => s.setEditWebhook)
  const webhooks = useStore((s) => s.webhooks)
  const refreshWebhooks = useStore((s) => s.refreshWebhooks)
  const toast = useStore((s) => s.toast)

  const isNew = editWebhookId === 'new'
  const existing = !isNew ? webhooks.find((w) => w.id === editWebhookId) : undefined

  const [name, setName] = useState(existing?.name ?? '')
  const [url, setUrl] = useState(existing?.url ?? '')
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)

  if (!isNew && !existing) return null

  const save = async () => {
    if (!name.trim() || !url.trim()) {
      toast(t('auto.webhook.required'), 'error')
      return
    }
    setBusy(true)
    try {
      if (isNew) {
        const created = await rpc.call('createWebhook', { name: name.trim(), url: url.trim(), secret: secret.trim() || null })
        await refreshWebhooks()
        toast(t('auto.webhook.created'), 'info')
        setEditWebhook(created.id) // aynı modalda edit moduna geç — Test Et hemen kullanılabilsin
      } else if (existing) {
        await rpc.call('updateWebhook', {
          id: existing.id,
          patch: { name: name.trim(), url: url.trim(), enabled, ...(secret.trim() ? { secret: secret.trim() } : {}) }
        })
        await refreshWebhooks()
        toast(t('auto.webhook.updated'), 'info')
        setEditWebhook(null)
      }
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    if (!existing) return
    setTesting(true)
    try {
      const res = await rpc.call('testWebhook', { id: existing.id })
      setTestResult(res)
      await refreshWebhooks()
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal onClose={() => setEditWebhook(null)} confirmOnDirty>
        <div className="modal-title">{isNew ? t('auto.webhooks.new') : name || t('auto.common.webhook')}</div>
        <label>
          {t('auto.webhook.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label>
          {t('auto.webhook.url')}
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label>
          {t('auto.webhook.secret')}
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={existing?.hasSecret ? t('auto.webhook.secretKeep') : ''} />
        </label>
        {!isNew && (
          <label className="check-row">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>{t('auto.common.enabled')}</span>
          </label>
        )}
        {!isNew && existing && (
          <div className="test-row">
            <button type="button" onClick={() => void runTest()} disabled={testing}>
              {testing ? t('auto.webhook.sending') : t('auto.common.test')}
            </button>
            {testResult && (
              <span className={testResult.ok ? 'auth-hint' : 'err-text'}>
                {testResult.ok ? (
                  <>
                    <svg className="icon sm"><use href="#i-check" /></svg> {t('auto.webhook.testOk', { status: String(testResult.status ?? '') })}
                  </>
                ) : (
                  <>
                    <svg className="icon sm"><use href="#i-x" /></svg> {t('auto.webhook.testFailed', { error: testResult.error ?? String(testResult.status ?? '') })}
                  </>
                )}
              </span>
            )}
          </div>
        )}
        <div className="modal-foot">
          <button onClick={() => setEditWebhook(null)}>{t('action.cancel')}</button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {isNew ? t('auto.common.create') : t('action.save')}
          </button>
        </div>
    </Modal>
  )
}
