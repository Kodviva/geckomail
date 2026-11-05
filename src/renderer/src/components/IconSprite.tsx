// Tek ikon kaynağı: Lucide (MIT) çizgi ikonları, tek stil (24×24, currentColor).
// App kökünde bir kez render edilir; her yerde <svg className="icon"><use href="#i-name"/></svg>
export default function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></symbol>
        <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14" /><path d="M5 12h14" /></symbol>
        <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11A8 8 0 0 0 6.3 6.3L3 9" /><path d="M3 4v5h5" /><path d="M4 13a8 8 0 0 0 13.7 4.7L21 15" /><path d="M21 20v-5h-5" /></symbol>
        <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z" /><path d="M12 9v5" /><circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-pulse" viewBox="0 0 24 24"><path d="M3 12h4l2-7 4 14 2-7h6" /></symbol>
        <symbol id="i-zap" viewBox="0 0 24 24"><path d="M13 2 3 14h7l-1 8 10-12h-7z" /></symbol>
        <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 6h8" /><path d="M16 6h4" /><circle cx="13" cy="6" r="2" /><path d="M4 12h3" /><path d="M11 12h9" /><circle cx="8" cy="12" r="2" /><path d="M4 18h11" /><path d="M19 18h1" /><circle cx="17" cy="18" r="2" /></symbol>
        <symbol id="i-pencil" viewBox="0 0 24 24"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></symbol>
        <symbol id="i-reply" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5V20" /></symbol>
        <symbol id="i-reply-all" viewBox="0 0 24 24"><path d="M7 17 2 12l5-5" /><path d="M13 17 8 12l5-5" /><path d="M21 18v-2a4 4 0 0 0-4-4H8" /></symbol>
        <symbol id="i-forward" viewBox="0 0 24 24"><path d="m15 14 5-5-5-5" /><path d="M4 20v-7a4 4 0 0 1 4-4h12" /></symbol>
        <symbol id="i-archive" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 13h4" /></symbol>
        <symbol id="i-star" viewBox="0 0 24 24"><path d="m12 2 3.1 6.6 7.2.9-5.3 5 1.4 7.2L12 18l-6.4 3.7 1.4-7.2-5.3-5 7.2-.9Z" /></symbol>
        <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" /><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /></symbol>
        <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><path d="M4 12l6 6L20 6" /></symbol>
        <symbol id="i-seal" viewBox="0 0 24 24"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z" /></symbol>
        <symbol id="i-check2" viewBox="0 0 24 24"><path d="M2 12.5 6.5 17 16 6" /><path d="M8 12.5l4.5 4.5L22 6" /></symbol>
        <symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 5-5" /></symbol>
        <symbol id="i-thread" viewBox="0 0 24 24"><path d="M4 4h16v11H8l-4 4Z" /></symbol>
        <symbol id="i-mute" viewBox="0 0 24 24"><path d="M8 3.5A5 5 0 0 1 17 7v3.5c0 1.5.5 3 1.5 4.2" /><path d="M4 4l16 16" /><path d="M6.3 6.3C6.1 6.8 6 7.4 6 8v3.5c0 2-.5 3.5-2 5h11" /><path d="M9.5 19a2.5 2.5 0 0 0 4.9 0" /></symbol>
        <symbol id="i-clip" viewBox="0 0 24 24"><path d="M13.5 6.5 7 13a3 3 0 0 0 4.2 4.2l7-7a5 5 0 0 0-7-7l-6.6 6.6" /></symbol>
        <symbol id="i-chevron" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></symbol>
        <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></symbol>
        <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="m3 7 9 6 9-6" /></symbol>
        <symbol id="i-send" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></symbol>
        <symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></symbol>
        <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></symbol>
        <symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></symbol>
        <symbol id="i-ban" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m5.5 5.5 13 13" /></symbol>
        <symbol id="i-link" viewBox="0 0 24 24"><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 1 1 0 10h-2" /><path d="M8 12h8" /></symbol>
        <symbol id="i-power" viewBox="0 0 24 24"><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" /></symbol>
        <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></symbol>
        <symbol id="i-unlock" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></symbol>
        <symbol id="i-bell" viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 7 3 5 3 9H3c0-4 3-2 3-9Z" /><path d="M10 21a2 2 0 0 0 4 0" /></symbol>
        <symbol id="i-save" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></symbol>
        <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></symbol>
        <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m4.9 19.1 1.4-1.4" /><path d="m17.7 6.3 1.4-1.4" /></symbol>
        <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></symbol>
        <symbol id="i-monitor" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></symbol>
        <symbol id="i-palette" viewBox="0 0 24 24"><path d="M12 22a10 10 0 1 1 0-20 8 8 0 0 1 8 8 4 4 0 0 1-4 4h-2.5a1.5 1.5 0 0 0-1 2.6 1.5 1.5 0 0 1-1 2.6z" /><circle cx="7.5" cy="10.5" r="1" /><circle cx="12" cy="7.5" r="1" /><circle cx="16.5" cy="10.5" r="1" /></symbol>
        <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></symbol>
        <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></symbol>
        <symbol id="i-filter" viewBox="0 0 24 24"><path d="M3 6h18" /><path d="M7 12h10" /><path d="M10 18h4" /></symbol>
        <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></symbol>
        <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></symbol>
        <symbol id="i-caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></symbol>
        <symbol id="i-mail-open" viewBox="0 0 24 24"><path d="M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0Z" /><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10" /></symbol>
        <symbol id="i-mail-dot" viewBox="0 0 24 24"><path d="M21 12.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /><path d="m3 7 9 6 3.5-2.3" /><circle cx="19" cy="6" r="3" fill="currentColor" /></symbol>
        <symbol id="i-printer" viewBox="0 0 24 24"><path d="M6 9V3h12v6" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" rx="1" /></symbol>
        <symbol id="i-text-size" viewBox="0 0 24 24"><path d="M3 19 8.5 5 14 19" /><path d="M5 14h7" /><path d="M15 19l3.5-9 3.5 9" /><path d="M16.2 16h4.6" /></symbol>
        <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></symbol>
        <symbol id="i-fingerprint" viewBox="0 0 24 24"><path d="M2 12a10 10 0 0 1 18-6" /><path d="M2 16h.01" /><path d="M21.8 16c.2-2 .131-5.354 0-6" /><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" /><path d="M8.65 22c.21-.66.45-1.32.57-2" /><path d="M9 6.8a6 6 0 0 1 9 5.2v2" /><path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" /><path d="M14 13.12c0 2.38 0 6.38-1 8.88" /><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" /></symbol>
      </defs>
    </svg>
  )
}
