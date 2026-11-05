import { useEffect, useRef } from 'react'
import DOMPurify from 'dompurify'
import { t } from '../../../shared/i18n'

const PASTE_SANITIZE = {
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'base', 'link', 'style', 'img'],
  FORBID_ATTR: ['srcset', 'ping', 'formaction', 'class', 'id']
}

function escapeToHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

// ExecCommand kullanımdan kalkmış görünse de Chromium'da çalışır;
// tam editör kütüphanesi (~200KB) yerine 60 satır yeter
export default function RichEditor({
  initialHtml,
  initialText,
  onChange,
  disabled = false
}: {
  initialHtml: string
  initialText: string
  onChange: (html: string) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const start = initialHtml.trim() ? initialHtml : escapeToHtml(initialText)
    ref.current.innerHTML = DOMPurify.sanitize(start, PASTE_SANITIZE)
    onChange(ref.current.innerHTML)
    // yalnızca mount'ta doldurulur; sonrası kullanıcı girdisi
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const exec = (cmd: string, val?: string) => {
    ref.current?.focus()
    document.execCommand(cmd, false, val)
    if (ref.current) onChange(ref.current.innerHTML)
  }

  return (
    <div className="rich-wrap">
      <div className="rich-toolbar">
        <button type="button" disabled={disabled} onMouseDown={(e) => { e.preventDefault(); exec('bold') }} title={t('compose.rich.bold')}><b>{t('compose.rich.boldGlyph')}</b></button>
        <button type="button" disabled={disabled} onMouseDown={(e) => { e.preventDefault(); exec('italic') }} title={t('compose.rich.italic')}><i>{t('compose.rich.italicGlyph')}</i></button>
        <button type="button" disabled={disabled} onMouseDown={(e) => { e.preventDefault(); exec('underline') }} title={t('compose.rich.underline')}><u>{t('compose.rich.underlineGlyph')}</u></button>
        <button
          type="button"
          disabled={disabled}
          onMouseDown={(e) => {
            e.preventDefault()
            const url = window.prompt(t('compose.rich.linkPrompt'))
            if (url && /^https?:\/\//i.test(url)) exec('createLink', url)
          }}
          title={t('compose.rich.link')}
        >
          <svg className="icon sm"><use href="#i-link" /></svg>
        </button>
        <button type="button" disabled={disabled} onMouseDown={(e) => { e.preventDefault(); exec('insertUnorderedList') }} title={t('compose.rich.bulletList')}>•≡</button>
        <button type="button" disabled={disabled} onMouseDown={(e) => { e.preventDefault(); exec('insertOrderedList') }} title={t('compose.rich.numberedList')}>1≡</button>
        <button type="button" disabled={disabled} onMouseDown={(e) => { e.preventDefault(); exec('removeFormat') }} title={t('compose.rich.clearFormat')}>
          <svg className="icon sm"><use href="#i-x" /></svg>
        </button>
      </div>
      <div
        ref={ref}
        className="rich-editor"
        contentEditable={!disabled}
        aria-disabled={disabled || undefined}
        suppressContentEditableWarning
        onInput={() => ref.current && onChange(ref.current.innerHTML)}
        onPaste={(e) => {
          e.preventDefault()
          const htmlData = e.clipboardData.getData('text/html')
          const textData = e.clipboardData.getData('text/plain')
          const clean = htmlData ? DOMPurify.sanitize(htmlData, PASTE_SANITIZE) : escapeToHtml(textData)
          document.execCommand('insertHTML', false, clean)
          if (ref.current) onChange(ref.current.innerHTML)
        }}
      />
    </div>
  )
}
