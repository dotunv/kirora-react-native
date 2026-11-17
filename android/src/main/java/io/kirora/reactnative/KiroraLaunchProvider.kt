package io.kirora.reactnative

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import com.kirora.androidsdk.Kirora
import com.kirora.androidsdk.KiroraInternalApi

/**
 * Tells the Kirora Android SDK at app launch, before the tap's activity and before JavaScript runs,
 * that a wrapper will set up Kirora later: the link of a push tap that launched the app then waits
 * (10 s at most) for [KiroraSdkModule.configure]'s `setWrapperCallbacks`, instead of opening before
 * React Native can hear it. Providers run before `Application.onCreate`, on the main thread: the
 * SDK reads the app's install time and saves it in its preferences, so later launches are covered
 * even if this runs late.
 */
@OptIn(KiroraInternalApi::class)
class KiroraLaunchProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        context?.let { Kirora.installPushIntegration(it) }
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
