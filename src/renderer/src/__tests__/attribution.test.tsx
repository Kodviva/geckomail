import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PRIVACY_URL, SOURCE_URL } from '../../../shared/brand'
import Attribution from '../components/Attribution'

describe('Attribution', () => {
  it('kaynak ve gizlilik bağlantısı dış sayfada açılır', () => {
    const html = renderToStaticMarkup(<Attribution version="2.0.0" />)
    expect(PRIVACY_URL).toBe('https://kodviva.com/geckomail/gizlilik')
    for (const url of [SOURCE_URL, PRIVACY_URL]) expect(html).toContain(`<a href="${url}" target="_blank" rel="noopener noreferrer">`)
  })
})
