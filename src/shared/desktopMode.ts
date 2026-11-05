// Masaüstü sunucu moduna geçişin main ve renderer arasındaki sonuç türü.
export type ProbeFailure = 'invalid' | 'insecure' | 'unreachable' | 'notGecko' | 'originMismatch' | 'apiMismatch'
export type ProbeResult = { ok: true; origin: string } | { ok: false; reason: ProbeFailure }

/** Taşımaya sarmalanan ana süreç olayları; başka olay sayfaya bu kanaldan girmez */
export const LOCAL_EVENTS = ['local:open-message', 'local:open-account', 'local:open-reply', 'local:menu'] as const
