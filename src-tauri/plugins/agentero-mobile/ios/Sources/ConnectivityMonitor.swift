import Foundation
import Network
import Tauri

private final class ConnectivityPluginRelay {
    weak var plugin: Plugin?
    init(_ plugin: Plugin) { self.plugin = plugin }
}

/// Retained for the process, independently of any Scene, WebView or finite background lease.
/// NWPathMonitor does not extend execution while iOS suspends the app.
final class ConnectivityMonitor {
    static let shared = ConnectivityMonitor()

    private let queue = DispatchQueue(label: "agentero.mobile.connectivity")
    // These fields are confined to queue; no transport or UI work runs there.
    private var monitor: NWPathMonitor?
    private var policy = ConnectivityPolicy<NWPath>()
    // Weak relays are confined to Main, including Plugin.trigger calls.
    private var relays: [ObjectIdentifier: ConnectivityPluginRelay] = [:]

    private init() {}

    /// Rust registers its event channel before requesting this snapshot.
    func readState(plugin: Plugin, completion: @escaping (ConnectivityHint) -> Void) {
        precondition(Thread.isMainThread)
        relays = relays.filter { $0.value.plugin != nil }
        let key = ObjectIdentifier(plugin)
        if relays[key] == nil { relays[key] = ConnectivityPluginRelay(plugin) }
        queue.async { [weak self] in
            guard let self = self else { return }
            self.startIfNeeded()
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                // Read at reply time so an update queued before this Main hop cannot regress it.
                let hint = self.queue.sync { self.policy.hint }
                completion(hint)
            }
        }
    }

    private func startIfNeeded() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard monitor == nil, let epoch = policy.start() else { return }
        // A cancelled NWPathMonitor cannot restart; allocate a fresh one for each owner epoch.
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            self.observe(path, epoch: epoch)
        }
        monitor.start(queue: queue)
        // Do not read currentPath: it is not an observation before the first callback.
    }

    private func observe(_ path: NWPath, epoch: UInt64) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let generation = policy.observe(path, epoch: epoch) else { return }
        let hint = policy.hint
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let current = self.queue.sync {
                self.policy.permitsDelivery(epoch: epoch, generation: generation)
            }
            guard current else { return }
            self.relays = self.relays.filter { $0.value.plugin != nil }
            for relay in self.relays.values {
                try? relay.plugin?.trigger("connectivity-changed", data: hint)
            }
        }
    }

    /// Process owner teardown, never called by Plugin/Scene destruction or background expiry.
    func shutdown() {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.policy.stop()
            self.monitor?.pathUpdateHandler = nil
            self.monitor?.cancel()
            self.monitor = nil
        }
    }
}
