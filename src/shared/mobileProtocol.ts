// Mobil WebSocket alt protokolü: sunucu ve istemci aynı değerleri kullanır. Bilet adreste değil Sec-WebSocket-Protocol'dedir.
export const WS_SUBPROTOCOL = 'gecko.v1'
export const WS_TICKET_PREFIX = 'gecko.ticket.'
/** Biletli soket erişim belirteciyle biter: oturum iptali (4401) değil, istemci yeni biletle sessizce döner */
export const WS_CLOSE_RENEW = 4408
