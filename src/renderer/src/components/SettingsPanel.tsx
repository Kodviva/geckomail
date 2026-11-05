import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { THEME_PACKS, inkFor, themePackName } from '../themes'
import AccountsManager from './AccountsManager'
import { fmtDateTime, fmtNumber, getUiOs, isLocale, LOCALES, t } from '../../../shared/i18n'
import { biometricName } from '../../../shared/platformText'
import { applyLocale, getLocale } from '../locale'
import ServerAdminPanel from './ServerAdminPanel'
import OAuthClientsSettings from './OAuthClientsSettings'
import PimSourcesSettings from './PimSourcesSettings'
import ConnectionPanel from './ConnectionPanel'
import PasskeySettings from './PasskeySettings'
import TwoFactorSettings from './TwoFactorSettings'
import WebBackupSettings from './WebBackupSettings'
import WebNotifySettings from './WebNotifySettings'
import NotifyRulesSettings from './NotifyRulesSettings'
import NotifyAccountPrefs from './NotifyAccountPrefs'
import NotifyDevicesSettings from './NotifyDevicesSettings'
import SessionsSettings from './SessionsSettings'
import Attribution from './Attribution'
import LoginItemSetting from './LoginItemSetting'
import NativeNotifySettings from './NativeNotifySettings'
import { AppLockSettings } from './AppLock'
import { BrowserOnlyField } from './OpenInBrowser'
import { adminUi } from '../adminUi'
import OfflineSettings from './OfflineSettings'
import MigrationPanel from './MigrationPanel'
import ServerConnect from './ServerConnect'
import SieveSettings from './SieveSettings'
import SmimeSettings from './SmimeSettings'
import Modal from './Modal'
import { rich } from '../rich'
import { platform } from '../platform'

// sync/rpc/common.ts USER_PREF_KEYS ile aynı: setMyPrefs'e gider
const MY_PREF_KEYS = new Set(['notifyScope', 'notifyQuiet', 'notifyQuietStart', 'notifyQuietEnd', 'notifyVip'])

type SectionId = 'hesaplar' | 'kisitakvim' | 'baglanti' | 'gorunum' | 'genel' | 'bildirim' | 'filtreler' | 'kasa' | 'senkron' | 'yedek' | 'sunucu'


// mini gözcü önizlemesi (preset kartı için)
function PreviewEye({ c }: { c: string }) {
  return (
    <svg className="tp-eye" viewBox="0 0 10 10">
      <circle cx="5" cy="5" r="4.2" fill="none" stroke={c} strokeWidth="1.6" />
      <circle cx="5.8" cy="4.2" r="1.5" fill={c} />
    </svg>
  )
}

export default function SettingsPanel() {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const idleLockMin = useStore((s) => s.idleLockMin)
  const setIdleLockMin = useStore((s) => s.setIdleLockMin)
  const themePack = useStore((s) => s.themePack)
  const customAccent = useStore((s) => s.customAccent)
  const setThemePack = useStore((s) => s.setThemePack)
  const setCustomAccent = useStore((s) => s.setCustomAccent)
  const compact = useStore((s) => s.compact)
  const setCompact = useStore((s) => s.setCompact)
  const uiScale = useStore((s) => s.uiScale)
  const setUiScale = useStore((s) => s.setUiScale)
  const toast = useStore((s) => s.toast)
  const currentUser = useStore((s) => s.currentUser)
  const accounts = useStore((s) => s.accounts)
  const refreshAccounts = useStore((s) => s.refreshAccounts)
  const refreshList = useStore((s) => s.refreshList)
  const vaultState = useStore((s) => s.vaultState)
  const lockVault = useStore((s) => s.lockVault)
  const biometricEnabled = useStore((s) => s.vaultBiometricEnabled)
  const touchIdAvailable = useStore((s) => s.touchIdAvailable)
  const enableVaultBiometric = useStore((s) => s.enableVaultBiometric)
  const disableVaultBiometric = useStore((s) => s.disableVaultBiometric)
  const enableLoginBiometric = useStore((s) => s.enableLoginBiometric)
  const disableLoginBiometric = useStore((s) => s.disableLoginBiometric)
  const [autolock, setAutolock] = useState(true)
  const [loginBioOn, setLoginBioOn] = useState(false)
  const [loginBioPass, setLoginBioPass] = useState('')
  const [loginBioBusy, setLoginBioBusy] = useState(false)
  const [cadence, setCadence] = useState('120')
  const [backfill, setBackfill] = useState('5000')
  const [trusted, setTrusted] = useState(false)
  const [prefetch, setPrefetch] = useState(true)
  const [quiet, setQuiet] = useState(false)
  const [quietStart, setQuietStart] = useState('22:00')
  const [quietEnd, setQuietEnd] = useState('08:00')
  const [vip, setVip] = useState('')
  const [notify, setNotify] = useState('starred')
  const [loaded, setLoaded] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [backupPass, setBackupPass] = useState('')
  const [restorePass, setRestorePass] = useState('')
  const [autoBackup, setAutoBackup] = useState(true)
  const [autoBackupLast, setAutoBackupLast] = useState<string | null>(null)
  const [syncAnchor, setSyncAnchor] = useState<number | null>(null)
  const [syncPass, setSyncPass] = useState('')
  const [syncBusy, setSyncBusy] = useState<false | 'push' | 'pull'>(false)
  const [lastPush, setLastPush] = useState<string | null>(null)
  const [lastPull, setLastPull] = useState<string | null>(null)
  const [bioPass, setBioPass] = useState('')
  const [bioBusy, setBioBusy] = useState(false)
  const [autoSync, setAutoSync] = useState(false)
  const initialSection = useStore((s) => s.settingsSection)
  const [section, setSection] = useState<SectionId>((initialSection as SectionId | null) ?? 'hesaplar')
  const [cLight, setCLight] = useState(customAccent?.light ?? '#4d7519')
  const [cDark, setCDark] = useState(customAccent?.dark ?? '#b2d552')

  const applyCustom = (light: string, dark: string): void => {
    setCLight(light)
    setCDark(dark)
    if (/^#[0-9a-fA-F]{6}$/.test(light) && /^#[0-9a-fA-F]{6}$/.test(dark)) setCustomAccent(light, dark)
  }

  const isAdmin = adminUi(currentUser)
  const web = platform.kind === 'web'
  const native = !!platform.native
  const sections = useMemo(
    () =>
      [
        { id: 'hesaplar', icon: 'i-user', title: t('set.sec.accounts'), sub: t('set.sec.accountsSub') },
        { id: 'kisitakvim', icon: 'i-clock', title: t('pim.set.title'), sub: t('pim.set.sub') },
        { id: 'baglanti', icon: 'i-pulse', title: t('set.sec.connection'), sub: t('set.sec.connectionSub') },
        { id: 'gorunum', icon: 'i-palette', title: t('set.sec.appearance'), sub: t('set.sec.appearanceSub') },
        { id: 'genel', icon: 'i-sliders', title: t('set.sec.general'), sub: t('set.sec.generalSub') },
        { id: 'bildirim', icon: 'i-bell', title: t('set.sec.notify'), sub: t('set.sec.notifySub') },
        { id: 'filtreler', icon: 'i-filter', title: t('set.sec.filters'), sub: t('set.sec.filtersSub') },
        { id: 'kasa', icon: 'i-lock', title: t('set.sec.vault'), sub: t('set.sec.vaultSub') },
        ...(isAdmin
          ? [
              { id: 'senkron', icon: 'i-refresh', title: t('set.sec.sync'), sub: t('set.sec.syncSub') },
              { id: 'yedek', icon: 'i-save', title: t('set.sec.backup'), sub: t('set.sec.backupSub') },
              { id: 'sunucu', icon: 'i-monitor', title: t('set.sec.server'), sub: t('set.sec.serverSub') }
            ]
          : [])
      ] as { id: SectionId; icon: string; title: string; sub: string }[],
    // dil değişince uygulama zaten yeniden kurulur (App key=locale)
    [isAdmin]
  )

  useEffect(() => {
    void rpc.call('getPrefs', {}).then((p) => {
      if (p.pollCadenceSec) setCadence(p.pollCadenceSec)
      if (p.backfillTarget) setBackfill(p.backfillTarget)
      setTrusted(p.trustedServer === '1')
      setPrefetch(p.bodyPrefetch !== '0')
      setQuiet(p.notifyQuiet === '1')
      if (p.notifyQuietStart) setQuietStart(p.notifyQuietStart)
      if (p.notifyQuietEnd) setQuietEnd(p.notifyQuietEnd)
      setVip(p.notifyVip ?? '')
      if (p.notifyScope) setNotify(p.notifyScope)
      if (p.sync_anchor_account) setSyncAnchor(Number(p.sync_anchor_account))
      setLastPush(p.sync_last_push ?? null)
      setLastPull(p.sync_last_pull ?? null)
      setAutoSync(p.sync_auto === '1')
      setAutolock(p.vault_autolock !== '0')
      setAutoBackup(p.autoBackup !== '0')
      setAutoBackupLast(p.auto_backup_last ?? null)
      setLoaded(true)
    })
    // Touch ID girişi yalnız masaüstü (sunucu modunda RPC kapalı)
    if (platform.kind !== 'web') void rpc.call('getLoginBiometric', {}).then((r) => setLoginBioOn(!!r.username)).catch(() => {})
  }, [])

  const fmtTs = (v: string | null): string => (v ? fmtDateTime(Number(v)) : t('set.never'))

  const runSync = async (dir: 'push' | 'pull') => {
    if (syncAnchor == null) return toast(t('set.sync.pickAnchorFirst'), 'error')
    if (syncPass.length < 8) return toast(t('set.sync.passTooShort'), 'error')
    setSyncBusy(dir)
    try {
      if (dir === 'push') {
        const r = await rpc.call('syncPush', { anchorAccountId: syncAnchor, passphrase: syncPass })
        setLastPush(String(Date.now()))
        const parts = [t('set.sync.pushed', { count: r.pushed })]
        if (r.skipped) parts.push(t('set.sync.skippedLocked', { count: r.skipped }))
        toast(parts.join(', '), 'info')
      } else {
        const r = await rpc.call('syncPull', { anchorAccountId: syncAnchor, passphrase: syncPass })
        setLastPull(String(Date.now()))
        await refreshAccounts()
        void refreshList(false)
        const parts = [t('set.sync.pulled', { imported: r.imported, updated: r.updated })]
        if (r.skippedSecure) parts.push(t('set.sync.vaultKept', { count: r.skippedSecure }))
        if (r.passwordKept) parts.push(t('set.sync.passwordKept', { count: r.passwordKept }))
        toast(parts.join(', '), 'info')
      }
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setSyncBusy(false)
    }
  }

  // tüm ayarlar anında uygulanır (macOS geleneği, UX-P2-8): önceden bir kısmı anında, bir kısmı
  // 'Kaydet' ile uygulanıyor ve 'Vazgeç' anında olanları geri almıyordu
  const [savedFlash, setSavedFlash] = useState(false)
  const savePref = async (key: string, value: string) => {
    try {
      // bildirim tercihleri kişiye ait (her kullanıcı kendi değerini yazar); diğerleri cihaz geneli (admin)
      if (MY_PREF_KEYS.has(key)) await rpc.call('setMyPrefs', { [key]: value })
      else await rpc.call('setPrefs', { values: { [key]: value } })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (e) {
      toast(String((e as Error).message))
    }
  }

  // Yedek (R18): sync doğrudan dosyaya yazar; parola verilirse .geckobak (AES-GCM)
  const backup = async () => {
    if (backupPass && backupPass.length < 8) return toast(t('set.backup.passTooShort'), 'error')
    const stamp = new Date().toISOString().slice(0, 10)
    const path = await platform.chooseBackupSave(t('set.backup.fileName', { date: stamp }), !!backupPass)
    if (!path) return
    setBackingUp(true)
    try {
      const r = await rpc.call('backupToFile', { path, passphrase: backupPass || undefined })
      toast(t('set.backup.saved', { size: fmtNumber(r.bytes / 1_048_576, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }), 'info')
      setBackupPass('')
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBackingUp(false)
    }
  }

  const restore = async () => {
    const path = await platform.chooseBackupOpen()
    if (!path) return
    setBackingUp(true)
    try {
      const r = await rpc.call('stageRestore', { path, passphrase: restorePass || undefined })
      if (
        !window.confirm(t('set.backup.restoreConfirm', { accounts: r.accounts, schema: r.schemaVersion }))
      )
        return
      await platform.relaunch()
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBackingUp(false)
    }
  }

  const active = sections.find((s) => s.id === section) ?? sections[0]

  return (
    <Modal onClose={() => setSettingsOpen(false)} className="settings">
        <div className="modal-title">{t('set.title')}</div>
        <div className="settings-tabs">
          {sections.map((s) => (
            <button key={s.id} type="button" className={`chip ${s.id === section ? 'on' : ''}`} aria-pressed={s.id === section} onClick={() => setSection(s.id)}>
              <svg className="icon sm"><use href={`#${s.icon}`} /></svg> {s.title}
            </button>
          ))}
        </div>
        <div className="settings-sheet">
          <nav className="settings-rail">
            {sections.map((s) => (
              <div key={s.id} className={`settings-nav ${s.id === section ? 'on' : ''}`} onClick={() => setSection(s.id)}>
                <svg className="icon"><use href={`#${s.icon}`} /></svg> {s.title}
              </div>
            ))}
          </nav>
          <div className="settings-content">
            <div className="settings-sec-h">
              <svg className="icon"><use href={`#${active.icon}`} /></svg>
              <h3>{active.title}</h3>
            </div>
            <div className="settings-sec-sub">{active.sub}</div>

            {section === 'hesaplar' && (
              <>
                <AccountsManager />
                {isAdmin && <OAuthClientsSettings />}
                {native && currentUser?.role === 'admin' && <BrowserOnlyField title={t('mobile.browser.adminTitle')} hint={t('mobile.browser.admin')} />}
              </>
            )}
            {section === 'kisitakvim' && <PimSourcesSettings />}
            {section === 'baglanti' && (
              <>
                <div className="set-group">
                  <div className="set-field">
                    <div className="sf-l">
                      <div className="sf-t">{t('set.conn.trusted')}</div>
                      <div className="sf-h">
                        {rich(t('set.conn.trustedHint'), { only: <b>{t('set.conn.trustedOnly')}</b> })}
                      </div>
                    </div>
                    <div className="sf-c"><input type="checkbox" checked={trusted} onChange={(e) => { setTrusted(e.target.checked); void savePref('trustedServer', e.target.checked ? '1' : '0') }} disabled={!loaded} /></div>
                  </div>
                </div>
                <ConnectionPanel />
              </>
            )}

            {section === 'gorunum' && (
              <>
                <div className="set-group">
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('settings.language')}</div><div className="sf-h">{t('settings.languageHint')}</div></div>
                    <div className="sf-c">
                      <select value={getLocale()} onChange={(e) => {
                          if (!isLocale(e.target.value)) return
                          setSettingsOpen(true, 'gorunum') // yeniden kurulumda aynı bölüm açık kalsın
                          void applyLocale(e.target.value)
                        }} aria-label={t('settings.language')}>
                        {LOCALES.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.flag} {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.look.mode')}</div><div className="sf-h">{t('set.look.modeHint')}</div></div>
                    <div className="sf-c">
                      <div className="segmented">
                        <button type="button" className={theme === 'auto' ? 'on' : ''} onClick={() => setTheme('auto')}>
                          <svg className="icon sm"><use href="#i-monitor" /></svg>{t('set.look.system')}
                        </button>
                        <button type="button" className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>
                          <svg className="icon sm"><use href="#i-sun" /></svg>{t('set.look.light')}
                        </button>
                        <button type="button" className={theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>
                          <svg className="icon sm"><use href="#i-moon" /></svg>{t('set.look.dark')}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.look.compact')}</div><div className="sf-h">{t('set.look.compactHint')}</div></div>
                    <div className="sf-c"><input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /></div>
                  </div>
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.look.scale')}</div><div className="sf-h">{t('set.look.scaleHint')}</div></div>
                    <div className="sf-c">
                      <div className="segmented">
                        <button type="button" className={uiScale === 0.9 ? 'on' : ''} onClick={() => setUiScale(0.9)}>{t('set.look.small')}</button>
                        <button type="button" className={uiScale === 1 ? 'on' : ''} onClick={() => setUiScale(1)}>{t('set.look.medium')}</button>
                        <button type="button" className={uiScale === 1.1 ? 'on' : ''} onClick={() => setUiScale(1.1)}>{t('set.look.large')}</button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="set-subhead">{t('set.look.accent')}</div>
                <div className="theme-grid">
                  {THEME_PACKS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`theme-preset ${themePack === p.id ? 'on' : ''}`}
                      style={themePack === p.id ? { borderColor: p.dark } : undefined}
                      onClick={() => setThemePack(p.id)}
                    >
                      <div className="tp-vig">
                        <div className="tp-half l">
                          <PreviewEye c={p.light} />
                          <span className="tp-btn" style={{ background: p.light, color: inkFor(p.light) }}>{t('set.look.previewNew')}</span>
                        </div>
                        <div className="tp-half d">
                          <PreviewEye c={p.dark} />
                          <span className="tp-btn" style={{ background: p.dark, color: inkFor(p.dark) }}>{t('set.look.previewNew')}</span>
                        </div>
                      </div>
                      <div className="tp-name">
                        <b>{themePackName(p.id)}</b>
                        {themePack === p.id && <svg className="icon sm tp-check"><use href="#i-check" /></svg>}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="set-subhead">{t('set.look.custom')}</div>
                <div className="theme-custom">
                  <div className="tc-col">
                    <div className="tc-lbl">{t('set.look.customLight')}</div>
                    <div className="tc-pick">
                      <input type="color" value={cLight} onChange={(e) => applyCustom(e.target.value, cDark)} />
                      <input type="text" className="tc-hex" value={cLight} spellCheck={false} maxLength={7} onChange={(e) => applyCustom(e.target.value, cDark)} />
                    </div>
                  </div>
                  <div className="tc-col">
                    <div className="tc-lbl">{t('set.look.customDark')}</div>
                    <div className="tc-pick">
                      <input type="color" value={cDark} onChange={(e) => applyCustom(cLight, e.target.value)} />
                      <input type="text" className="tc-hex" value={cDark} spellCheck={false} maxLength={7} onChange={(e) => applyCustom(cLight, e.target.value)} />
                    </div>
                  </div>
                </div>
                <p className="auth-hint">{t('set.look.customHint')}</p>
              </>
            )}

            {section === 'genel' && (
              <>
                {web && <div className="set-group"><OfflineSettings /></div>}
                {platform.serverMode && <ServerConnect api={platform.serverMode} />}
                {platform.migration && isAdmin && <MigrationPanel api={platform.migration} serverMode={platform.serverMode} />}
                {platform.loginItem && <LoginItemSetting api={platform.loginItem} />}
                <div className="set-group" data-testid="about">
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.about.title')}</div><div className="sf-h"><Attribution /> · {t('set.about.license')}</div></div>
                  </div>
                </div>
                <div className="set-group">
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.gen.cadence')}</div><div className="sf-h">{t('set.gen.cadenceHint')}</div></div>
                    <div className="sf-c"><input type="number" min={30} value={cadence} onChange={(e) => setCadence(e.target.value)} onBlur={() => void savePref('pollCadenceSec', String(Math.max(30, Number(cadence) || 120)))} disabled={!loaded} /></div>
                  </div>
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.gen.backfill')}</div><div className="sf-h">{t('set.gen.backfillHint')}</div></div>
                    <div className="sf-c"><input type="number" min={100} step={500} value={backfill} onChange={(e) => setBackfill(e.target.value)} onBlur={() => void savePref('backfillTarget', String(Math.max(100, Number(backfill) || 5000)))} disabled={!loaded} /></div>
                  </div>
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.gen.prefetch')}</div><div className="sf-h">{t('set.gen.prefetchHint')}</div></div>
                    <div className="sf-c"><input type="checkbox" checked={prefetch} onChange={(e) => { setPrefetch(e.target.checked); void savePref('bodyPrefetch', e.target.checked ? '1' : '0') }} disabled={!loaded} /></div>
                  </div>
                </div>
              </>
            )}

            {section === 'bildirim' && (
              <div className="set-group">
                {native ? <NativeNotifySettings /> : web && !platform.nativeNotifications && <WebNotifySettings />}
                <div className="set-field">
                  <div className="sf-l"><div className="sf-t">{t('set.notify.scope')}</div><div className="sf-h">{t('set.notify.scopeHint')}</div></div>
                  <div className="sf-c">
                    <select value={notify} onChange={(e) => { setNotify(e.target.value); void savePref('notifyScope', e.target.value) }} disabled={!loaded}>
                      <option value="starred">{t('set.notify.starred')}</option>
                      <option value="all">{t('set.notify.all')}</option>
                      <option value="off">{t('set.notify.off')}</option>
                    </select>
                  </div>
                </div>
                <div className="set-field">
                  <div className="sf-l"><div className="sf-t">{t('set.notify.quietHours')}</div><div className="sf-h">{t('set.notify.quietHint')}</div></div>
                  <div className="sf-c quiet-hours">
                    <input type="checkbox" aria-label={t('set.notify.quietToggle')} checked={quiet} onChange={(e) => { setQuiet(e.target.checked); void savePref('notifyQuiet', e.target.checked ? '1' : '0') }} disabled={!loaded} />
                    <input type="time" aria-label={t('set.notify.quietStart')} value={quietStart} onChange={(e) => setQuietStart(e.target.value)} onBlur={() => void savePref('notifyQuietStart', quietStart)} disabled={!loaded || !quiet} />
                    <span>–</span>
                    <input type="time" aria-label={t('set.notify.quietEnd')} value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} onBlur={() => void savePref('notifyQuietEnd', quietEnd)} disabled={!loaded || !quiet} />
                  </div>
                </div>
                <div className="set-field set-field-col">
                  <div className="sf-l"><div className="sf-t">{t('set.notify.vip')}</div><div className="sf-h">{rich(t('set.notify.vipHint'), { domain: <code>{t('set.notify.vipDomain')}</code> })}</div></div>
                  <textarea rows={4} value={vip} onChange={(e) => setVip(e.target.value)} onBlur={() => void savePref('notifyVip', vip).then(() => rpc.call('getPrefs', {})).then((p) => setVip(p.notifyVip ?? ''))} placeholder={t('set.notify.vipPlaceholder')} disabled={!loaded} spellCheck={false} />
                </div>
              </div>
            )}
            {section === 'bildirim' && <NotifyRulesSettings />}
            {section === 'bildirim' && <NotifyAccountPrefs />}
            {section === 'bildirim' && web && <NotifyDevicesSettings />}

            {section === 'filtreler' && <SieveSettings />}

            {section === 'kasa' && native && <AppLockSettings />}
            {section === 'kasa' && native && <BrowserOnlyField title={t('mobile.browser.accountTitle')} hint={t('mobile.browser.account')} />}
            {section === 'kasa' && web && !native && <TwoFactorSettings isAdmin={isAdmin} />}
            {section === 'kasa' && web && !native && <PasskeySettings />}
            {section === 'kasa' && web && !native && <SessionsSettings />}
            {section === 'kasa' && (
              <div className="set-group">
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.vault.idleLock')}</div><div className="sf-h">{t('set.vault.idleLockHint')}</div></div>
                    <div className="sf-c">
                      <select value={idleLockMin} onChange={(e) => setIdleLockMin(Number(e.target.value))}>
                        <option value={0}>{t('set.vault.off')}</option>
                        {[5, 15, 30, 60].map((m) => (
                          <option key={m} value={m}>{t('set.vault.minutes', { count: m })}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {!web && (
                  <div className="set-field">
                    <div className="sf-l">
                      <div className="sf-t">{t('set.vault.touchLogin')}</div>
                      <div className="sf-h">{t('set.vault.touchLoginHint')}</div>
                    </div>
                    <div className="sf-c">
                      {!touchIdAvailable ? (
                        <span className="vault-tag">{t('set.vault.noTouchId')}</span>
                      ) : loginBioOn ? (
                        <button type="button" onClick={() => void disableLoginBiometric().then(() => setLoginBioOn(false))}>{t('set.vault.disable')}</button>
                      ) : (
                        <>
                          <input
                            type="password"
                            placeholder={t('set.vault.yourPassword')}
                            value={loginBioPass}
                            onChange={(e) => setLoginBioPass(e.target.value)}
                            autoComplete="off"
                            disabled={loginBioBusy}
                            style={{ minWidth: 120 }}
                          />
                          <button
                            type="button"
                            className="primary"
                            disabled={loginBioBusy || !loginBioPass}
                            onClick={async () => {
                              setLoginBioBusy(true)
                              const ok = await enableLoginBiometric(loginBioPass)
                              setLoginBioBusy(false)
                              if (ok) {
                                setLoginBioOn(true)
                                setLoginBioPass('')
                              }
                            }}
                          >
                            {loginBioBusy ? '…' : t('set.vault.enable')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  )}
              </div>
            )}
            {section === 'kasa' && (
              vaultState === 'none' ? (
                <p className="auth-hint">
                  {rich(t('set.vault.noVault'), { action: <b>{t('set.vault.noVaultAction')}</b> })}{' '}
                  <button type="button" className="link-btn inline" onClick={() => setSection('hesaplar')}>
                    {t('set.vault.goAccounts')}
                  </button>
                </p>
              ) : (
                <>
                  <div className="set-group">
                    <div className="set-field">
                      <div className="sf-l"><div className="sf-t">{t('set.vault.status')}</div><div className="sf-h">{t('set.vault.statusHint')}</div></div>
                      <div className="sf-c">
                        <span className={`vault-tag ${vaultState === 'unlocked' ? 'on' : ''}`}>{vaultState === 'unlocked' ? t('set.vault.unlocked') : t('set.vault.locked')}</span>
                        {vaultState === 'unlocked' && (
                          <button type="button" onClick={() => void lockVault()}>
                            <svg className="icon sm"><use href="#i-lock" /></svg> {t('set.vault.lockNow')}
                          </button>
                        )}
                      </div>
                    </div>
                    {isAdmin && (
                      <div className="set-field">
                        <div className="sf-l"><div className="sf-t">{t('smime.set.clearFails')}</div><div className="sf-h">{t('smime.set.clearFailsHint')}</div></div>
                        <div className="sf-c">
                          <button type="button" onClick={() => void rpc.call('clearVaultPassphraseFails', {}).then(() => toast(t('smime.set.clearFailsDone'), 'info'), (e: Error) => toast(e.message))}>
                            {t('smime.set.clearFailsAction')}
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="set-field">
                      <div className="sf-l">
                        <div className="sf-t">{t('set.vault.lockOnSleep')}</div>
                        <div className="sf-h">{t('set.vault.lockOnSleepHint')}</div>
                      </div>
                      <div className="sf-c">
                        <input
                          type="checkbox"
                          checked={autolock}
                          onChange={(e) => {
                            setAutolock(e.target.checked)
                            void rpc
                              .call('setPrefs', { values: { vault_autolock: e.target.checked ? '1' : '0' } })
                              .catch((err) => toast(String((err as Error).message)))
                          }}
                        />
                      </div>
                    </div>
                    {touchIdAvailable ? (
                      <div className="set-field">
                        <div className="sf-l">
                          <div className="sf-t">{t('set.vault.touchUnlock')}</div>
                          <div className="sf-h">{t('set.vault.touchUnlockHint')}</div>
                        </div>
                        <div className="sf-c">
                          {biometricEnabled ? (
                            <button type="button" onClick={() => void disableVaultBiometric()} disabled={bioBusy}>{t('set.vault.disable')}</button>
                          ) : (
                            <>
                              <input type="password" placeholder={t('set.vault.vaultPassword')} value={bioPass} onChange={(e) => setBioPass(e.target.value)}
                                autoComplete="off" disabled={bioBusy} style={{ minWidth: 130 }} />
                              <button type="button" className="primary" disabled={bioBusy || bioPass.length < 8} onClick={async () => {
                                setBioBusy(true)
                                const ok = await enableVaultBiometric(bioPass)
                                setBioBusy(false)
                                if (ok) setBioPass('')
                              }}>
                                {bioBusy ? '…' : t('set.vault.turnOn')}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="set-field">
                        <div className="sf-l"><div className="sf-t">{biometricName(getUiOs()) ?? 'Touch ID'}</div><div className="sf-h">{t('set.vault.noTouchHardware')}</div></div>
                      </div>
                    )}
                  </div>
                </>
              )
            )}

            {section === 'kasa' && !native && <SmimeSettings isAdmin={isAdmin} />}

            {section === 'senkron' && (
              <>
                <div className="callout-inline">
                  <svg className="icon sm"><use href="#i-lock" /></svg>
                  <span>{t('set.sync.warning')}</span>
                </div>
                <div className="set-group">
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.sync.anchor')}</div><div className="sf-h">{t('set.sync.anchorHint')}</div></div>
                    <div className="sf-c">
                      <select value={syncAnchor ?? ''} onChange={(e) => setSyncAnchor(Number(e.target.value) || null)} disabled={!!syncBusy}>
                        <option value="">{t('set.sync.pickAccount')}</option>
                        {accounts.map((a) => (<option key={a.id} value={a.id}>{a.email}</option>))}
                      </select>
                    </div>
                  </div>
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.sync.passphrase')}</div><div className="sf-h">{t('set.sync.passphraseHint')}</div></div>
                    <div className="sf-c"><input type="password" value={syncPass} onChange={(e) => setSyncPass(e.target.value)} autoComplete="new-password" disabled={!!syncBusy} style={{ minWidth: 150 }} /></div>
                  </div>
                  <div className="set-field">
                    <div className="sf-l"><div className="sf-t">{t('set.sync.auto')}</div><div className="sf-h">{t('set.sync.autoHint', { last: fmtTs(lastPull) })}</div></div>
                    <div className="sf-c">
                      <input type="checkbox" checked={autoSync} disabled={!!syncBusy} onChange={async (e) => {
                        const on = e.target.checked
                        if (on && (syncAnchor == null || syncPass.length < 8)) { toast(t('set.sync.autoNeedsSetup'), 'error'); return }
                        try {
                          await rpc.call('setSyncAuto', { enabled: on, anchorAccountId: syncAnchor ?? 0, passphrase: syncPass })
                          setAutoSync(on)
                          toast(on ? t('set.sync.autoOn') : t('set.sync.autoOff'), 'info')
                        } catch (err) { toast(String((err as Error).message)) }
                      }} />
                    </div>
                  </div>
                </div>
                <div className="settings-actions">
                  <button type="button" onClick={() => void runSync('pull')} disabled={!!syncBusy}>{syncBusy === 'pull' ? t('set.sync.pulling') : t('set.sync.pull')}</button>
                  <button type="button" className="primary" onClick={() => void runSync('push')} disabled={!!syncBusy}>{syncBusy === 'push' ? t('set.sync.pushing') : t('set.sync.push')}</button>
                </div>
                <p className="auth-hint">{t('set.sync.lastTimes', { push: fmtTs(lastPush), pull: fmtTs(lastPull) })}</p>
              </>
            )}

            {section === 'sunucu' && isAdmin && <ServerAdminPanel />}

            {section === 'yedek' && (
              <div className="set-group">
                {/* web: sunucu yedeği HTTP ile (dosya seçici yolu yok); masaüstü: backupToFile/stageRestore */}
                {platform.serverBackup ? <WebBackupSettings api={platform.serverBackup} /> : (
                <div className="set-field">
                  <div className="sf-l">
                    <div className="sf-t">{t('set.backup.create')}</div>
                    <div className="sf-h">{t('set.backup.createHint')}</div>
                  </div>
                  <div className="sf-c">
                    <input type="password" placeholder={t('set.backup.passOptional')} value={backupPass} onChange={(e) => setBackupPass(e.target.value)} autoComplete="new-password" style={{ minWidth: 150 }} />
                    <button type="button" onClick={() => void backup()} disabled={backingUp}>{backingUp ? t('set.backup.working') : t('set.backup.backupBtn')}</button>
                  </div>
                </div>
                )}
                <div className="set-field">
                  <div className="sf-l">
                    <div className="sf-t">{t('set.backup.weekly')}</div>
                    <div className="sf-h">
                      {web ? t('set.backup.web.weeklyHint') : t('set.backup.weeklyHint')}
                      {autoBackupLast ? ` ${t('set.backup.weeklyLast', { when: fmtTs(autoBackupLast) })}` : ''}
                    </div>
                  </div>
                  <div className="sf-c">
                    <input
                      type="checkbox"
                      checked={autoBackup}
                      onChange={(e) => {
                        setAutoBackup(e.target.checked)
                        void savePref('autoBackup', e.target.checked ? '1' : '0')
                      }}
                      disabled={!loaded}
                    />
                  </div>
                </div>
                {!platform.serverBackup && (
                <div className="set-field">
                  <div className="sf-l">
                    <div className="sf-t">{t('set.backup.restore')}</div>
                    <div className="sf-h">{t('set.backup.restoreHint')}</div>
                  </div>
                  <div className="sf-c">
                    <input type="password" placeholder={t('set.backup.restorePass')} value={restorePass} onChange={(e) => setRestorePass(e.target.value)} autoComplete="off" style={{ minWidth: 130 }} />
                    <button type="button" className="danger" onClick={() => void restore()} disabled={backingUp}>{t('set.backup.restoreBtn')}</button>
                  </div>
                </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <span className={`saved-flash ${savedFlash ? 'on' : ''}`} role="status" aria-live="polite">
            {savedFlash ? t('set.savedFlash') : t('set.autoSaveNote')}
          </span>
          <button className="primary" onClick={() => setSettingsOpen(false)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
