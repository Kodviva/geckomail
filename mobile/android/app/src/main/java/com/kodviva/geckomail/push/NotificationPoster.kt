package com.kodviva.geckomail.push

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.withTimeoutOrNull
import com.kodviva.geckomail.ActionOutcome
import com.kodviva.geckomail.MainActivity
import com.kodviva.geckomail.R

const val CHANNEL_NORMAL = "mail_normal"
const val CHANNEL_URGENT = "mail_urgent"
const val NOTIFICATION_MESSAGE = 1
const val NOTIFICATION_GROUP = 2
private const val TAG_FALLBACK = "fallback"
private const val TAG_RELOGIN = "relogin"
private const val TAG_LOCKED = "locked"
private const val GROUP_SUMMARY = "summary"
private const val CATEGORY_MESSAGE = "msg"
private const val ACTION_LIMIT_MS = 9_000L

data class NotificationPlan(val channel: String, val category: String?, val group: String, val actions: List<String>)

/** Üye başka hesapta yalnız `read` alabilir; `reply` tek başına eylem açmaz (iOS kategorileriyle aynı). Özet iletiye bağlı değildir */
fun planFor(p: NativePayload): NotificationPlan {
    val urgent = p.level == "urgent"
    val actions = when {
        p.messageId == null -> emptyList()
        "archive" in p.actions -> listOf("read", "archive", "reply")
        "read" in p.actions -> listOf("read")
        else -> emptyList()
    }
    return NotificationPlan(
        if (urgent) CHANNEL_URGENT else CHANNEL_NORMAL, if (urgent) CATEGORY_MESSAGE else null,
        p.accountId?.let { "acct-$it" } ?: GROUP_SUMMARY, actions
    )
}

/** setAuthenticationRequired API 31 altında etkisiz: kilitli cihazda eylem burada reddedilir. Uygulama kilidi her sürümde geçerli */
fun refusesAction(sdk: Int, deviceLocked: Boolean, appLocked: Boolean): Boolean = appLocked || (sdk < Build.VERSION_CODES.S && deviceLocked)

interface Posting {
    fun post(p: NativePayload)
    fun postFallback()
    fun postRelogin()
    fun postLocked()
    fun remove(tag: String)
}

/** Çözülemezse (anahtar yok ya da değişti, bozuk kutu) nötr metin: şifreli metin ya da boş bildirim çıkmaz. Ağ çağrısı yapmaz */
class PushHandler(
    private val keys: () -> Material?,
    private val poster: Posting,
    private val foreground: () -> Boolean,
    private val decrypt: (ByteArray, Material) -> ByteArray = { b, m -> PushCrypto.decrypt(b, m.private, m.publicRaw, m.authSecret) }
) {
    fun handle(box: String?) {
        if (foreground()) return // açık uygulama listeyi soketten günceller: çift bildirim yok
        val p = open(box)
        if (p != null) poster.post(p) else poster.postFallback()
    }

    private fun open(box: String?): NativePayload? {
        val body = box?.let(::base64UrlDecode) ?: return null
        val m = keys() ?: return null
        return try { NativePayload.parse(decrypt(body, m)) } catch (_: Exception) { null }
    }
}

/** read/archive arka planda yerel oturumla gider; süre dolarsa biter, yayın alıcısı sistemce öldürülmez */
class ActionHandler(
    private val send: suspend (Long, String) -> ActionOutcome,
    private val poster: Posting,
    private val limitMs: Long = ACTION_LIMIT_MS
) {
    suspend fun run(messageId: Long, action: String, tag: String) {
        when (withTimeoutOrNull(limitMs) { send(messageId, action) }) {
            ActionOutcome.Ok -> poster.remove(tag)
            ActionOutcome.Auth -> poster.postRelogin()
            ActionOutcome.Failed, null -> {}
        }
    }
}

class NotificationPoster(ctx: Context) : Posting {
    private val ctx = ctx.applicationContext
    private val nm = NotificationManagerCompat.from(this.ctx)

    private fun ensureChannels() {
        nm.createNotificationChannelsCompat(
            listOf(
                NotificationChannelCompat.Builder(CHANNEL_NORMAL, NotificationManagerCompat.IMPORTANCE_DEFAULT).setName(ctx.getString(R.string.channel_normal)).build(),
                NotificationChannelCompat.Builder(CHANNEL_URGENT, NotificationManagerCompat.IMPORTANCE_HIGH).setName(ctx.getString(R.string.channel_urgent)).build()
            )
        )
    }

    private fun show(tag: String, id: Int, n: android.app.Notification) {
        try {
            nm.notify(tag, id, n)
        } catch (_: SecurityException) {
            /* izin kapalı: sistem zaten göstermez */
        }
    }

    private fun base(channel: String) = NotificationCompat.Builder(ctx, channel).setSmallIcon(R.drawable.ic_stat_mail).setAutoCancel(true)

    private fun activityIntent(req: OpenRequest?): PendingIntent {
        val i = Intent(ctx, if (req == null) MainActivity::class.java else NotificationOpenActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        req?.let {
            it.writeTo(i)
            i.data = Uri.parse("geckomail://open?${if (it.reply) "reply" else "m"}=${it.messageId ?: 0}&a=${it.accountId ?: 0}") // PendingIntent kimliği
        }
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun broadcast(p: NativePayload, action: String): PendingIntent {
        val i = Intent(ctx, NotificationActionReceiver::class.java).setAction(action).putExtra(EXTRA_MESSAGE, p.messageId).putExtra(EXTRA_TAG, p.tag)
        i.data = Uri.parse("geckomail://action/$action/${p.messageId}") // PendingIntent kimliği
        return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun action(id: String, p: NativePayload): NotificationCompat.Action = when (id) {
        "reply" -> NotificationCompat.Action.Builder(0, ctx.getString(R.string.notify_action_reply), activityIntent(OpenRequest(p.messageId, p.accountId, true))).build()
        else -> {
            val title = if (id == "read") R.string.notify_action_read else R.string.notify_action_archive
            NotificationCompat.Action.Builder(0, ctx.getString(title), broadcast(p, id)).setAuthenticationRequired(true).build()
        }
    }

    override fun post(p: NativePayload) {
        ensureChannels()
        val plan = planFor(p)
        val b = base(plan.channel).setContentTitle(p.title).setContentText(p.body).setStyle(NotificationCompat.BigTextStyle().bigText(p.body))
            .setWhen(p.ts).setShowWhen(true).setNumber(p.count).setGroup(plan.group).setCategory(plan.category)
            .setContentIntent(activityIntent(OpenRequest(p.messageId, p.accountId, false)))
        plan.actions.forEach { b.addAction(action(it, p)) }
        show(p.tag, NOTIFICATION_MESSAGE, b.build())
        val summary = base(plan.channel).setContentText(ctx.getString(R.string.push_fallback)).setGroup(plan.group).setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN).setContentIntent(activityIntent(OpenRequest(null, p.accountId, false)))
        show(plan.group, NOTIFICATION_GROUP, summary.build())
    }

    override fun postFallback() {
        ensureChannels()
        val b = base(CHANNEL_NORMAL).setContentText(ctx.getString(R.string.push_fallback)).setContentIntent(activityIntent(null))
        show(TAG_FALLBACK, NOTIFICATION_MESSAGE, b.build())
    }

    /** Bildirim eylemi oturum bulamadı: dokunmak uygulamayı açar, giriş orada istenir */
    override fun postRelogin() {
        ensureChannels()
        val b = base(CHANNEL_NORMAL).setContentText(ctx.getString(R.string.push_relogin)).setContentIntent(activityIntent(null))
        show(TAG_RELOGIN, NOTIFICATION_MESSAGE, b.build())
    }

    /** Eylem kilit yüzünden yapılmadı: dokunmak uygulamayı açar. API 31+ alıcıdan etkinlik başlatamaz */
    override fun postLocked() {
        ensureChannels()
        val b = base(CHANNEL_NORMAL).setContentText(ctx.getString(R.string.lock_title)).setContentIntent(activityIntent(null))
        show(TAG_LOCKED, NOTIFICATION_MESSAGE, b.build())
    }

    override fun remove(tag: String) = nm.cancel(tag, NOTIFICATION_MESSAGE)

    fun clearAll() = nm.cancelAll()
}

/** Build.VERSION kontrolü tek yerde: izin yalnız Android 13+ */
val needsNotificationPermission: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
