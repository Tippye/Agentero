import Foundation

private struct ObservedPath: Equatable {
    let available: Bool
    let interface: String
    let identity: String
    let routeRevision: Int
}

@main
struct ConnectivityPolicyTests {
    private static var checks = 0
    private static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        checks += 1
        guard condition() else { fatalError(message) }
    }

    static func main() {
        // Synthetic Equatable paths exercise the policy without starting any OS monitor.
        let wifiA = ObservedPath(available: true, interface: "wifi", identity: "A", routeRevision: 1)
        let wifiB = ObservedPath(available: true, interface: "wifi", identity: "B", routeRevision: 1)
        let wifiBRoute = ObservedPath(available: true, interface: "wifi", identity: "B", routeRevision: 2)
        let offline = ObservedPath(available: false, interface: "none", identity: "none", routeRevision: 0)
        var policy = ConnectivityPolicy<ObservedPath>()
        check(policy.hint == ConnectivityHint(generation: "0"), "initial hint has no observed change")
        check(!policy.running && policy.epoch == 0, "construction does not start monitoring")
        check(policy.observe(wifiA, epoch: 0) == nil && policy.generation == 0, "callbacks before start are ignored")
        let first = policy.start()!
        check(first == 1 && policy.running, "one owner starts one monitor epoch")
        check(policy.start() == first, "repeated plugin attachment does not replace the active monitor")
        check(policy.observe(wifiA, epoch: first) == nil, "first real path only establishes a baseline")
        check(policy.hint.generation == "0", "no synthetic unsatisfied-to-satisfied event")
        check(policy.observe(wifiA, epoch: first) == nil, "identical path callbacks are deduplicated")
        check(policy.observe(wifiB, epoch: first) == 1, "Wi-Fi identity can change while interface and availability stay the same")
        check(policy.observe(wifiBRoute, epoch: first) == 2, "full-path route changes are not reduced to an availability flag")
        check(policy.observe(offline, epoch: first) == 3, "loss is a hint, not a transport gate")
        check(policy.observe(offline, epoch: first) == nil && policy.generation == 3, "duplicate loss does not create another hint")
        check(policy.observe(wifiA, epoch: first) == 4, "a later route change increments exactly once")
        check(policy.permitsDelivery(epoch: first, generation: 4), "current main-queue publication is admitted")
        check(!policy.permitsDelivery(epoch: first, generation: 3), "a queued older main-queue publication is superseded")
        for _ in 0..<10 {
            check(policy.start() == first && policy.hint.generation == "4", "read/reattach keeps monitor and cached process generation")
        }

        policy.stop()
        check(!policy.running && policy.hint.generation == "4", "owner teardown retains the counter")
        check(!policy.permitsDelivery(epoch: first, generation: 4), "teardown fences already queued Main work")
        check(policy.observe(offline, epoch: first) == nil, "cancelled monitor cannot publish a late callback")
        policy.stop()
        check(policy.hint.generation == "4", "teardown is idempotent")
        let second = policy.start()!
        check(second == first + 1, "restart uses a fresh monitor callback epoch")
        check(!policy.permitsDelivery(epoch: first, generation: 4), "old Main work stays stale after restart")
        check(policy.observe(wifiB, epoch: first) == nil, "a late old-monitor callback cannot overwrite the retained baseline")
        check(policy.observe(wifiA, epoch: second) == nil, "an unchanged real path after restart does not fabricate a change")
        check(policy.observe(wifiB, epoch: second) == 5, "new monitor continues the process generation")
        check(!policy.permitsDelivery(epoch: first, generation: 5), "matching generation cannot bypass the epoch fence")
        check(policy.permitsDelivery(epoch: second, generation: 5), "fresh epoch/current generation can publish")

        var coalesced = ConnectivityPolicy<ObservedPath>()
        let epoch = coalesced.start()!
        _ = coalesced.observe(wifiA, epoch: epoch)
        let queuedOld = coalesced.observe(wifiB, epoch: epoch)!
        let queuedNew = coalesced.observe(wifiBRoute, epoch: epoch)!
        check(!coalesced.permitsDelivery(epoch: epoch, generation: queuedOld), "faster callback supersedes an older queued Main emission")
        check(coalesced.permitsDelivery(epoch: epoch, generation: queuedNew), "only the latest copied hint is delivered")
        check(coalesced.hint.generation == String(queuedNew), "RPC snapshot reads the latest counter rather than a captured old reply")

        let maximum = UInt64(Int64.max)
        var capped = ConnectivityPolicy<ObservedPath>(generation: maximum - 1)
        let cappedEpoch = capped.start()!
        _ = capped.observe(wifiA, epoch: cappedEpoch)
        check(capped.observe(wifiB, epoch: cappedEpoch) == maximum, "last signed-safe increment is exact")
        check(capped.observe(offline, epoch: cappedEpoch) == nil && capped.generation == maximum, "counter saturates without wrap or a duplicate generation event")
        check(capped.observe(wifiA, epoch: cappedEpoch) == nil, "later changes cannot restart the exhausted counter")
        check(capped.hint.generation == "9223372036854775807", "upper wire bound is canonical decimal")
        check(ConnectivityPolicy<ObservedPath>(generation: UInt64.max).generation == maximum, "an oversized seed cannot escape the signed-safe wire range")
        let precise = ConnectivityPolicy<ObservedPath>(generation: 9_007_199_254_740_993)
        check(precise.hint.generation == "9007199254740993", "decimal encoding does not round through a JavaScript number")

        for hint in [ConnectivityHint(generation: "0"), precise.hint, capped.hint] {
            let encoded = try! JSONEncoder().encode(hint)
            let payload = try! JSONSerialization.jsonObject(with: encoded) as! [String: Any]
            check(payload.count == 1, "wire payload contains only the generation")
            check(payload["generation"] as? String == hint.generation, "wire generation is a string, never a JSON number")
            for field in ["available", "status", "host", "ssid", "ip", "interfaces"] {
                check(payload[field] == nil, "wire must not claim availability/reachability or export path details")
            }
        }
        print("PASS: \(checks) connectivity policy assertions (baseline, path equality, process epochs, stale delivery, saturation, private JSON)")
    }
}
