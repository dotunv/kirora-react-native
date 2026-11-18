package io.kirora.reactnative

// UNVERIFIED: these tests were written without being compiled or run. The Android module has no
// standalone Gradle build (react-android comes from a host app), and the build environment that
// wrote them had no host project. Run them from a host app build before relying on them, and fix
// any API drift (ReactApplicationContext, JavaOnlyMap, Promise) the first run shows.

import androidx.test.core.app.ApplicationProvider
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.ArgumentCaptor
import org.mockito.Mockito.any
import org.mockito.Mockito.anyString
import org.mockito.Mockito.mock
import org.mockito.Mockito.never
import org.mockito.Mockito.timeout
import org.mockito.Mockito.verify
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The bridge module's own behaviour: what JavaScript hears when Kirora is, or is not, set up. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class KiroraSdkModuleTest {
    private lateinit var module: KiroraSdkModule

    @Before
    fun setUp() {
        val context = ReactApplicationContext(ApplicationProvider.getApplicationContext())
        module = KiroraSdkModule(context)
    }

    @After
    fun tearDown() {
        module.destroy()
    }

    private fun options(): ReadableMap = JavaOnlyMap.of(
        "clientKey", "kirora_pk_test",
        "hasTokenProvider", false,
        "push", false,
        "requireTrackingConsent", false,
        "trackSessions", false,
        "trackAppLifecycle", false,
        "logLevel", "none"
    )

    private fun configured() {
        val promise = mock(Promise::class.java)
        module.configure(options(), promise)
        verify(promise).resolve(null)
    }

    private fun rejectedCode(call: (Promise) -> Unit): String {
        val promise = mock(Promise::class.java)
        call(promise)
        val code = ArgumentCaptor.forClass(String::class.java)
        verify(promise, timeout(5_000)).reject(code.capture(), anyString())
        return code.value
    }

    @Test
    fun theModuleIsNamedAsJavaScriptLooksItUp() {
        assertEquals("KiroraSdk", module.name)
    }

    @Test
    fun callsThatNeedAClientRejectWithNotConfiguredBeforeSetUp() {
        assertEquals("NOT_CONFIGURED", rejectedCode { module.identify("token", it) })
        assertEquals("NOT_CONFIGURED", rejectedCode { module.logout(it) })
        assertEquals("NOT_CONFIGURED", rejectedCode { module.flush(it) })
        assertEquals("NOT_CONFIGURED", rejectedCode { module.setPushConsent(true, it) })
        assertEquals("NOT_CONFIGURED", rejectedCode { module.getPushStatus(it) })
        assertEquals("NOT_CONFIGURED", rejectedCode { module.setPushEnabled(true, it) })
        assertEquals("NOT_CONFIGURED", rejectedCode { module.requestPushPermission(it) })
    }

    @Test
    fun getStateResolvesNullWithNoClientForJavaScriptToTurnIntoTheEmptyState() {
        val promise = mock(Promise::class.java)
        module.getState(promise)
        verify(promise).resolve(null)
    }

    @Test
    fun fireAndForgetCallsWithNoClientNeitherThrowNorReject() {
        module.track("opened", """{"a":1}""")
        module.trackScreenView("Home")
        module.setTrackingConsent(false)
        module.onNewPushToken("fcm-1")
        module.setNotificationEvents(true, true)
    }

    @Test
    fun aTrackWithPropertiesThatAreNotJsonStillGoesWithoutThem() {
        configured()
        module.track("opened", "not json")
    }

    @Test
    fun configureWithAClientKeyResolves() {
        configured()
    }

    @Test
    fun getStateAfterConfigureResolvesTheSdksSnapshot() {
        configured()
        val promise = mock(Promise::class.java)
        module.getState(promise)
        val state = ArgumentCaptor.forClass(Any::class.java)
        verify(promise, timeout(10_000)).resolve(state.capture())
        val map = state.value as WritableMap
        assertEquals(true, map.getBoolean("isInitialized"))
        assertNotNull(map.getString("deviceId"))
        assertEquals(0, map.getInt("queuedEventCount"))
    }

    @Test
    fun aConfigureThatFailsRejectsAndLeavesNoClientForTheCallsAfterIt() {
        configured()
        val broken = mock(Promise::class.java)
        module.configure(JavaOnlyMap(), broken) // required keys missing
        verify(broken).reject(anyString(), any(String::class.java), any(Throwable::class.java))
        assertEquals("NOT_CONFIGURED", rejectedCode { module.logout(it) })
    }

    @Test
    fun destroyStopsTheClient() {
        configured()
        module.destroy()
        assertEquals("NOT_CONFIGURED", rejectedCode { module.flush(it) })
    }

    @Test
    fun destroyWithNothingConfiguredIsHarmless() {
        module.destroy()
        module.destroy()
    }

    @Test
    fun reconfiguringReplacesTheClient() {
        configured()
        configured()
        val promise = mock(Promise::class.java)
        module.getState(promise)
        verify(promise, timeout(10_000)).resolve(any())
    }

    @Test
    fun answersForRequestsNoOneAskedAreIgnored() {
        module.resolveToken("no-such-request", "token", null)
        module.resolveToken("no-such-request", null, "failed")
        module.resolveAnswer("no-such-request", true)
    }

    @Test
    fun theEmitterHousekeepingCallsAreNoOps() {
        module.addListener("KiroraTokenRequest")
        module.removeListeners(1.0)
    }

    @Test
    fun invalidateEndsTheClientAndNothingReachesItAfterwards() {
        configured()
        module.invalidate()
        val promise = mock(Promise::class.java)
        module.flush(promise)
        verify(promise).reject(eq("NOT_CONFIGURED"), anyString())
        verify(promise, never()).resolve(any())
    }

    private fun <T> eq(value: T): T = org.mockito.ArgumentMatchers.eq(value)
}
