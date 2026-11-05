package com.kodviva.geckomail

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class MemoryLockPrefs : LockPrefs {
    override var config = LockConfig(false, 0)
}

private class FakeAuth(var answer: Boolean = false) : Authenticating {
    var prompts = 0
    override fun available() = true
    override suspend fun prompt(reason: String): Boolean {
        prompts++
        return answer
    }
}

class LockGateTest {
    private var now = 1_000L
    private val prefs = MemoryLockPrefs()
    private fun gate() = LockGate(prefs) { now }

    @Test fun coldStartLockedWhenEnabled() {
        gate().apply(LockConfig(true, 60_000))
        assertTrue(gate().isLocked())
    }

    @Test fun coldStartOpenWhenDisabled() = assertFalse(gate().isLocked())

    @Test fun signOutWhileLockedTurnsLockOff() {
        val g = gate()
        g.apply(LockConfig(true, 60_000))
        assertTrue(gate().isLocked())
        val locked = gate()
        locked.signedOut()
        assertFalse(locked.isLocked())
        assertFalse(locked.config.enabled)
        assertEquals(60_000, prefs.config.timeoutMs)
        assertFalse(gate().isLocked()) // yeniden açılışta da kilit yok
    }

    @Test fun signOutWhileUnlockedKeepsSetting() {
        val g = gate()
        g.apply(LockConfig(true, 60_000))
        g.signedOut()
        assertTrue(g.config.enabled)
        assertTrue(prefs.config.enabled)
    }

    @Test fun timeoutBoundary() {
        val g = gate()
        g.apply(LockConfig(true, 60_000))
        g.didEnterBackground()
        now += 59_999
        assertFalse(g.isLocked())
        now += 1
        assertTrue(g.isLocked())
    }

    @Test fun clockBackwardsLocks() {
        val g = gate()
        g.apply(LockConfig(true, 900_000))
        g.didEnterBackground()
        now -= 1
        assertTrue(g.isLocked())
    }

    @Test fun foregroundKeepsLockUntilUnlocked() {
        val g = gate()
        g.apply(LockConfig(true, 0))
        g.didEnterBackground()
        g.didBecomeForeground()
        assertTrue(g.isLocked())
        g.unlocked()
        assertFalse(g.isLocked())
    }

    @Test fun promptIsNotBackground() {
        val g = gate()
        g.apply(LockConfig(true, 0))
        g.beginPrompt()
        g.didEnterBackground()
        g.endPrompt()
        assertFalse(g.isLocked())
    }

    @Test fun weakening() {
        val g = gate()
        g.apply(LockConfig(true, 60_000))
        assertTrue(g.weakens(LockConfig(false, 60_000)))
        assertTrue(g.weakens(LockConfig(true, 300_000)))
        assertFalse(g.weakens(LockConfig(true, 0)))
        assertFalse(g.weakens(LockConfig(true, 60_000)))
        g.apply(LockConfig(false, 0))
        assertFalse(g.weakens(LockConfig(true, 900_000)))
    }

    @Test fun weakeningRefusedWithoutAuthentication() = runTest {
        val g = gate()
        g.apply(LockConfig(true, 60_000))
        val auth = FakeAuth(false)
        assertFalse(setLock(LockConfig(false, 0), g, auth, "r"))
        assertEquals(1, auth.prompts)
        assertTrue(g.config.enabled)
    }

    @Test fun weakeningAppliesAfterAuthentication() = runTest {
        val g = gate()
        g.apply(LockConfig(true, 60_000))
        assertTrue(setLock(LockConfig(true, 900_000), g, FakeAuth(true), "r"))
        assertEquals(900_000, g.config.timeoutMs)
    }

    @Test fun strengtheningNeedsNoPrompt() = runTest {
        val g = gate()
        g.apply(LockConfig(true, 60_000))
        val auth = FakeAuth()
        assertTrue(setLock(LockConfig(true, 0), g, auth, "r"))
        assertEquals(0, auth.prompts)
    }

    @Test fun unknownTimeoutRefused() = runTest {
        assertFalse(setLock(LockConfig(true, 1), gate(), FakeAuth(true), "r"))
    }
}
