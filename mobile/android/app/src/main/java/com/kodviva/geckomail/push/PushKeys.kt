package com.kodviva.geckomail.push

import android.content.Context
import android.util.Base64
import com.kodviva.geckomail.KeystoreBox
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec

private const val COORD_BYTES = 32
private const val AUTH_BYTES = 16

class Material(val publicRaw: ByteArray, val authSecret: ByteArray, val private: PrivateKey) {
    val p256dh: String get() = base64UrlEncode(publicRaw)
    val auth: String get() = base64UrlEncode(authSecret)
}

interface PushKeySource {
    fun loadOrCreate(): Material
    fun load(): Material?
    fun delete()
}

/** Keystore ECDH API 31+ ister, minSdk 24: P-256 anahtarı yazılımda üretilir, PKCS8 KeystoreBox ile mühürlenir */
class PushKeys(private val box: KeystoreBox, ctx: Context) : PushKeySource {
    private val prefs = ctx.getSharedPreferences("gecko.push.keys", Context.MODE_PRIVATE)

    override fun loadOrCreate(): Material = load() ?: generate().also(::save)

    override fun load(): Material? {
        val public = unseal("public") ?: return null
        val auth = unseal("auth") ?: return null
        val pkcs8 = unseal("private") ?: return null
        return try {
            Material(public, auth, KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8)))
        } catch (_: Exception) {
            null
        }
    }

    fun save(m: Material) {
        val e = prefs.edit()
        e.putString("public", seal(m.publicRaw)).putString("auth", seal(m.authSecret)).putString("private", seal(m.private.encoded))
        e.commit() // anahtar süreç ölümünde kaybolmasın: sunucuya bildirilen anahtarla aynı kalmalı
    }

    override fun delete() {
        prefs.edit().clear().commit()
    }

    private fun seal(b: ByteArray) = Base64.encodeToString(box.seal(b), Base64.NO_WRAP)

    private fun unseal(k: String): ByteArray? = prefs.getString(k, null)?.let { box.open(Base64.decode(it, Base64.NO_WRAP)) }

    private fun generate(): Material {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val w = (pair.public as ECPublicKey).w
        val raw = byteArrayOf(4) + fixed(w.affineX) + fixed(w.affineY)
        return Material(raw, ByteArray(AUTH_BYTES).also(SecureRandom()::nextBytes), pair.private)
    }

    private fun fixed(v: BigInteger): ByteArray {
        val b = v.toByteArray().takeLast(COORD_BYTES).toByteArray()
        return ByteArray(COORD_BYTES - b.size) + b
    }
}
