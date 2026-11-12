package app.agentero.mobile

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/** The shared branch advertises no unimplemented native background ability. */
@TauriPlugin
class AgenteroMobilePlugin(activity: Activity) : Plugin(activity) {
    private fun state(): JSObject = JSObject().apply {
        put("platform", "android")
        put("persistentConnection", false); put("finiteTasks", false)
        put("backgroundTransfer", false); put("enabled", false)
        put("foreground", true); put("notificationPermission", "denied")
        put("notificationsEnabled", false); put("batteryOptimizationIgnored", null)
        put("agentActive", false); put("syncActive", false)
        put("finiteTaskActive", false); put("finiteTaskExpired", false)
    }
    @Command fun stylusState(invoke: Invoke) { invoke.resolve(JSObject().apply {
        put("adapters", org.json.JSONArray()); put("presence", org.json.JSONArray())
    }) }
    @Command fun stylusSetTarget(invoke: Invoke) { stylusState(invoke) }
    @Command fun readState(invoke: Invoke) { invoke.resolve(state()) }
    @Command fun configure(invoke: Invoke) { invoke.reject("Android background adapter is unavailable") }
    @Command fun requestNotifications(invoke: Invoke) { invoke.reject("Android background adapter is unavailable") }
    @Command fun openSettings(invoke: Invoke) { invoke.reject("Android background adapter is unavailable") }
    @Command fun apply(invoke: Invoke) { invoke.reject("Android background adapter is unavailable") }
}
