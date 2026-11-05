// tek kaynak: marka motifi (kurbağa + zarf) — "dolu gözler" varyantı (gülücüklü).
// build/icon.icns bundan elle türetildi; bu SVG değişirse app ikonu da eşleşmesi
// için yeniden üretilmeli (bkz. scripts/gen-icon.mjs).
export default function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <rect x="0" y="0" width="1024" height="1024" rx="224" className="logo-bg" />
      <g className="logo-line">
        <path d="M424,486 C456,542 568,542 600,486" />
        <rect x="292" y="606" width="440" height="250" rx="26" />
        <path d="M292,620 L512,736 L732,620" />
      </g>
      <g className="logo-eyes">
        <circle className="logo-fill" cx="340" cy="322" r="126" />
        <circle className="logo-fill" cx="684" cy="322" r="126" />
        <circle className="logo-cut" cx="368" cy="352" r="44" />
        <circle className="logo-cut" cx="656" cy="352" r="44" />
      </g>
    </svg>
  )
}
