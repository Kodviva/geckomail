package com.kodviva.geckomail

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File

class IncomingIntentsTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun deepLinkOpensMessage() {
        assertEquals(NativeOpenRequest(1, false), parseDeepLink("geckomail://open?m=1"))
        assertEquals(NativeOpenRequest(42, true), parseDeepLink("geckomail://open?reply=42"))
        assertEquals(NativeOpenRequest(9007199254740991, false), parseDeepLink("geckomail://open?m=9007199254740991"))
    }

    @Test fun deepLinkCannotChangeServer() {
        for (u in listOf(
            "geckomail://open?server=https://evil.example", "geckomail://open?m=1&server=https://evil.example", "geckomail://evil/open?m=1",
            "geckomail://evil?m=1", "geckomail://open/x?m=1", "geckomail://user@open?m=1", "geckomail://open:8080?m=1", "https://open?m=1",
            "geckomail://open?m=1&reply=2", "geckomail://open?m=1&m=2", "geckomail://open?m=1#x", "GECKOMAIL://open?m=1", "geckomail://open"
        )) assertNull(u, parseDeepLink(u))
    }

    @Test fun nonNumericIdRejected() {
        for (id in listOf("abc", "-1", "0", "1.5", "+1", "1e3", "0x10", "01", "", "%31", "١"))
            assertNull(id, parseDeepLink("geckomail://open?m=$id"))
    }

    @Test fun hugeIdRejected() {
        assertNull(parseDeepLink("geckomail://open?m=9007199254740992"))
        assertNull(parseDeepLink("geckomail://open?m=99999999999999999999999"))
    }

    @Test fun filenameSanitized() {
        assertEquals("x", sanitizeFilename("../../x"))
        assertEquals("x.pdf", sanitizeFilename("a\\b/x.pdf"))
        assertEquals("rapor.pdf", sanitizeFilename("rapor\u0000\n.pdf"))
        assertEquals("gizli", sanitizeFilename(".gizli"))
        assertEquals("attachment", sanitizeFilename(""))
        assertEquals("attachment", sanitizeFilename("../.."))
        assertEquals("attachment", sanitizeFilename("..."))
        assertEquals("Şubat raporu.pdf", sanitizeFilename("Şubat raporu.pdf"))
        val long = sanitizeFilename("a".repeat(300) + ".pdf")
        assertTrue(long.toByteArray().size <= 200)
        assertTrue(long.endsWith(".pdf"))
    }

    @Test fun sharedUriOnlyForeignContent() {
        assertTrue(shareableUri("content", "com.android.providers.media", "me.fileprovider"))
        assertFalse(shareableUri("file", null, "me.fileprovider")) // kendi özel dosyamız yüklenmesin
        assertFalse(shareableUri("content", "me.fileprovider", "me.fileprovider"))
        assertFalse(shareableUri("https", "evil.example", "me.fileprovider"))
    }

    private fun item(name: String?, bytes: Int, mime: String? = "application/pdf") =
        SharedItem(name, mime) { ByteArrayInputStream(ByteArray(bytes)) }

    private fun inbox(now: () -> Long = { 1_000L }) = ShareInbox(tmp.root, now)

    @Test fun shareWaitsForLogin() {
        inbox().accept(listOf(item("a.pdf", 10)), "not")
        val again = inbox() // süreç yeniden başladı
        val s = again.take().single()
        assertEquals("a.pdf", s.files.single().name)
        assertEquals("not", s.text)
        assertTrue(File(s.files.single().path).isFile)
        assertTrue(s.uploadPath(s.files.single()).startsWith("/_capacitor_file_/"))
        assertTrue(again.take().isEmpty()) // ikinci kez verilmez
    }

    @Test fun oversizedShareWarns() {
        val b = inbox()
        b.accept(listOf(item("kucuk", 10), item("buyuk", SHARE_MAX_BYTES.toInt() + 1)) + List(11) { item("n$it", 1) }, null)
        val s = b.take().single()
        assertEquals(SHARE_MAX_FILES, s.files.size)
        assertEquals(3, s.skipped)
        assertFalse(s.files.any { it.name == "buyuk" })
    }

    @Test fun unreadableItemSkipped() {
        val b = inbox()
        b.accept(listOf(SharedItem("x", null) { null }, item("a", 1)), null)
        assertEquals(1, b.take().single().skipped)
    }

    @Test fun nothingAcceptable() = assertFalse(inbox().accept(emptyList(), null))

    @Test fun finishDeletesOnlyTaken() {
        val b = inbox()
        b.accept(listOf(item("a", 1)), null)
        val taken = b.take().single()
        b.accept(listOf(item("b", 1)), null)
        b.finish()
        assertFalse(File(taken.files.single().path).exists())
        assertEquals("b", b.take().single().files.single().name)
    }

    @Test fun sweepRemovesAfterDay() {
        var now = 1_000L
        val b = inbox { now }
        b.accept(listOf(item("a", 1)), null)
        now += DAY_MS - 1
        b.sweep()
        assertEquals(0, b.take().flatMap { it.files }.count { !File(it.path).exists() })
        now += 2
        b.sweep()
        assertTrue(b.take().isEmpty())
        assertEquals(0, tmp.root.list()!!.size)
    }

    @Test fun signOutClearsShares() {
        val b = inbox()
        b.accept(listOf(item("a", 1)), null)
        b.clear()
        assertTrue(b.take().isEmpty())
    }

    @Test fun attachmentCacheClearedOnLogout() {
        val c = AttachmentCache(tmp.root)
        val f = c.newFile("../../x.pdf")
        f.writeText("veri")
        assertEquals("x.pdf", f.name)
        assertTrue(f.canonicalPath.startsWith(tmp.root.canonicalPath))
        c.clear()
        assertFalse(f.exists())
    }

    @Test fun attachmentCachePurgedAfterDay() {
        var now = 1_000L
        val c = AttachmentCache(tmp.root) { now }
        val f = c.newFile("a")
        f.writeText("v")
        now = f.lastModified() + DAY_MS - 1
        c.purge()
        assertTrue(f.exists())
        now += 2
        c.purge()
        assertFalse(f.exists())
    }

    @Test fun onlyWebAndMailLinksLeaveTheApp() {
        for (u in listOf("https://example.com/", "HTTP://example.com", "mailto:a@example.test")) assertTrue(u, isExternalLink(u))
        for (u in listOf("intent://x#Intent;end", "file:///data/x", "content://x/y", "javascript:alert(1)", "geckomail://open?m=1", "x")) assertFalse(u, isExternalLink(u))
    }
}
