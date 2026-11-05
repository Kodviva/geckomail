// Kullanıcı betiğinde bir komutun gerçekten kullanılıp kullanılmadığı: yorum, dizgi ve text: blokları
// atlanır, yalnız komut konumundaki belirteç sayılır. Tam ayrıştırıcı değil, sözdizimi denetimi sunucuda.

const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch)
const isIdent = (ch: string): boolean => /\w/.test(ch)

/** text: bloğundan sonraki konum: tek noktalı satırın sonu ya da metnin sonu */
function skipMultiline(text: string, from: number): number {
  let lineStart = text.indexOf('\n', from)
  while (lineStart !== -1) {
    const next = text.indexOf('\n', lineStart + 1)
    const line = text.slice(lineStart + 1, next === -1 ? text.length : next)
    if (line === '.' || line === '.\r') return next === -1 ? text.length : next + 1
    lineStart = next
  }
  return text.length
}

export function scriptUses(text: string, command: 'vacation' | 'include'): boolean {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '#') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end + 1
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else if (ch === '"') {
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
    } else if (ch === ':') {
      i++ // etiket: ardındaki ad komut değildir
      while (i < text.length && isIdent(text[i])) i++
    } else if (isIdentStart(ch)) {
      const start = i
      while (i < text.length && isIdent(text[i])) i++
      const word = text.slice(start, i).toLowerCase()
      if (word === command) return true
      if (word === 'text' && text[i] === ':') i = skipMultiline(text, i)
    } else {
      i++
    }
  }
  return false
}
