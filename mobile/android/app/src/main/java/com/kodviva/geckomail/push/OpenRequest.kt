package com.kodviva.geckomail.push

import android.content.Intent
import com.getcapacitor.JSObject
import org.json.JSONObject

private const val EXTRA_OPEN_MESSAGE = "gecko.open.message"
private const val EXTRA_OPEN_ACCOUNT = "gecko.open.account"
private const val EXTRA_OPEN_REPLY = "gecko.open.reply"

/** Bildirim dokunuşu. Yalnız pozitif tamsayı kimlikler taşır (T10) */
data class OpenRequest(val messageId: Long?, val accountId: Long?, val reply: Boolean) {
    fun writeTo(i: Intent) {
        messageId?.let { i.putExtra(EXTRA_OPEN_MESSAGE, it) }
        accountId?.let { i.putExtra(EXTRA_OPEN_ACCOUNT, it) }
        i.putExtra(EXTRA_OPEN_REPLY, reply)
    }

    fun toJs() = JSObject().apply {
        put("messageId", messageId ?: JSONObject.NULL)
        put("accountId", accountId ?: JSONObject.NULL)
        put("reply", reply)
    }

    companion object {
        fun fromIntent(i: Intent): OpenRequest? {
            val m = i.getLongExtra(EXTRA_OPEN_MESSAGE, 0).takeIf { it > 0 }
            val a = i.getLongExtra(EXTRA_OPEN_ACCOUNT, 0).takeIf { it > 0 }
            if (m == null && a == null) return null
            return OpenRequest(m, a, m != null && i.getBooleanExtra(EXTRA_OPEN_REPLY, false))
        }
    }
}

/** Soğuk açılışta eklenti yokken gelenler bekler; takePending oturum ve kilit sonrası boşaltır */
class PendingOpens {
    private val waiting = mutableListOf<OpenRequest>()
    private var listener: ((OpenRequest) -> Unit)? = null
    /** Yalnız testte dolu: eklenti bağlıyken gelenler kuyruğa girmez */
    @Volatile var observer: ((OpenRequest) -> Unit)? = null

    @Synchronized fun setListener(cb: ((OpenRequest) -> Unit)?) { listener = cb }

    fun add(o: OpenRequest) {
        observer?.invoke(o)
        val live = synchronized(this) {
            if (listener == null) waiting += o
            listener
        }
        live?.invoke(o)
    }

    @Synchronized fun take(): List<OpenRequest> = waiting.toList().also { waiting.clear() }
}
