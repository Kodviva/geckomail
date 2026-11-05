// İşletim sistemine göre arayüz metni: kısayol simgeleri ve biyometri adı. Bağımlılıksız; renderer, main ve sync kullanır.
export type UiOs = 'mac' | 'windows' | 'other'

/** process.platform ya da html[data-os] değerinden */
export function uiOsOf(os: string | undefined): UiOs {
  if (os === 'darwin') return 'mac'
  return os === 'win32' ? 'windows' : 'other'
}

/** windows: '⌘' → 'Ctrl+'. "⌘+tık" gibi kendi artısı olan metinde çift artı oluşmaz. */
export function platformText(s: string, os: UiOs): string {
  if (os !== 'windows') return s
  return s.replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘\+?/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/Ctrl\+↵/g, 'Ctrl+Enter')
}

export function biometricName(os: UiOs): 'Touch ID' | 'Windows Hello' | null {
  if (os === 'mac') return 'Touch ID'
  return os === 'windows' ? 'Windows Hello' : null
}
