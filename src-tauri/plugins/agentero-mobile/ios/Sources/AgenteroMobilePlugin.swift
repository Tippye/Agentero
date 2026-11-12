import Tauri
import WebKit

/** Platform branches replace this fail-closed bridge with their native adapter. */
class AgenteroMobilePlugin: Plugin {
    @objc func stylusState(_ invoke: Invoke) {
        invoke.resolve(["adapters": [String](), "presence": [String]()])
    }
    @objc func stylusSetTarget(_ invoke: Invoke) {
        invoke.resolve(["adapters": [String](), "presence": [String]()])
    }
    @objc func readState(_ invoke: Invoke) {
        invoke.resolve([
            "platform": "ios", "persistentConnection": false, "finiteTasks": false,
            "backgroundTransfer": false, "enabled": false, "foreground": true,
            "notificationPermission": "denied", "notificationsEnabled": false,
            "batteryOptimizationIgnored": NSNull(), "agentActive": false,
            "syncActive": false, "finiteTaskActive": false, "finiteTaskExpired": false
        ] as JSObject)
    }
    @objc func configure(_ invoke: Invoke) { invoke.reject("iOS background adapter is unavailable") }
    @objc func requestNotifications(_ invoke: Invoke) { invoke.reject("iOS background adapter is unavailable") }
    @objc func openSettings(_ invoke: Invoke) { invoke.reject("iOS background adapter is unavailable") }
    @objc func apply(_ invoke: Invoke) { invoke.reject("iOS background adapter is unavailable") }
}

@_cdecl("init_plugin_agentero_mobile")
func initPlugin() -> Plugin { AgenteroMobilePlugin() }
