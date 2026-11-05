package com.kodviva.geckomail.push

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.kodviva.geckomail.AppServices
import com.kodviva.geckomail.MainActivity

/** Bildirim dokunuşu: exported=false, yalnız uygulamanın PendingIntent'i ulaşır. Dışa açık MainActivity ek alanlara güvenmez */
class NotificationOpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        OpenRequest.fromIntent(intent)?.let(AppServices.get(this).opens::add)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }
}
