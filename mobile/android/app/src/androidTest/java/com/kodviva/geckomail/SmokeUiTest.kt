// Uçtan uca: mobile/scripts/e2e-stack.mjs açıkken ve `adb reverse` ile ilk açılış, sunucu, giriş + TOTP, gelen kutusu, ileti.
// WebView düğümleri uygulama sürecinde JS ile sürülür. Yığın kapalıysa atlanır. Adımlar mobile/e2e/README.md'de.
package com.kodviva.geckomail

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val CONTROL = "http://localhost:9102"
private const val SERVER = "http://localhost:9100"
private const val WAIT_STEPS = 150

@RunWith(AndroidJUnit4::class)
class SmokeUiTest {
    private lateinit var scenario: ActivityScenario<MainActivity>

    private fun totp(): String? = try {
        val c = URL("$CONTROL/totp").openConnection() as HttpURLConnection
        c.connectTimeout = 2000
        JSONObject(c.inputStream.use { it.readBytes().decodeToString() }).getString("code")
    } catch (_: java.io.IOException) {
        null
    }

    private fun eval(js: String): String {
        var out = ""
        val done = CountDownLatch(1)
        scenario.onActivity { a ->
            a.bridge.webView.evaluateJavascript(js) {
                out = it
                done.countDown()
            }
        }
        assertTrue(done.await(5, TimeUnit.SECONDS))
        return JSONTokener(out).nextValue().toString()
    }

    private fun bodyText() = eval("document.body.innerText")

    private fun waitText(text: String): Boolean {
        repeat(WAIT_STEPS) {
            if (bodyText().contains(text)) return true
            Thread.sleep(100)
        }
        return false
    }

    private fun clickText(text: String) {
        eval("(() => { const b = [...document.querySelectorAll('button,[role=button]')].find((e) => e.innerText.trim() === ${JSONObject.quote(text)}); if (b) b.click(); return String(!!b) })()")
    }

    private fun fill(selector: String, value: String) {
        eval(
            """(() => { const e = document.querySelector(${JSONObject.quote(selector)}); if (!e) return 'yok';
               Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSONObject.quote(value)});
               e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()"""
        )
    }

    private fun submit() = eval("(() => { const f = document.querySelector('form'); if (f) f.requestSubmit(); return String(!!f) })()")

    @Test fun firstRunToMessage() {
        assumeTrue("e2e-stack kapalı", totp() != null)
        scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            assertTrue(waitText("GeckoMail"))
            if (bodyText().contains("Türkçe") && bodyText().contains("Devam")) {
                clickText("Türkçe")
                clickText("Devam")
            }
            if (waitText("Sunucunuza bağlanın")) {
                fill("input", SERVER)
                submit()
            }
            assertTrue(bodyText(), waitText("Giriş Yap"))
            fill("input:not([type=password])", "deneme")
            fill("input[type=password]", "deneme-parola-1")
            clickText("Giriş Yap")
            assertTrue(bodyText(), waitText("İki adımlı doğrulama"))
            fill("input", totp()!!)
            clickText("Doğrula")
            assertTrue(bodyText(), waitText("Betikli ileti"))
            eval("[...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent === 'Betikli ileti')[0].click()")
            assertTrue(bodyText(), waitText("ayse@example.test"))
            assertFalse(bodyText().contains("BETIK CALISTI")) // T9: posta içi betik çalışmaz
        } finally {
            scenario.close()
        }
    }

    @Test fun saveBytesOpensChooser() {
        scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            repeat(WAIT_STEPS) {
                if (eval("String(typeof Capacitor !== 'undefined' && !!Capacitor.nativePromise)") == "true") return@repeat
                Thread.sleep(100)
            }
            eval("Capacitor.nativePromise('GeckoNative','saveBytes',{name:'../deneme.txt',base64:'bWVyaGFiYQ=='}); 'ok'")
            val ui = InstrumentationRegistry.getInstrumentation().uiAutomation
            var top = ""
            repeat(30) {
                Thread.sleep(200)
                top = ui.executeShellCommand("dumpsys activity activities").let { fd ->
                    android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().decodeToString() }
                }.lineSequence().firstOrNull { it.contains("topResumedActivity") }.orEmpty()
                if (top.contains("Chooser") || top.contains("Resolver")) return@repeat
            }
            assertTrue(top, top.contains("Chooser") || top.contains("Resolver"))
            ui.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        } finally {
            scenario.close()
        }
    }
}
