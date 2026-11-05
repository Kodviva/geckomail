// Köprü ölçümü: gerçek WebView ve gerçek Capacitor köprüsü. Aynı JS yerel dinleyiciye istek atmayı dener.
package com.kodviva.geckomail

import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

@RunWith(AndroidJUnit4::class)
class BridgeLiveTest {
    private lateinit var scenario: ActivityScenario<MainActivity>
    private val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    private val hits = AtomicInteger()
    private val port get() = server.localPort

    @Before fun start() {
        thread(isDaemon = true) {
            while (!server.isClosed) {
                try {
                    server.accept().use { s ->
                        hits.incrementAndGet()
                        s.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".toByteArray())
                    }
                } catch (_: Exception) {}
            }
        }
        scenario = ActivityScenario.launch(MainActivity::class.java)
        repeat(100) {
            if (eval("typeof Capacitor !== 'undefined' && !!Capacitor.nativePromise") == "true") return
            Thread.sleep(100)
        }
        error("köprü hazır değil")
    }

    @After fun stop() {
        scenario.close()
        server.close()
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
        done.await(5, TimeUnit.SECONDS)
        return out
    }

    private fun call(js: String): String {
        eval("""window.__r = null; Promise.race([($js).then((v) => 'ok:' + JSON.stringify(v), (e) => 'err:' + (e && e.message)),
            new Promise((r) => setTimeout(() => r('timeout'), 2500))]).then((r) => { window.__r = r }); 0""")
        repeat(40) {
            val r = eval("window.__r")
            if (r != "null" && r != "") return JSONTokener(r).nextValue().toString()
            Thread.sleep(100)
        }
        return "nil"
    }

    private fun measure(name: String, r: String) = Log.i("OLCUM", "Android $name sonuc=${r.take(120)} dinleyici=${hits.get()}")

    @Test fun capacitorHttpBlocked() {
        val r = call("Capacitor.nativePromise('CapacitorHttp','request',{url:'http://localhost:$port/sizinti',method:'GET'})")
        measure("CapacitorHttp", r)
        assertEquals(r, 0, hits.get())
        assertEquals("timeout", r)
    }

    @Test fun rawMessageBlocked() {
        call("""(async () => { androidBridge.postMessage(JSON.stringify({type:'message',pluginId:'CapacitorHttp',methodName:'request',callbackId:'9',options:{url:'http://localhost:$port/ham',method:'GET'}})); await new Promise((r)=>setTimeout(r,1500)); return 1 })()""")
        measure("ham-mesaj", "")
        assertEquals(0, hits.get())
    }

    @Test fun capacitorCookiesBlocked() {
        val r = call("Capacitor.nativePromise('CapacitorCookies','getCookies',{})")
        measure("CapacitorCookies", r)
        assertEquals("timeout", r)
    }

    @Test fun coreJavascriptInterfacesGone() {
        val r = eval("typeof CapacitorCookiesAndroidInterface + ' ' + typeof CapacitorHttpAndroidInterface")
        measure("js-arayuz", r)
        assertEquals("\"undefined undefined\"", r)
    }

    private val services get() = AppServices.get(androidx.test.core.app.ApplicationProvider.getApplicationContext())

    @Test fun accessTokenRefusedWhileLocked() {
        val gate = services.lock
        gate.apply(LockConfig(true, 0))
        try {
            gate.didEnterBackground()
            gate.didBecomeForeground()
            val r = call("Capacitor.nativePromise('GeckoNative','accessToken',{})")
            val lock = call("Capacitor.nativePromise('GeckoNative','getLock',{})")
            measure("kilitli-accessToken", r)
            assertEquals("""ok:{"status":"locked"}""", r)
            assertTrue(lock, lock.contains("\"locked\":true"))
        } finally {
            gate.apply(LockConfig(false, 0))
            gate.unlocked()
        }
    }

    @Test fun jsCannotWeakenLock() {
        val gate = services.lock
        gate.apply(LockConfig(true, 60_000))
        services.authOverride = object : Authenticating {
            override fun available() = true
            override suspend fun prompt(reason: String) = false
        }
        try {
            val r = call("Capacitor.nativePromise('GeckoNative','setLock',{enabled:false,timeoutMs:0})")
            measure("js-zayiflatma", r)
            assertTrue(r, r.startsWith("err:"))
            assertTrue(gate.config.enabled)
        } finally {
            services.authOverride = null
            gate.apply(LockConfig(false, 0))
        }
    }

    @Test fun allowlistedPluginsStillWork() {
        val a = call("Capacitor.nativePromise('GeckoNative','getServer',{})")
        val b = call("Capacitor.nativePromise('App','getInfo',{})")
        measure("izinli", "$a ${b.take(30)}")
        assertTrue(a, a.startsWith("ok:"))
        assertTrue(b, b.startsWith("ok:"))
    }

    @Test fun httpInterceptorPathClosed() {
        val r = call("fetch('/_capacitor_http_interceptor_?u=' + encodeURIComponent('http://localhost:$port/yol')).then((x) => x.status)")
        measure("interceptor", r)
        assertEquals(r, 0, hits.get())
    }
}
