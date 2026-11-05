// Mağaza — Yönetim: kullanıcılar, gruplar, otomasyon.

import { rpc } from '../rpcClient'
import type { GetState, SetState, State } from './types'

export const adminSlice = (set: SetState, get: GetState) =>
  ({
    async refreshUsers() {
      try {
        set({ users: await rpc.call('getUsers', {}) })
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async refreshGroups() {
      try {
        set({ groups: await rpc.call('getGroups', {}) })
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    setUsersOpen(v) {
      set({ usersOpen: v })
    },

    setGroupsOpen(v) {
      set({ groupsOpen: v })
    },

    setEditUser(id) {
      set({ editUserId: id })
    },

    setEditGroup(id) {
      set({ editGroupId: id })
    },

    async refreshRules() {
      try {
        set({ rules: await rpc.call('getRules', {}) })
      } catch (e) {
        get().toast(String((e as Error).message))
      }
      // rozet ek bilgidir: alınamazsa liste yine çalışır
      await rpc.call('getRulePlacements', {}).then((rulePlacements) => set({ rulePlacements }), () => {})
    },

    async refreshWebhooks() {
      try {
        set({ webhooks: await rpc.call('getWebhooks', {}) })
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async refreshScheduledTriggers() {
      try {
        set({ scheduledTriggers: await rpc.call('getScheduledTriggers', {}) })
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    async refreshRuleLog() {
      try {
        set({ ruleLog: await rpc.call('getRuleLog', { limit: 200 }) })
      } catch (e) {
        get().toast(String((e as Error).message))
      }
    },

    setAutomationOpen(v) {
      set({ automationOpen: v })
    },

    setAutomationTab(t) {
      set({ automationTab: t })
      if (t === 'rules') void get().refreshRules()
      else if (t === 'webhooks') void get().refreshWebhooks()
      else if (t === 'triggers') void get().refreshScheduledTriggers()
      else void get().refreshRuleLog()
    },

    setEditRule(id) {
      set({ editRuleId: id })
    },

    setEditWebhook(id) {
      set({ editWebhookId: id })
    },

    setEditTrigger(id) {
      set({ editTriggerId: id })
    },

    openRuleBuilder(prefill) {
      set({ ruleDraft: prefill, automationOpen: true, automationTab: 'rules', editRuleId: 'new' })
    }
  }) satisfies Partial<State>
