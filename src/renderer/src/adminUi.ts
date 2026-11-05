// Yönetim arayüzü mobilde yoktur: biletli soket yönetici yöntemlerini reddeder (RpcHub.ticketRefused), düğmeler boşuna görünmez.
// Yönetici aynı işleri tarayıcıda yapar (S4).
import type { SessionUser } from '../../shared/rpc'
import { platform } from './platform'

export const adminUi = (user: Pick<SessionUser, 'role'> | null | undefined): boolean => user?.role === 'admin' && !platform.native
