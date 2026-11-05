// Mağaza — Kasa.

import { rpc } from '../rpcClient'
import { t } from '../../../shared/i18n'
import type { GetState, SetState, State } from './types'
import { platform } from '../platform'

export const vaultSlice = (set: SetState, get: GetState) =>
  ({
    async refreshVaultState() {
      try {
        const { state, biometricEnabled } = await rpc.call('getVaultState', {})
        const touchIdAvailable = await platform.biometricAvailable().catch(() => false)
        set({ vaultState: state, vaultBiometricEnabled: biometricEnabled, touchIdAvailable })
      } catch {
        /* bağlantı yoksa sonra tekrar */
      }
    },

    async enableVaultBiometric(passphrase) {
      try {
        await rpc.call('enableVaultBiometric', { passphrase })
        set({ vaultBiometricEnabled: true })
        get().toast(t('acct.vault.biometricEnabled'), 'info')
        return true
      } catch (e) {
        get().toast(String((e as Error).message))
        return false
      }
    },

    async disableVaultBiometric() {
      try {
        await rpc.call('disableVaultBiometric', {})
        set({ vaultBiometricEnabled: false })
        get().toast(t('acct.vault.biometricDisabled'), 'info')
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async unlockVaultBiometric() {
      try {
        const ok = await platform.promptBiometric(t('acct.vault.touchIdPrompt'))
        if (!ok) return false // iptal / başarısız
        const { ok: unlocked, state } = await rpc.call('unlockVaultBiometric', {})
        set({ vaultState: state })
        if (unlocked) {
          set({ vaultPromptOpen: false })
          get().toast(t('acct.vault.unlocked'), 'info')
          void get().refreshList(false)
          void get().refreshAccounts()
        }
        return unlocked
      } catch (e) {
        get().toast(String((e as Error).message))
        return false
      }
    },

    setVaultPromptOpen(v) {
      set({ vaultPromptOpen: v })
    },

    async unlockVault(password) {
      try {
        const { ok, state } = await rpc.call('unlockVault', { password })
        set({ vaultState: state })
        if (ok) {
          set({ vaultPromptOpen: false })
          get().toast(t('acct.vault.unlocked'), 'info')
          void get().refreshList(false)
          void get().refreshAccounts()
        } else {
          get().toast(t('acct.vault.wrongPassword'), 'error')
        }
        return ok
      } catch (e) {
        get().toast(String((e as Error).message))
        return false
      }
    },

    async lockVault() {
      try {
        const { state } = await rpc.call('lockVault', {})
        set({ vaultState: state })
        get().toast(t('acct.vault.locked'), 'info')
        void get().refreshList(false)
        void get().refreshAccounts()
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async createVault(password) {
      try {
        const { state } = await rpc.call('createVault', { password })
        set({ vaultState: state })
        get().toast(t('acct.vault.created'), 'info')
        return true
      } catch (e) {
        get().toast(String((e as Error).message))
        return false
      }
    },

    async setAccountSecure(accountId, secure) {
      try {
        await rpc.call('setAccountSecure', { accountId, secure })
        await get().refreshAccounts()
        void get().refreshList(false)
        get().toast(secure ? t('acct.vault.accountSecured') : t('acct.vault.accountUnsecured'), 'info')
      } catch (e) {
        get().toast(String((e as Error).message))
        throw e
      }
    }
  }) satisfies Partial<State>
