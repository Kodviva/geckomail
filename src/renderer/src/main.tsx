import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ServerUnreachable } from './components/ServerConnect'
import Wallboard from './components/Wallboard'
import { startEyeTracker } from './eyeTracker'
import { applyStoredTheme } from './themes'
import { bootLocale } from './locale'
import { platform } from './platform'
import { setUiOs } from '../../shared/i18n'
import { uiOsOf } from '../../shared/platformText'
import { startPwa } from './pwa'
import { initPasskeySupport } from './webPasskey'
import './styles.css'

// CSS'te masaüstüne özgü boşluklar (macOS trafik ışıkları) yalnız electron'da
document.documentElement.dataset.platform = platform.kind
// CSS'te başlık çubuğu farkı: Windows'ta pencere düğmeleri sağ üstte, trafik ışığı yok. Yalnız Electron penceresinde
// anlamlı: kurallar [data-platform='electron'] kapsamında, Electron'un kimlik dizesi gerçek işletim sistemini söyler
const ua = navigator.userAgent
const uaOs = /Windows/.test(ua) ? 'win32' : /Macintosh/.test(ua) ? 'darwin' : 'linux'
if (platform.kind === 'electron') document.documentElement.dataset.os = uaOs
setUiOs(uiOsOf(uaOs)) // kısayol ve biyometri metni web'de de işletim sistemine uyar
if (platform.native) document.documentElement.dataset.native = platform.native
applyStoredTheme() // vurgu/tema render'dan önce → flash yok
const query = new URLSearchParams(window.location.search)
// yalnız paketteki sayfada köprü var: sunucudaki ?mode=connect olağan arayüzü açar
const connectPage = query.get('mode') === 'connect' ? window.geckoDesktopConnect ?? null : null
// Electron'da ve mobil uygulamada service worker ve yükleme önerisi yok
if (platform.kind === 'web' && !platform.native && !connectPage) startPwa() // beforeinstallprompt render'ı beklemez
const isWallboard = query.get('mode') === 'wallboard'

// dil de render'dan önce (katalog parçası yerel dosyadan yüklenir)
void Promise.all([bootLocale(), initPasskeySupport()]).then(([{ needsWelcome }]) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {connectPage ? <ServerUnreachable api={connectPage} cert={query.get('cert') === '1'} /> : isWallboard ? <Wallboard /> : <App needsWelcome={needsWelcome} />}
    </React.StrictMode>
  )
})

startEyeTracker() // gözcü noktaları fareyi takip eder, durunca kırpar
