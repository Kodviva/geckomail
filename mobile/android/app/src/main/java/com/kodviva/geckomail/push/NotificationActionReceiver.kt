package com.kodviva.geckomail.push

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import kotlinx.coroutines.launch
import com.kodviva.geckomail.AppServices
import com.kodviva.geckomail.MainActivity

const val EXTRA_MESSAGE = "gecko.action.message"
const val EXTRA_TAG = "gecko.action.tag"

/** Yalnız uygulamanın kendi PendingIntent'leri çağırır: exported=false */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val messageId = intent.getLongExtra(EXTRA_MESSAGE, 0)
        val tag = intent.getStringExtra(EXTRA_TAG)
        val action = intent.action
        if (messageId <= 0 || tag == null || (action != "read" && action != "archive")) return
        val s = AppServices.get(ctx)
        val keyguard = ctx.getSystemService(KeyguardManager::class.java)
        if (refusesAction(Build.VERSION.SDK_INT, keyguard.isDeviceLocked, s.lock.isLocked())) return openApp(ctx, s)
        val done = goAsync()
        s.scope.launch {
            try {
                ActionHandler(s.api::notifyAction, s.poster).run(messageId, action, tag)
            } finally {
                done.finish()
            }
        }
    }

    private fun openApp(ctx: Context, s: AppServices) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return s.poster.postLocked()
        ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
