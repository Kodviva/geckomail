// Aynı e-postayı taşıyan kartlar için öneri; birleştirme yalnız tıklamayla.
import { useEffect, useState } from 'react'
import type { ContactDetail, ContactSummary } from '../../../../shared/pim'
import { t } from '../../../../shared/i18n'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'

const MAX_CHECKED = 3

export default function MergePrompt({ contact, onMerged }: { contact: ContactDetail; onMerged: () => void }) {
  const toast = useStore((s) => s.toast)
  const [same, setSame] = useState<ContactSummary[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (contact.kind !== 'individual' || !contact.emails.length) return
    let live = true
    const wanted = contact.emails.slice(0, MAX_CHECKED).map((e) => e.addr.toLowerCase())
    void Promise.all(wanted.map((addr) => rpc.call('listContacts', { collectionIds: [contact.collectionId], query: addr, limit: 20 }))).then(
      (lists) => {
        if (!live) return
        const seen = new Map<number, ContactSummary>()
        for (const c of lists.flat()) if (c.id !== contact.id && c.kind === 'individual' && c.emails.some((e) => wanted.includes(e.addr.toLowerCase()))) seen.set(c.id, c)
        setSame([...seen.values()])
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [contact])

  if (!same.length) return null
  const merge = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await rpc.call('mergeContacts', { keepId: contact.id, dropIds: same.map((c) => c.id) })
      if (!r.ok) toast(t('contacts.conflict'))
      setSame([])
      onMerged()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pim-banner" role="status">
      <span>{t('contacts.merge.prompt', { names: same.map((c) => c.fullName).join(', ') })}</span>
      <button type="button" className="sm" disabled={busy} onClick={() => void merge()}>{t('contacts.merge.action')}</button>
    </div>
  )
}
