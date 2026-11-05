package com.kodviva.geckomail.push

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec

internal fun vectors(): List<JSONObject> {
    val text = PushCryptoTest::class.java.classLoader!!.getResourceAsStream("push-vectors.json")!!.readBytes().decodeToString()
    val a = JSONObject(text).getJSONArray("vectors")
    return (0 until a.length()).map(a::getJSONObject)
}

internal fun b64(o: JSONObject, k: String): ByteArray = base64UrlDecode(o.getString(k))!!

internal fun privateKey(raw: ByteArray): PrivateKey {
    val p = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
    val spec = ECPrivateKeySpec(BigInteger(1, raw), p.getParameterSpec(ECParameterSpec::class.java))
    return KeyFactory.getInstance("EC").generatePrivate(spec)
}

class PushCryptoTest {
    private fun decrypt(v: JSONObject, body: ByteArray = b64(v, "body"), key: PrivateKey = privateKey(b64(v, "uaPrivate"))) =
        PushCrypto.decrypt(body, key, b64(v, "uaPublic"), b64(v, "auth"))

    @Test fun rfc8291AppendixVector() {
        val v = vectors().first { it.getString("name") == "rfc8291-appendix-a" }
        assertArrayEquals(b64(v, "plaintext"), decrypt(v))
        assertEquals("When I grow up, I want to be a watermelon", decrypt(v).decodeToString())
    }

    /** Motor çıktısı ve yerel çözücü aynı baytlarla: engine-chain.json gerçek sunucu ve imzalı röleden yakalandı */
    @Test fun engineChainPayload() {
        val text = PushCryptoTest::class.java.classLoader!!.getResourceAsStream("engine-chain.json")!!.readBytes().decodeToString()
        val chain = JSONObject(text)
        val d = chain.getJSONObject("android")
        assertEquals("fcm", d.getString("provider"))
        val c = d.getJSONObject("body").getJSONObject("message").getJSONObject("data").getString("c")
        val plain = PushCrypto.decrypt(base64UrlDecode(c)!!, privateKey(b64(d, "uaPrivate")), b64(d, "uaPublic"), b64(d, "auth"))
        val p = NativePayload.parse(plain)!!
        val want = chain.getJSONObject("expected")
        assertEquals(want.getString("title"), p.title)
        assertEquals(want.getString("body"), p.body)
        assertEquals(want.getLong("messageId"), p.messageId)
    }

    @Test fun nativeVectorsDecrypt() {
        val all = vectors()
        assertEquals(3, all.size)
        for (v in all) assertArrayEquals(v.getString("name"), b64(v, "plaintext"), decrypt(v))
    }

    @Test fun nativeVectorParses() {
        val v = vectors().first { it.getString("name") == "gecko-urgent-emoji" }
        val p = NativePayload.parse(decrypt(v))!!
        assertEquals("urgent", p.level)
        assertTrue(p.title.isNotEmpty())
    }

    @Test fun wrongKeyThrows() {
        val v = vectors()[0]
        val other = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().private
        assertThrows(Exception::class.java) { decrypt(v, key = other) }
    }

    @Test fun truncatedBodyThrows() {
        val v = vectors()[0]
        val body = b64(v, "body")
        assertThrows(Exception::class.java) { decrypt(v, body.copyOf(body.size - 1)) }
        assertThrows(Exception::class.java) { decrypt(v, body.copyOf(20)) }
    }

    @Test fun paddingStripped() {
        assertArrayEquals(byteArrayOf(1, 2), PushCrypto.stripPadding(byteArrayOf(1, 2, 2, 0, 0)))
        assertThrows(Exception::class.java) { PushCrypto.stripPadding(byteArrayOf(1, 0, 0)) }
        assertThrows(Exception::class.java) { PushCrypto.stripPadding(byteArrayOf(0, 0)) }
    }
}
