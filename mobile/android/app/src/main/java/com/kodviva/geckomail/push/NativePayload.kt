package com.kodviva.geckomail.push

import org.json.JSONObject

/** src/shared/nativePush.ts NativePayload ile aynı. `level: silent` üretilmez */
data class NativePayload(
    val v: Int,
    val title: String,
    val body: String,
    val accountId: Long?,
    val messageId: Long?,
    val level: String,
    val tag: String,
    val count: Int,
    val ts: Long,
    val actions: List<String>
) {
    companion object {
        fun parse(json: ByteArray): NativePayload? = try {
            val o = JSONObject(json.decodeToString())
            val level = o.getString("level")
            val a = o.getJSONArray("actions")
            if (o.getInt("v") != 1 || (level != "normal" && level != "urgent")) null
            else NativePayload(
                1, o.getString("title"), o.getString("body"), id(o, "accountId"), id(o, "messageId"), level, o.getString("tag"),
                o.getInt("count"), o.getLong("ts"), (0 until a.length()).map(a::getString)
            )
        } catch (_: Exception) {
            null
        }

        private fun id(o: JSONObject, k: String): Long? = if (o.isNull(k)) null else o.getLong(k)
    }
}
