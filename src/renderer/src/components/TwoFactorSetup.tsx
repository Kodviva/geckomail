// 2FA kurulum gövdesi (giriş ekranındaki zorunlu kurulum ve Ayarlar ortak): QR, elle girilecek sır ve kod alanı.
// QR <img src="data:…"> ile konur (innerHTML yok); sır yalnız bileşen ağacında, hiçbir depoya yazılmaz.
import { useMemo } from 'react'
import { t } from '../../../shared/i18n'
import { qrDataUri } from '../qr'

export default function TwoFactorSetup(p: {
  otpauthUri: string
  secretBase32: string
  code: string
  onCode: (v: string) => void
  disabled?: boolean
  autoFocus?: boolean
}) {
  const src = useMemo(() => qrDataUri(p.otpauthUri), [p.otpauthUri])
  // okunaklı olsun diye 4'lü gruplar; doğrulayıcı uygulamalar boşluğu yok sayar
  const grouped = p.secretBase32.replace(/(.{4})(?=.)/g, '$1 ')
  return (
    <div className="tfa-setup">
      <p className="auth-hint">{t('acct.2fa.scanHint')}</p>
      <img className="tfa-qr" src={src} width={180} height={180} alt={t('acct.2fa.qrAlt')} />
      <p className="auth-hint">{t('acct.2fa.manualHint')}</p>
      <code className="auth-command" data-testid="tfa-secret">{grouped}</code>
      <TotpCodeInput value={p.code} onChange={p.onCode} disabled={p.disabled} autoFocus={p.autoFocus} />
    </div>
  )
}

/** 6 haneli kod alanı (giriş, kurulum, kapatma) */
export function TotpCodeInput(p: { value: string; onChange: (v: string) => void; disabled?: boolean; autoFocus?: boolean; label?: string }) {
  return (
    <label>
      {p.label ?? t('acct.2fa.code')}
      <input
        value={p.value}
        onChange={(e) => p.onChange(e.target.value.replace(/[^0-9 ]/g, '').slice(0, 7))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123456"
        maxLength={7}
        disabled={p.disabled}
        autoFocus={p.autoFocus}
        spellCheck={false}
      />
    </label>
  )
}
