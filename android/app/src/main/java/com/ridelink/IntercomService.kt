package com.ridelink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the JS runtime, mic capture, and signaling
 * sockets alive when the user's phone is locked or the app is backgrounded.
 *
 * On Android 9+ the OS aggressively throttles backgrounded apps; without a
 * foreground service with type=microphone (mandatory on Android 14+), the
 * mic gets cut after ~30s. With this service running and an ongoing
 * notification posted, the OS leaves us alone for the duration of the ride.
 */
class IntercomService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val groupName = intent?.getStringExtra(EXTRA_GROUP_NAME) ?: "Group"
    startInForeground(groupName)
    // STICKY: if the system kills us under memory pressure, restart so the
    // ride doesn't silently die. JS-side state will reattach via the module.
    return START_STICKY
  }

  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun startInForeground(groupName: String) {
    ensureChannel()
    val tapIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val contentIntent = if (tapIntent != null) {
      PendingIntent.getActivity(this, 0, tapIntent, pendingFlags)
    } else null

    val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("RideLink intercom active")
      .setContentText("Connected to $groupName")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(contentIntent)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      // Android 14+ requires the explicit microphone foreground service type
      // AND the matching FOREGROUND_SERVICE_MICROPHONE runtime permission.
      startForeground(
        NOTIF_ID,
        notif,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      )
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "RideLink intercom",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Keeps the intercom running while the screen is off."
      setShowBadge(false)
    }
    mgr.createNotificationChannel(channel)
  }

  companion object {
    const val CHANNEL_ID = "ridelink_intercom"
    const val NOTIF_ID = 1042
    const val EXTRA_GROUP_NAME = "groupName"
  }
}
