package com.kodviva.geckomail.push

import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PrivateKey
import java.math.BigInteger
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

private const val SALT_BYTES = 16
private const val HEADER_BYTES = SALT_BYTES + 4 + 1
private const val PUBLIC_KEY_BYTES = 65
private const val TAG_BYTES = 16
private const val TAG_BITS = 128
private const val COORD_BYTES = 32

@OptIn(ExperimentalEncodingApi::class)
private val base64Url = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)

/** java.util.Base64 API 26 ister; minSdk 24 */
@OptIn(ExperimentalEncodingApi::class)
fun base64UrlDecode(s: String): ByteArray? = try { base64Url.decode(s) } catch (_: IllegalArgumentException) { null }

@OptIn(ExperimentalEncodingApi::class)
fun base64UrlEncode(b: ByteArray): String = base64Url.encode(b).trimEnd('=')

/**
 * RFC 8291 aes128gcm. Gönderen tek kayıt üretir (Parça 3 encryptPayload): çok kayıtlı gövde reddedilir.
 * Özel anahtardan açık nokta JCA ile türetilemez: `publicKey` (65 bayt) key_info için ayrıca verilir.
 */
object PushCrypto {
    fun decrypt(body: ByteArray, privateKey: PrivateKey, publicKey: ByteArray, auth: ByteArray): ByteArray {
        require(body.size > HEADER_BYTES + PUBLIC_KEY_BYTES + TAG_BYTES) { "kısa gövde" }
        val salt = body.copyOfRange(0, SALT_BYTES)
        val rs = (SALT_BYTES until SALT_BYTES + 4).fold(0L) { acc, i -> acc shl 8 or (body[i].toLong() and 0xff) }
        require(body[SALT_BYTES + 4].toInt() == PUBLIC_KEY_BYTES) { "anahtar kimliği" }
        val serverKey = body.copyOfRange(HEADER_BYTES, HEADER_BYTES + PUBLIC_KEY_BYTES)
        val record = body.copyOfRange(HEADER_BYTES + PUBLIC_KEY_BYTES, body.size)
        require(record.size <= rs) { "çok kayıt" }

        val shared = KeyAgreement.getInstance("ECDH").run {
            init(privateKey)
            doPhase(decodePublic(serverKey), true)
            generateSecret()
        }
        val keyInfo = "WebPush: info\u0000".toByteArray() + publicKey + serverKey
        val ikm = expand(extract(auth, shared), keyInfo, 32)
        val prk = extract(salt, ikm)
        val cek = expand(prk, "Content-Encoding: aes128gcm\u0000".toByteArray(), 16)
        val nonce = expand(prk, "Content-Encoding: nonce\u0000".toByteArray(), 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        return stripPadding(cipher.doFinal(record))
    }

    /** Sondaki sıfırlar atılır, ayraç son kayıtta 0x02'dir */
    fun stripPadding(plain: ByteArray): ByteArray {
        val end = plain.indexOfLast { it != 0.toByte() }
        require(end >= 0 && plain[end] == 2.toByte()) { "doldurma" }
        return plain.copyOfRange(0, end)
    }

    private fun decodePublic(raw: ByteArray) = KeyFactory.getInstance("EC").generatePublic(
        ECPublicKeySpec(
            ECPoint(BigInteger(1, raw.copyOfRange(1, 1 + COORD_BYTES)), BigInteger(1, raw.copyOfRange(1 + COORD_BYTES, raw.size))),
            AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
        )
    )

    private fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        parts.forEach(::update)
        doFinal()
    }

    private fun extract(salt: ByteArray, ikm: ByteArray) = hmac(salt, ikm)

    /** Tek blok yeter: istenen boy hep 32 bayt ve altı */
    private fun expand(prk: ByteArray, info: ByteArray, size: Int) = hmac(prk, info, byteArrayOf(1)).copyOf(size)
}
