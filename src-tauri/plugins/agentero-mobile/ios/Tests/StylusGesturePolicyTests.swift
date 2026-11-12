import Foundation

@main
struct StylusGesturePolicyChecks {
    static func main() {
        let firstView = NSObject()
        let secondView = NSObject()
        let a = StylusGestureTarget(token: "a", window: "main", view: ObjectIdentifier(firstView))
        let b = StylusGestureTarget(token: "b", window: "doc", view: ObjectIdentifier(secondView))
        var policy = StylusSqueezePolicy()

        // UIKit also delivers discrete squeezes as only an ended phase.
        precondition(policy.consume(.ended, timestamp: 1, target: a) == .emit)
        precondition(policy.consume(.ended, timestamp: 1, target: a) == .ignore)
        precondition(policy.consume(.ended, timestamp: 2, target: a) == .emit)

        precondition(policy.consume(.began, timestamp: 3, target: a) == .ignore)
        precondition(policy.consume(.changed, timestamp: 4, target: a) == .ignore)
        precondition(policy.consume(.ended, timestamp: 5, target: a) == .emit)
        precondition(policy.consume(.ended, timestamp: 5, target: a) == .ignore)

        precondition(policy.consume(.began, timestamp: 6, target: a) == .ignore)
        precondition(policy.consume(.ended, timestamp: 7, target: b) == .renewInteraction)
        policy.reset() // Adapter retires the old interaction identity before reuse.
        precondition(policy.consume(.ended, timestamp: 8, target: b) == .emit)

        // Cancellation must request identity replacement, not merely clear pending.
        precondition(policy.consume(.began, timestamp: 9, target: a) == .ignore)
        precondition(policy.consume(.cancelled, timestamp: 10, target: a) == .renewInteraction)
        policy.reset()
        precondition(policy.consume(.ended, timestamp: 11, target: a) == .emit)
        precondition(policy.consume(.changed, timestamp: 12, target: a) == .renewInteraction)

        // Invalid visibility/target state during a gesture retires its identity.
        precondition(policy.consume(.began, timestamp: 13, target: a) == .ignore)
        precondition(policy.consume(.changed, timestamp: 14, target: nil) == .renewInteraction)
        precondition(policy.consume(.ended, timestamp: 15, target: nil) == .renewInteraction)
        policy.reset()
        precondition(policy.consume(.ended, timestamp: 16, target: a) == .emit)

        // Background/key-window loss/dispose reset state; a new identity may start
        // with a discrete event. No invented comparison to process uptime is used.
        precondition(policy.consume(.began, timestamp: 17, target: a) == .ignore)
        policy.reset()
        precondition(policy.consume(.ended, timestamp: 0, target: b) == .emit)
        precondition(policy.consume(.ended, timestamp: 0, target: b) == .ignore)
        precondition(policy.consume(.ended, timestamp: 0.5, target: b) == .emit)

        for invalid in [-1.0, Double.nan, Double.infinity, -Double.infinity] {
            precondition(policy.consume(.ended, timestamp: invalid, target: a) == .renewInteraction)
        }
        precondition(policy.consume(.unknown, timestamp: 18, target: a) == .renewInteraction)

        // A token, window, or view change cannot complete the original gesture.
        for changed in [
            StylusGestureTarget(token: "b", window: a.window, view: a.view),
            StylusGestureTarget(token: a.token, window: "other", view: a.view),
            StylusGestureTarget(token: a.token, window: a.window, view: b.view),
        ] {
            policy.reset()
            precondition(policy.consume(.began, timestamp: 19, target: a) == .ignore)
            precondition(policy.consume(.ended, timestamp: 20, target: changed) == .renewInteraction)
        }

        // Preserve current B when an older A cleanup advances global generation.
        var gate = StylusTargetPolicy()
        precondition(gate.apply(generation: 1, token: a.token, window: a.window, active: true))
        precondition(gate.apply(generation: 2, token: b.token, window: b.window, active: true))
        policy.reset()
        precondition(policy.consume(.began, timestamp: 21, target: b) == .ignore)
        precondition(gate.apply(generation: 3, token: a.token, window: a.window, active: false))
        precondition(gate.token == b.token && gate.window == b.window)
        precondition(policy.consume(.ended, timestamp: 22, target: b) == .emit)

        for unsupported in ["ignore", "showInkAttributes", "showContextualPalette", "runSystemShortcut", "futureAction"] {
            precondition(StylusTargetPolicy.tapAction(unsupported) == nil)
        }
        precondition(StylusTargetPolicy.tapAction("switchEraser") == "toggleEraser")
        precondition(StylusTargetPolicy.tapAction("switchPrevious") == "previousTool")
        precondition(StylusTargetPolicy.tapAction("showColorPalette") == "showColorPalette")
        print("PASS: discrete/continuous squeeze, terminal dedupe, cancellation identity renewal, eligibility/target isolation, lifecycle reset, stale cleanup and preferred actions")
    }
}
