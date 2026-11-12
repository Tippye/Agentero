import Foundation

struct StylusTargetPolicy {
    private(set) var generation: UInt64 = 0
    private(set) var token: String?
    private(set) var window: String?

    static func parseGeneration(_ raw: String) -> UInt64? {
        guard let value = UInt64(raw), value > 0, String(value) == raw else { return nil }
        return value
    }
    mutating func apply(generation next: UInt64, token: String, window: String, active: Bool) -> Bool {
        guard next > generation else { return false }
        generation = next
        if active { self.token = token; self.window = window }
        else if self.token == token && self.window == window { self.token = nil; self.window = nil }
        return true
    }
    static func tapAction(_ preference: String) -> String? {
        switch preference {
        case "switchEraser": return "toggleEraser"
        case "switchPrevious": return "previousTool"
        case "showColorPalette": return "showColorPalette"
        default: return nil
        }
    }
}

#if STYLUS_POLICY_TESTS
@main
struct StylusPolicyChecks {
    static func main() {
        var policy = StylusTargetPolicy()
        precondition(policy.apply(generation: 1, token: "a", window: "main", active: true))
        precondition(policy.apply(generation: 2, token: "b", window: "doc", active: true))
        precondition(!policy.apply(generation: 1, token: "a", window: "main", active: false) && policy.token == "b")
        precondition(policy.apply(generation: 3, token: "a", window: "main", active: false) && policy.token == "b")
        precondition(policy.apply(generation: 4, token: "b", window: "doc", active: false) && policy.token == nil)
        precondition(!policy.apply(generation: 2, token: "b", window: "doc", active: true))
        for raw in ["0", "01", "+1", "-1", " 1", "18446744073709551616"] { precondition(StylusTargetPolicy.parseGeneration(raw) == nil) }
        precondition(StylusTargetPolicy.parseGeneration("9007199254740993") == 9007199254740993)
        precondition(StylusTargetPolicy.tapAction("switchEraser") == "toggleEraser")
        precondition(StylusTargetPolicy.tapAction("switchPrevious") == "previousTool")
        precondition(StylusTargetPolicy.tapAction("showColorPalette") == "showColorPalette")
        precondition(StylusTargetPolicy.tapAction("ignore") == nil && StylusTargetPolicy.tapAction("futureAction") == nil)
        print("PASS: stylus target generations, stale cleanup, window token routing and preferred tap actions")
    }
}
#endif
