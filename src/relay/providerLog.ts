// Sağlayıcı reddinin teşhisi: yalnız sağlayıcı, HTTP durumu ve nedeni. Belirteç, cihaz kimliği ve yanıt gövdesi yazılmaz.
// Neden sağlayıcının sabit kodudur; kalıba uymayan metin günlüğe taşınmaz.
const REASON = /^[A-Za-z0-9_]{1,64}$/

export function logDeliveryFailure(provider: 'apns' | 'fcm' | 'fcm-oauth', status: number, reason: string): void {
  console.error(`relay: ${provider} teslim etmedi (http ${status}, ${REASON.test(reason) ? reason : 'neden yok'})`)
}
