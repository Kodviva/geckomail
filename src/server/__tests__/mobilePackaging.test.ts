import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(new URL(`../../../mobile/${p}`, import.meta.url), 'utf8')

describe('mobil paket ayarları', () => {
  it('Firebase jetonu izin olmadan üretilmez', () => {
    expect(read('android/app/src/main/AndroidManifest.xml')).toMatch(/firebase_messaging_auto_init_enabled"\s+android:value="false"/)
  })

  it('google-services.json yoksa release derlemesi durur', () => {
    const gradle = read('android/app/build.gradle')
    expect(gradle).toMatch(/preReleaseBuild[\s\S]*throw new GradleException/)
    expect(gradle).not.toMatch(/try \{\s+def servicesJSON/)
  })
})
