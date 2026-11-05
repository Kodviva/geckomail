// Desteklenen diller: karşılama ekranındaki sırayla. flag: bayrak emojisi; intl: tarih/sayı etiketi.
export type Locale = 'tr' | 'en' | 'zh' | 'hi' | 'es' | 'fr' | 'ar' | 'pt' | 'ru' | 'ja' | 'de'

export interface LocaleMeta {
  id: Locale
  /** kendi dilinde adı */
  name: string
  flag: string
  intl: string
  dir: 'ltr' | 'rtl'
  /** karşılama ekranında dönen selamlama */
  hello: string
}

export const LOCALES: LocaleMeta[] = [
  { id: 'tr', name: 'Türkçe', flag: '🇹🇷', intl: 'tr-TR', dir: 'ltr', hello: 'Merhaba' },
  { id: 'en', name: 'English', flag: '🇬🇧', intl: 'en-US', dir: 'ltr', hello: 'Hello' },
  { id: 'zh', name: '中文', flag: '🇨🇳', intl: 'zh-CN', dir: 'ltr', hello: '你好' },
  { id: 'hi', name: 'हिन्दी', flag: '🇮🇳', intl: 'hi-IN', dir: 'ltr', hello: 'नमस्ते' },
  { id: 'es', name: 'Español', flag: '🇪🇸', intl: 'es-ES', dir: 'ltr', hello: 'Hola' },
  { id: 'fr', name: 'Français', flag: '🇫🇷', intl: 'fr-FR', dir: 'ltr', hello: 'Bonjour' },
  { id: 'ar', name: 'العربية', flag: '🇸🇦', intl: 'ar-SA-u-nu-latn', dir: 'rtl', hello: 'مرحبا' },
  { id: 'pt', name: 'Português', flag: '🇧🇷', intl: 'pt-BR', dir: 'ltr', hello: 'Olá' },
  { id: 'ru', name: 'Русский', flag: '🇷🇺', intl: 'ru-RU', dir: 'ltr', hello: 'Привет' },
  { id: 'ja', name: '日本語', flag: '🇯🇵', intl: 'ja-JP', dir: 'ltr', hello: 'こんにちは' },
  { id: 'de', name: 'Deutsch', flag: '🇩🇪', intl: 'de-DE', dir: 'ltr', hello: 'Hallo' }
]
