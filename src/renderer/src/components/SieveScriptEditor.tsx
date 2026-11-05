// Ham Sieve düzenleyici: yalnız var olan betikler (K20). GeckoMail betikleri salt okunur, denetim sunucuda,
// kayıt iyimser kilitli ve önce sunucuda yedek alınır. Betik içeriği yerelde saklanmaz.
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import Modal from './Modal'

type Script = { name: string; active: boolean; managed: boolean }
type Open = { name: string; content: string; sha: string; managed: boolean }
type Note = { kind: 'ok' | 'warn' | 'err'; text: string }

export default function SieveScriptEditor({ accountId, onClose }: { accountId: number; onClose(): void }) {
  const toast = useStore((s) => s.toast)
  const [scripts, setScripts] = useState<Script[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Open | null>(null)
  const [text, setText] = useState('')
  const [note, setNote] = useState<Note | null>(null)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)

  const list = useCallback(
    (): Promise<void> =>
      rpc.call('sieveListScripts', { accountId }).then(
        (r) => {
          setScripts(r)
          setError(null)
        },
        (e: Error) => setError(e.message)
      ),
    [accountId]
  )

  useEffect(() => void list(), [list])

  const pick = async (name: string): Promise<void> => {
    setBusy(true)
    setNote(null)
    setConflict(false)
    try {
      const s = await rpc.call('sieveGetScript', { accountId, name })
      setOpen({ name, ...s })
      setText(s.content)
    } catch (e) {
      setNote({ kind: 'err', text: String((e as Error).message) })
    } finally {
      setBusy(false)
    }
  }

  const check = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const r = await rpc.call('sieveCheckScript', { accountId, content: text })
      if (!r.ok) setNote({ kind: 'err', text: r.error ?? t('set.sieve.checkFailed') })
      else setNote(r.warning ? { kind: 'warn', text: r.warning } : { kind: 'ok', text: t('set.sieve.checkOk') })
    } catch (e) {
      setNote({ kind: 'err', text: String((e as Error).message) })
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!open) return
    setBusy(true)
    setNote(null)
    try {
      const r = await rpc.call('sieveSaveScript', { accountId, name: open.name, content: text, baseSha: open.sha })
      if (r.conflict) {
        setConflict(true)
      } else if (!r.ok) {
        setNote({ kind: 'err', text: r.error ?? t('set.sieve.saveFailed') })
      } else {
        toast(t('set.sieve.saved', { backup: r.backupName ?? '' }), 'info')
        // sunucunun sakladığı metin ve liste kaydın yanıtında: yeniden login yok
        if (r.content !== undefined && r.sha !== undefined) {
          setOpen({ ...open, content: r.content, sha: r.sha })
          setText(r.content)
        }
        if (r.scripts) setScripts(r.scripts)
      }
    } catch (e) {
      setNote({ kind: 'err', text: String((e as Error).message) })
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <Modal onClose={onClose} className="sieve-dialog sieve-editor" confirmOnDirty>
      <div className="modal-title">{t('set.sieve.editor.title')}</div>
      {error && <div className="err-text" data-testid="sieve-editor-error">{error}</div>}
      {scripts && !scripts.length && <div className="empty-note">{t('set.sieve.editor.empty')}</div>}
      <div className="sieve-script-list" role="listbox" aria-label={t('set.sieve.scripts')}>
        {scripts?.map((s) => (
          <button key={s.name} role="option" aria-selected={open?.name === s.name} className={`chip ${open?.name === s.name ? 'on' : ''}`} disabled={busy} onClick={() => void pick(s.name)}>
            {s.name}
            {s.active ? ` · ${t('set.sieve.editor.active')}` : ''}
            {s.managed ? ` · ${t('set.sieve.editor.managed')}` : ''}
          </button>
        ))}
      </div>
      {open && (
        <>
          {open.managed && <small className="sieve-meta">{t('set.sieve.editor.readonly')}</small>}
          <textarea
            className="sieve-source"
            aria-label={t('set.sieve.editor.source')}
            value={text}
            readOnly={open.managed}
            spellCheck={false}
            rows={14}
            onChange={(e) => setText(e.target.value)}
          />
          {conflict && (
            <div className="sieve-meta sieve-warn" data-testid="sieve-conflict">
              {t('set.sieve.editor.conflict')} <button onClick={() => void pick(open.name)}>{t('set.sieve.editor.reload')}</button>
            </div>
          )}
        </>
      )}
      {note && <div className={note.kind === 'err' ? 'err-text' : 'sieve-meta'} data-testid="sieve-check-result">{note.text}</div>}
      <div className="modal-foot">
        <button onClick={onClose}>{t('action.close')}</button>
        {open && !open.managed && (
          <>
            <button disabled={busy} onClick={() => void check()}>{t('set.sieve.editor.check')}</button>
            <button className="primary" disabled={busy || conflict || text === open.content} onClick={() => void save()}>{t('action.save')}</button>
          </>
        )}
      </div>
    </Modal>,
    document.body
  )
}
