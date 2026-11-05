// Fikstürlü smoke'ta Electron'a `-r` ile yüklenir: Keychain ve Touch ID'ye hiç gidilmez. Motor açılışta kapalı hesapların
// da parolasını çözmek ister (engine.ts loadCredentials); gerçek safeStorage anahtarı sahte blob için okunmaz.
const { safeStorage, systemPreferences } = require('electron')

safeStorage.isEncryptionAvailable = () => false
for (const fn of ['encryptString', 'decryptString']) {
  safeStorage[fn] = () => {
    throw new Error('smoke: safeStorage kapalı')
  }
}
if (systemPreferences.canPromptTouchID) systemPreferences.canPromptTouchID = () => false
console.log('smoke: Keychain kapalı')
