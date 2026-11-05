package com.kodviva.geckomail

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

private const val MAX_NAME_BYTES = 200

/** Yol ayıracı, denetim karakteri ve baştaki nokta atılır; sonuç tek dosya adıdır. Uzantı kısaltmada korunur */
fun sanitizeFilename(name: String): String {
    val base = name.substringAfterLast('/').substringAfterLast('\\').filter { !it.isISOControl() }.trim().trimStart('.').trim()
    if (base.isEmpty()) return "attachment"
    if (base.toByteArray().size <= MAX_NAME_BYTES) return base
    val dot = base.lastIndexOf('.')
    val ext = if (dot > 0 && base.length - dot <= 16) base.substring(dot) else ""
    var stem = base.dropLast(ext.length)
    while ((stem + ext).toByteArray().size > MAX_NAME_BYTES) stem = stem.dropLast(1)
    return stem + ext
}

/** İndirilen ekler: açılışta ve her dönüşte 24 saati geçenler, çıkışta hepsi silinir. Dosya başına rastgele dizin, aynı adlar çakışmaz */
class AttachmentCache(private val root: File, private val now: () -> Long = System::currentTimeMillis) {
    fun newFile(name: String): File {
        val dir = File(root, UUID.randomUUID().toString()).apply { mkdirs() }
        return File(dir, sanitizeFilename(name))
    }

    fun purge() {
        root.listFiles()?.forEach { dir ->
            val newest = dir.listFiles()?.maxOfOrNull(File::lastModified) ?: dir.lastModified()
            if (now() - newest >= DAY_MS) dir.deleteRecursively()
        }
    }

    fun clear() {
        root.listFiles()?.forEach { it.deleteRecursively() }
    }
}

private fun uriFor(a: Activity, f: File) = FileProvider.getUriForFile(a, "${a.packageName}.fileprovider", f)

private fun mimeOf(f: File) = MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"

/** false: dosyayı açacak uygulama yok */
fun Activity.viewFile(f: File): Boolean {
    val i = Intent(Intent.ACTION_VIEW).setDataAndType(uriFor(this, f), mimeOf(f)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return try {
        startActivity(i)
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}

/** Dışa aktarma paylaşım sayfasıyla: kullanıcı nereye kaydedeceğini kendisi seçer */
fun Activity.shareFile(f: File): Boolean {
    val uri = uriFor(this, f)
    val i = Intent(Intent.ACTION_SEND).setType(mimeOf(f)).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    i.clipData = ClipData.newRawUri(f.name, uri)
    return try {
        startActivity(Intent.createChooser(i, f.name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}
