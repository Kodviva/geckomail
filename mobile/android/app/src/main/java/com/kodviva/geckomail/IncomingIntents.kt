package com.kodviva.geckomail

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.URI
import java.net.URISyntaxException
import java.util.UUID

const val DAY_MS = 86_400_000L
const val SHARE_MAX_BYTES = 25_000_000L
const val SHARE_MAX_FILES = 10
private const val MAX_SAFE_ID = 9_007_199_254_740_991L // Number.MAX_SAFE_INTEGER: JS tarafı üstünü reddeder
private const val MAX_TEXT = 100_000
private const val META = "meta.json"
private const val TAKEN = "taken"
private val ID = Regex("[1-9][0-9]{0,15}")

data class NativeOpenRequest(val messageId: Long, val reply: Boolean)

/** Yalnız geckomail://open?m=<id> ve ?reply=<id>. Sunucu, kullanıcı, yönlendirme alanı yoktur; başka hiçbir biçim kabul edilmez (T10) */
fun parseDeepLink(url: String): NativeOpenRequest? {
    val u = try { URI(url) } catch (_: URISyntaxException) { return null }
    if (u.scheme != "geckomail" || u.host != "open" || u.rawUserInfo != null || u.port != -1 || !u.rawPath.isNullOrEmpty() || u.rawFragment != null) return null
    val (key, value) = (u.rawQuery ?: return null).split("=", limit = 2).takeIf { it.size == 2 } ?: return null
    if (key != "m" && key != "reply") return null
    if (!ID.matches(value)) return null
    val id = value.toLong().takeIf { it <= MAX_SAFE_ID } ?: return null
    return NativeOpenRequest(id, key == "reply")
}

fun parseDeepLink(uri: Uri): NativeOpenRequest? = parseDeepLink(uri.toString())

/** Yalnız başka uygulamanın content:// içeriği: file:// ya da kendi sağlayıcımız, uygulamanın özel dosyasını yükletmek için kullanılabilir */
fun shareableUri(scheme: String?, authority: String?, own: String): Boolean = scheme == ContentResolver.SCHEME_CONTENT && authority != own

class SharedItem(val name: String?, val mime: String?, val open: () -> InputStream?)

data class SharedFile(val name: String, val path: String, val mime: String?)
data class Share(val id: String, val files: List<SharedFile>, val text: String?, val skipped: Int) {
    fun uploadPath(f: SharedFile) = "/_capacitor_file_" + f.path
}

/**
 * Giriş ve kilit sonrası boşaltılana dek bekleyen paylaşımlar. Diskte durur (süreç ölebilir), 24 saatte silinir. Dosya adları sıra
 * numarasıdır: /_capacitor_file_ yoluna kullanıcı adı girmez. meta.json en son yazılır, varlığı paylaşımın bittiğini söyler.
 */
class ShareInbox(private val root: File, private val now: () -> Long = System::currentTimeMillis) {
    fun accept(items: List<SharedItem>, text: String?): Boolean {
        val note = text?.take(MAX_TEXT)?.ifBlank { null }
        if (items.isEmpty() && note == null) return false
        val dir = File(root, UUID.randomUUID().toString()).apply { mkdirs() }
        val files = JSONArray()
        var skipped = 0
        items.forEach { item ->
            val index = files.length()
            val file = File(dir, index.toString())
            if (index >= SHARE_MAX_FILES || !copyLimited(item, file)) {
                skipped++
                file.delete()
            } else {
                files.put(JSONObject().put("name", sanitizeFilename(item.name ?: "")).put("mime", item.mime ?: JSONObject.NULL).put("file", index.toString()))
            }
        }
        if (files.length() == 0 && note == null) {
            dir.deleteRecursively()
            return false
        }
        val meta = JSONObject().put("files", files).put("text", note ?: JSONObject.NULL).put("skipped", skipped).put("at", now())
        val tmp = File(dir, "$META.tmp")
        tmp.writeText(meta.toString())
        tmp.renameTo(File(dir, META))
        return true
    }

    private fun copyLimited(item: SharedItem, dest: File): Boolean = try {
        item.open()?.use { input ->
            dest.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > SHARE_MAX_BYTES) return false
                    out.write(buf, 0, n)
                }
            }
            true
        } ?: false
    } catch (_: Exception) {
        false
    }

    private fun dirs() = root.listFiles()?.filter { File(it, META).isFile } ?: emptyList()

    /** Her paylaşım bir kez verilir; dosyalar finish ya da 24 saat dolana dek durur */
    fun take(): List<Share> = dirs().filter { !File(it, TAKEN).exists() }.mapNotNull { dir ->
        val m = try { JSONObject(File(dir, META).readText()) } catch (_: Exception) { return@mapNotNull null }
        File(dir, TAKEN).createNewFile()
        val a = m.getJSONArray("files")
        val files = (0 until a.length()).map(a::getJSONObject).map {
            SharedFile(it.getString("name"), File(dir, it.getString("file")).path, if (it.isNull("mime")) null else it.getString("mime"))
        }
        Share(dir.name, files, if (m.isNull("text")) null else m.getString("text"), m.getInt("skipped"))
    }

    fun hasPending() = dirs().any { !File(it, TAKEN).exists() }

    fun finish() = dirs().filter { File(it, TAKEN).exists() }.forEach { it.deleteRecursively() }

    fun sweep() {
        root.listFiles()?.forEach { dir ->
            val at = try { JSONObject(File(dir, META).readText()).getLong("at") } catch (_: Exception) { dir.lastModified() }
            if (now() - at >= DAY_MS) dir.deleteRecursively()
        }
    }

    fun clear() {
        root.listFiles()?.forEach { it.deleteRecursively() }
    }
}

/** Başka uygulamadan gelen ACTION_SEND. Kopyalama IO iş parçacığında: dokunma izni etkinlik yaşadığı sürece geçerlidir */
object IncomingIntents {
    fun isShare(i: Intent) = i.action == Intent.ACTION_SEND || i.action == Intent.ACTION_SEND_MULTIPLE

    fun sharedText(i: Intent): String? = i.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()

    @Suppress("DEPRECATION") // yeni imza API 33 ister
    fun sharedItems(i: Intent, ctx: Context): List<SharedItem> {
        val uris: List<Uri> = when (i.action) {
            Intent.ACTION_SEND -> listOfNotNull(i.getParcelableExtra(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.filterNotNull() ?: emptyList()
            else -> emptyList()
        }
        val own = "${ctx.packageName}.fileprovider"
        return uris.filter { shareableUri(it.scheme, it.authority, own) }.map { u ->
            SharedItem(displayName(ctx, u), ctx.contentResolver.getType(u)) { ctx.contentResolver.openInputStream(u) }
        }
    }

    private fun displayName(ctx: Context, u: Uri): String? = try {
        ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }
}
