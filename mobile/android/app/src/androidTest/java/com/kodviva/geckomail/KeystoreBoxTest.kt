package com.kodviva.geckomail

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class KeystoreBoxTest {
    private val box = KeystoreBox("gecko.test")

    @Test fun roundTrip() {
        val plain = "gizli".toByteArray()
        val blob = box.seal(plain)
        assertNotEquals(String(plain), String(blob))
        assertArrayEquals(plain, box.open(blob))
    }

    @Test fun corruptBlobIsNull() {
        val blob = box.seal("gizli".toByteArray())
        blob[blob.size - 1] = (blob[blob.size - 1].toInt() xor 1).toByte()
        assertNull(box.open(blob))
        assertNull(box.open(ByteArray(3)))
    }
}
