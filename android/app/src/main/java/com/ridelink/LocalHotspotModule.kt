package com.ridelink

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Wraps `WifiManager.startLocalOnlyHotspot` (API 26+).
 *
 * The OS picks the SSID and password — we cannot brand them. The hotspot is
 * local-only (no internet routing), which is exactly what RideLink wants for
 * a peer-to-peer voice intercom. The reservation must be held by this process
 * for the duration of the ride; closing it shuts the hotspot down.
 *
 * iOS has no equivalent — Personal Hotspot is exclusively user-initiated.
 */
class LocalHotspotModule(reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun getName(): String = "LocalHotspot"

  @ReactMethod
  fun start(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      promise.reject("unsupported", "LocalOnlyHotspot requires Android 8.0 (API 26)")
      return
    }
    if (reservation != null) {
      promise.reject("already_running", "Hotspot already active — call stop() first")
      return
    }
    val wifi = reactApplicationContext.applicationContext
      .getSystemService(Context.WIFI_SERVICE) as WifiManager

    try {
      wifi.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
        override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation) {
          reservation = res
          @Suppress("DEPRECATION")
          val cfg = res.wifiConfiguration
          val info = Arguments.createMap().apply {
            putString("ssid", cfg?.SSID ?: "")
            putString("password", cfg?.preSharedKey ?: "")
          }
          promise.resolve(info)
        }

        override fun onStopped() {
          reservation = null
        }

        override fun onFailed(reason: Int) {
          reservation = null
          promise.reject("hotspot_failed", "LocalOnlyHotspot failed with reason $reason")
        }
      }, mainHandler)
    } catch (e: SecurityException) {
      promise.reject("permission_denied", e)
    } catch (e: Exception) {
      promise.reject("hotspot_start_failed", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      reservation?.close()
      reservation = null
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("hotspot_stop_failed", e)
    }
  }

  override fun onCatalystInstanceDestroy() {
    try { reservation?.close() } catch (_: Exception) { /* ignore */ }
    reservation = null
    super.onCatalystInstanceDestroy()
  }
}
