import Foundation
import Tauri
import UIKit
import UserNotifications

// All policy, UIKit identifiers, observer callbacks and Tauri events stay on main.
final class MobileBackgroundController {
    private weak var plugin: Plugin?
    private var policy: MobileFiniteWindow
    private var identifiers: [UInt64: UIBackgroundTaskIdentifier] = [:]
    private var observers: [NSObjectProtocol] = []

    init(plugin: Plugin) {
        precondition(Thread.isMainThread)
        self.plugin = plugin
        policy = MobileFiniteWindow(foreground: Self.isForeground())
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willEnterForegroundNotification,
                     UIApplication.didBecomeActiveNotification, UIScene.didActivateNotification,
                     UIScene.willEnterForegroundNotification, UIScene.didEnterBackgroundNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.refreshLifecycle()
            })
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        let pending = Array(identifiers.values)
        if Thread.isMainThread {
            for identifier in pending { UIApplication.shared.endBackgroundTask(identifier) }
        } else {
            DispatchQueue.main.async {
                for identifier in pending { UIApplication.shared.endBackgroundTask(identifier) }
            }
        }
    }

    private static func isForeground() -> Bool {
        UIApplication.shared.applicationState != .background || UIApplication.shared.connectedScenes.contains {
            $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive
        }
    }

    private func refreshLifecycle() {
        precondition(Thread.isMainThread)
        let foreground = Self.isForeground()
        let changed = policy.foreground != foreground
        perform(policy.setForeground(foreground))
        if changed { plugin?.trigger("background-state", data: [:]) }
    }

    private func perform(_ effects: [MobileFiniteWindow.Effect]) {
        precondition(Thread.isMainThread)
        for effect in effects {
            switch effect {
            case .begin(let epoch):
                let identifier = UIApplication.shared.beginBackgroundTask(withName: "Agentero finite sync") { [weak self] in
                    // UIKit invokes expiration synchronously on main; end before returning.
                    guard let self = self else { return }
                    self.perform(self.policy.expire(epoch))
                }
                if identifier == .invalid {
                    perform(policy.expire(epoch))
                } else if policy.activeEpoch == epoch {
                    identifiers[epoch] = identifier
                } else {
                    UIApplication.shared.endBackgroundTask(identifier)
                }
            case .end(let epoch):
                if let identifier = identifiers.removeValue(forKey: epoch) {
                    UIApplication.shared.endBackgroundTask(identifier)
                }
            case .expired:
                // This channel is registered by Rust, not by a WebView listener.
                plugin?.trigger("background-expired", data: [:])
                plugin?.trigger("background-state", data: [:])
            }
        }
    }

    func readState(_ invoke: Invoke, refresh: Bool = true) {
        precondition(Thread.isMainThread)
        if refresh { refreshLifecycle() }
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            DispatchQueue.main.async {
                guard let self = self else { invoke.reject("Background adapter unavailable", code: "background_unavailable"); return }
                let permission: String
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral: permission = "granted"
                case .denied: permission = "denied"
                case .notDetermined: permission = "prompt"
                @unknown default: permission = "denied"
                }
                invoke.resolve(MobileBackgroundState(
                    foreground: Self.isForeground(), notificationPermission: permission,
                    notificationsEnabled: permission == "granted" && (settings.alertSetting == .enabled || settings.notificationCenterSetting == .enabled),
                    finiteTaskActive: self.policy.activeEpoch != nil && !self.identifiers.isEmpty,
                    finiteTaskExpired: self.policy.expired
                ))
            }
        }
    }

    func configure(_ invoke: Invoke, enabled: Bool) {
        precondition(Thread.isMainThread)
        guard !enabled else {
            invoke.reject("iOS does not support persistent background connections", code: "background_unsupported")
            return
        }
        // Disabling a persistent feature must not cancel separate finite file work.
        readState(invoke)
    }

    func apply(_ invoke: Invoke, args: MobileBackgroundApplyArgs) {
        precondition(Thread.isMainThread)
        guard let generation = MobileFiniteWindow.generation(args.generation) else {
            invoke.reject("Invalid background generation", code: "background_invalid")
            return
        }
        guard generation > policy.lastGeneration else {
            readState(invoke, refresh: false)
            return
        }
        refreshLifecycle()
        // Old native completions cannot drain or replace a newer finite window.
        // Agent counts never allocate a UIKit window or a persistent lease.
        perform(policy.apply(generation: generation, syncCount: args.syncCount, transferCount: args.transferCount))
        readState(invoke)
    }

    func requestNotifications(_ invoke: Invoke) {
        precondition(Thread.isMainThread)
        guard Self.isForeground() else {
            invoke.reject("Notification permission requires a foreground action", code: "background_foreground_required")
            return
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] _, error in
            DispatchQueue.main.async {
                guard let self = self else { invoke.reject("Background adapter unavailable", code: "background_unavailable"); return }
                if error != nil { invoke.reject("Notification permission unavailable", code: "background_unavailable") }
                else { self.readState(invoke) }
            }
        }
    }

    func openSettings(_ invoke: Invoke, target: String) {
        precondition(Thread.isMainThread)
        guard Self.isForeground() else {
            invoke.reject("Settings require a foreground action", code: "background_foreground_required")
            return
        }
        let address: String
        switch target {
        case "app": address = UIApplication.openSettingsURLString
        case "notifications": address = UIApplication.openNotificationSettingsURLString
        case "battery":
            invoke.reject("iOS has no battery optimization exemption", code: "background_unsupported")
            return
        default:
            invoke.reject("Invalid settings target", code: "background_invalid")
            return
        }
        guard let url = URL(string: address) else { invoke.reject("Settings unavailable", code: "background_unavailable"); return }
        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            DispatchQueue.main.async {
                guard let self = self else { invoke.reject("Background adapter unavailable", code: "background_unavailable"); return }
                if opened { self.readState(invoke) }
                else { invoke.reject("Settings unavailable", code: "background_unavailable") }
            }
        }
    }
}
