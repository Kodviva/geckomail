// Tek tıkla açıldığında kod çalıştırabilen ek türleri (macOS, Windows; mobilde .mobileconfig ve .apk). Bunlar açılmadan önce kullanıcıya
// sorulur; tümüne ayrıca işletim sisteminin işareti konur (com.apple.quarantine, Zone.Identifier).
const DANGEROUS = new Set([
  'app', 'command', 'tool', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'terminal', 'pkg', 'mpkg', 'dmg',
  'scpt', 'scptd', 'applescript', 'workflow', 'action', 'jar', 'py', 'pl', 'rb', 'php', 'js', 'jse', 'vbs',
  'wsf', 'bat', 'cmd', 'exe', 'msi', 'ps1', 'reg', 'lnk', 'url', 'webloc', 'inetloc', 'fileloc', 'hta',
  'cpl', 'scr', 'iso', 'img', 'kext', 'plugin', 'prefpane', 'saver', 'mobileconfig', 'configprofile', 'apk', 'apks', 'xapk',
  'com', 'pif', 'msc', 'msp', 'mst', 'gadget', 'wsh', 'vbe', 'psm1', 'ps1xml', 'scf', 'shb', 'shs', 'inf',
  'application', 'appx', 'appxbundle', 'msix', 'msixbundle', 'appinstaller', 'library-ms', 'search-ms',
  'settingcontent-ms', 'chm', 'hlp', 'dll', 'sys', 'vhd', 'vhdx', 'wim', 'xll'
])

const baseName = (name: string): string => name.split(/[\\/]/).pop() ?? ''
const trimEnd = (name: string): string => name.replace(/[. ]+$/, '')

/** Windows'un gördüğü ad: sondaki nokta/boşluk ve ':' sonrası akış atılır (`fatura.exe.`, `a.exe::$DATA`) */
export function normalizedName(name: string): string {
  return trimEnd(baseName(name).split(':')[0])
}

export function extensionOf(name: string): string {
  const base = baseName(name)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export function isDangerousAttachment(name: string): boolean {
  // akış adı da sayılır: `x.pdf:evil.exe` kullanıcıya hangi parçası gösterilirse gösterilsin kuşkuludur
  return baseName(name).split(':').some((part) => DANGEROUS.has(extensionOf(trimEnd(part))))
}

/** com.apple.quarantine değeri: 0081 = karantinada (onaylanmamış), saat 16'lık, ajan adı */
export function quarantineValue(now: number = Date.now()): string {
  return `0081;${Math.floor(now / 1000).toString(16)};GeckoMail;`
}
