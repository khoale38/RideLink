package com.ridelink

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class IntercomServiceModule(reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "IntercomService"

  @ReactMethod
  fun start(groupName: String, promise: Promise) {
    try {
      val ctx = reactApplicationContext
      val intent = Intent(ctx, IntercomService::class.java).apply {
        putExtra(IntercomService.EXTRA_GROUP_NAME, groupName)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(intent)
      } else {
        ctx.startService(intent)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("intercom_service_start_failed", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val ctx = reactApplicationContext
      ctx.stopService(Intent(ctx, IntercomService::class.java))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("intercom_service_stop_failed", e)
    }
  }
}
