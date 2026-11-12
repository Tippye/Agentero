import Foundation

@main
struct MobileFiniteWindowTests {
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }

    static func apply(_ policy: inout MobileFiniteWindow, syncCount: UInt32, transferCount: UInt32) -> [MobileFiniteWindow.Effect] {
        policy.apply(generation: policy.lastGeneration + 1, syncCount: syncCount, transferCount: transferCount)
    }

    static func main() {
        var overlap = MobileFiniteWindow(foreground: true)
        check(apply(&overlap, syncCount: 1, transferCount: 0) == [.begin(1)], "start one finite window")
        check(apply(&overlap, syncCount: 2, transferCount: 3).isEmpty, "overlap must not allocate another budget")
        check(apply(&overlap, syncCount: 0, transferCount: 1).isEmpty, "transfer keeps shared budget")
        check(apply(&overlap, syncCount: 0, transferCount: 0) == [.end(1)], "last worker releases once")
        check(apply(&overlap, syncCount: 0, transferCount: 0).isEmpty, "repeated cancellation cannot release twice")

        var expiry = MobileFiniteWindow(foreground: true)
        _ = apply(&expiry, syncCount: 1, transferCount: 0)
        check(expiry.expire(1) == [.end(1), .expired], "expiration ends and notifies")
        check(expiry.expired && expiry.activeEpoch == nil, "expired is visible without a fake active token")
        check(expiry.expire(1).isEmpty, "repeated expiry does not notify twice")
        check(apply(&expiry, syncCount: 2, transferCount: 1).isEmpty, "remaining work cannot renew an expired budget")
        _ = apply(&expiry, syncCount: 0, transferCount: 0)
        check(!expiry.expired, "draining work clears old expiry")
        check(apply(&expiry, syncCount: 1, transferCount: 0) == [.begin(2)], "new foreground work gets a new epoch")
        check(expiry.expire(1).isEmpty && expiry.activeEpoch == 2, "stale callback cannot end a new window")

        var cancelled = MobileFiniteWindow(foreground: true)
        _ = apply(&cancelled, syncCount: 1, transferCount: 0)
        check(cancelled.cancel() == [.end(1)], "teardown releases active window")
        check(cancelled.expire(1).isEmpty && !cancelled.expired, "late expiry after cancellation is ignored")
        check(cancelled.cancel().isEmpty, "teardown is idempotent")

        var background = MobileFiniteWindow(foreground: false)
        check(apply(&background, syncCount: 1, transferCount: 1).isEmpty, "work cannot start a finite window in background")
        check(background.setForeground(true).isEmpty, "foreground return does not implicitly begin a new budget")
        check(apply(&background, syncCount: 1, transferCount: 1).isEmpty, "unchanged aggregate cannot gain a new budget")
        _ = apply(&background, syncCount: 0, transferCount: 0)
        check(apply(&background, syncCount: 1, transferCount: 0) == [.begin(1)], "new foreground operation is admitted")
        check(background.setForeground(false).isEmpty, "going background retains finite work")
        check(background.setForeground(true).isEmpty && background.activeEpoch == 1, "foreground return retains the same valid window until work finishes")
        check(apply(&background, syncCount: 1, transferCount: 0).isEmpty && background.activeEpoch == 1, "new generation with ongoing work does not renew the window")
        check(background.setForeground(false).isEmpty && background.activeEpoch == 1, "second background transition keeps the original finite budget")
        check(background.setForeground(true).isEmpty && background.activeEpoch == 1, "second foreground transition does not release or replace ongoing work")
        check(background.setForeground(false).isEmpty && background.activeEpoch == 1, "third background transition still uses one begin")
        check(apply(&background, syncCount: 0, transferCount: 0) == [.end(1)], "actual completion ends the held window exactly once")
        check(background.expire(1).isEmpty && apply(&background, syncCount: 0, transferCount: 0).isEmpty, "late expiry and repeated completion cannot double-release")
        _ = background.setForeground(true)
        check(apply(&background, syncCount: 1, transferCount: 0) == [.begin(2)], "only new foreground work after completion begins a new epoch")
        check(background.expire(1).isEmpty && background.activeEpoch == 2, "late expiry from previous visibility cycle cannot end new work")
        _ = background.setForeground(false)
        _ = background.setForeground(true)
        _ = background.setForeground(false)
        check(background.expire(2) == [.end(2), .expired], "system expiry still ends ongoing work after repeated visibility transitions")

        var agentOnly = MobileFiniteWindow(foreground: true)
        // Agent counts deliberately never enter the policy; only these two
        // finite-work counts are accepted by its public input.
        check(apply(&agentOnly, syncCount: 0, transferCount: 0).isEmpty && agentOnly.activeEpoch == nil, "Agent activity cannot acquire a finite lease")
        check(apply(&agentOnly, syncCount: UInt32.max, transferCount: UInt32.max) == [.begin(1)], "large aggregate uses boolean overlap without overflow")
        var ordered = MobileFiniteWindow(foreground: true)
        check(ordered.apply(generation: 0, syncCount: 1, transferCount: 0).isEmpty, "generation zero is never accepted")
        check(ordered.apply(generation: 10, syncCount: 1, transferCount: 0) == [.begin(1)], "new Rust generation starts work")
        check(ordered.apply(generation: 9, syncCount: 0, transferCount: 0).isEmpty && ordered.activeEpoch == 1, "late cancellation cannot end newer work")
        check(ordered.apply(generation: 10, syncCount: 0, transferCount: 0).isEmpty && ordered.activeEpoch == 1, "duplicate generation cannot mutate counts")
        check(ordered.apply(generation: 11, syncCount: 0, transferCount: 0) == [.end(1)], "new cancellation ends once")
        check(ordered.apply(generation: 10, syncCount: 1, transferCount: 0).isEmpty && ordered.activeEpoch == nil, "late begin cannot resurrect released work")
        check(ordered.apply(generation: 12, syncCount: 1, transferCount: 0) == [.begin(2)], "new admitted work has fresh epoch")
        _ = ordered.expire(2)
        _ = ordered.cancel()
        _ = ordered.setForeground(false)
        _ = ordered.setForeground(true)
        check(ordered.lastGeneration == 12, "expiry, cancellation and lifecycle do not reset generation")
        check(ordered.apply(generation: 11, syncCount: 1, transferCount: 0).isEmpty, "old apply remains stale after lifecycle")
        for raw in ["", "0", "01", "+1", "-1", " 1", "1 ", "1.0", "18446744073709551616"] {
            check(MobileFiniteWindow.generation(raw) == nil, "reject noncanonical or overflowing generation: \(raw)")
        }
        check(MobileFiniteWindow.generation("1") == 1, "first canonical generation")
        check(MobileFiniteWindow.generation("9007199254740993") == 9007199254740993, "no JavaScript number rounding")
        check(MobileFiniteWindow.generation("18446744073709551615") == UInt64.max, "exact UInt64 upper bound")
        let state = MobileBackgroundState(foreground: true, notificationPermission: "prompt", notificationsEnabled: false, finiteTaskActive: false, finiteTaskExpired: true)
        let encoded = try! JSONEncoder().encode(state)
        let payload = try! JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        check(payload.count == 13, "BackgroundState must include exactly the shared native fields")
        check(payload["batteryOptimizationIgnored"] is NSNull, "explicit null battery status must not disappear")
        check(payload["finiteTasks"] as? Bool == true, "real finite adapter advertises finite work")
        for flag in ["persistentConnection", "backgroundTransfer", "enabled", "agentActive", "syncActive"] {
            check(payload[flag] as? Bool == false, "unsupported capability remains false: \(flag)")
        }
        check(payload["platform"] as? String == "ios", "platform matches Rust lowercase enum")
        let decoder = JSONDecoder()
        let counts = try! decoder.decode(MobileBackgroundApplyArgs.self, from: Data("{\"generation\":\"9007199254740993\",\"agentCount\":4294967295,\"syncCount\":1,\"transferCount\":0}".utf8))
        check(counts.generation == "9007199254740993" && counts.agentCount == UInt32.max, "native bridge preserves exact decimal generation and bounded counts")
        for json in ["{\"generation\":1,\"agentCount\":0,\"syncCount\":1,\"transferCount\":0}", "{\"generation\":\"1\",\"agentCount\":0,\"syncCount\":4294967296,\"transferCount\":0}", "{\"generation\":\"1\",\"agentCount\":0,\"syncCount\":-1,\"transferCount\":0}"] {
            check((try? decoder.decode(MobileBackgroundApplyArgs.self, from: Data(json.utf8))) == nil, "reject numeric generation and invalid native counts")
        }
        print("PASS: finite-window policy, stale generations and native JSON capability/count contract")
    }
}
