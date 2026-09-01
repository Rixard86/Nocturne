package com.nocturne.app

import androidx.health.connect.client.PermissionController
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.JSArray
import androidx.activity.result.ActivityResult
import kotlinx.coroutines.runBlocking

/**
 * Bridge to Health Connect. Read-only.
 *
 * JS methods:
 *   status()            -> { status, granted[], missing[], historyGranted }
 *   requestHealthPermissions() -> opens the Health Connect grant screen, resolves with the result
 *   probe({ days })     -> a full survey of what a wearable has written; see HealthConnectProbe
 *
 * Every method reads; nothing here writes to the user's health record.
 */
@CapacitorPlugin(name = "Health")
class HealthPlugin : Plugin() {

    // Health Connect's reads are suspend functions backed by IPC to the provider, and
    // Capacitor calls plugin methods on the main thread. A month of heart-rate records is
    // thousands of rows over a binder, which is not something to block the UI thread on.
    private fun offMainThread(call: PluginCall, work: () -> JSObject) {
        Thread {
            try {
                call.resolve(work())
            } catch (e: Exception) {
                call.reject(e.message ?: "health-connect-failed", e)
            }
        }.start()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        offMainThread(call) {
            val out = JSObject().put("status", HealthConnectProbe.statusName(context))
            if (!HealthConnectProbe.isAvailable(context)) return@offMainThread out
            val granted = runBlocking { HealthConnectProbe.grantedPermissions(context) }
            out.put("granted", JSArray(granted.toTypedArray()))
            out.put("missing", JSArray(HealthConnectProbe.READ_PERMISSIONS.minus(granted).toTypedArray()))
            out.put("historyGranted", granted.contains(HealthConnectProbe.HISTORY_PERMISSION))
            out
        }
    }

    @PluginMethod
    fun probe(call: PluginCall) {
        val days = call.getInt("days", DEFAULT_PROBE_DAYS) ?: DEFAULT_PROBE_DAYS
        offMainThread(call) { runBlocking { HealthConnectProbe.survey(context, days.toLong()) } }
    }

    /**
     * Health Connect grants permissions through its own screen, reached with an activity
     * result contract rather than the normal runtime-permission dialog. Denying twice
     * locks the request out until the user goes to Health Connect settings by hand, so
     * the UI should only call this deliberately.
     */
    @PluginMethod
    fun requestHealthPermissions(call: PluginCall) {
        if (!HealthConnectProbe.isAvailable(context)) {
            call.reject("health-connect-unavailable")
            return
        }
        try {
            val contract = PermissionController.createRequestPermissionResultContract()
            val intent = contract.createIntent(context, HealthConnectProbe.READ_PERMISSIONS)
            startActivityForResult(call, intent, "permissionResult")
        } catch (e: Exception) {
            call.reject("health-permission-request-failed", e)
        }
    }

    // The ActivityResult is deliberately ignored: Health Connect reports a cancelled screen
    // the same way whether or not anything was granted, and a user can change grants inside
    // it without ever returning a result. Asking the permission controller what is actually
    // granted is the only answer that is true afterwards.
    @ActivityCallback
    private fun permissionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        offMainThread(call) {
            val granted = runBlocking { HealthConnectProbe.grantedPermissions(context) }
            JSObject()
                .put("granted", JSArray(granted.toTypedArray()))
                .put("missing", JSArray(HealthConnectProbe.READ_PERMISSIONS.minus(granted).toTypedArray()))
                .put("historyGranted", granted.contains(HealthConnectProbe.HISTORY_PERMISSION))
        }
    }

    companion object {
        private const val DEFAULT_PROBE_DAYS = 30
    }
}
