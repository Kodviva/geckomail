package com.kodviva.geckomail.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch
import com.kodviva.geckomail.AppServices

/** Veri mesajı uygulama kapalıyken de buraya gelir. FCM işleyicisi 20 sn içinde biter: ağ çağrısı yok */
open class GeckoMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        AppServices.get(this).pushHandler.handle(message.data["c"])
    }

    override fun onNewToken(token: String) {
        val s = AppServices.get(this)
        s.scope.launch { s.registrar.tokenChanged(token) }
    }
}
