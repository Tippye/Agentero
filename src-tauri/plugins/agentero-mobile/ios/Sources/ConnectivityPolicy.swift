import Foundation

/// Private native hint, not network availability or Host reachability.
struct ConnectivityHint: Encodable, Equatable, Sendable {
    let generation: String
}

/// Serial-queue policy. Paths stay local; equality uses the complete NWPath in production.
struct ConnectivityPolicy<Path: Equatable> {
    static var maximumGeneration: UInt64 { UInt64(Int64.max) }
    private(set) var generation: UInt64
    private(set) var epoch: UInt64 = 0
    private(set) var running = false
    private var lastPath: Path?

    init(generation: UInt64 = 0) {
        self.generation = min(generation, Self.maximumGeneration)
    }

    var hint: ConnectivityHint { ConnectivityHint(generation: String(generation)) }

    /// Repeated attachment never replaces the active monitor or its callback epoch.
    mutating func start() -> UInt64? {
        if running { return epoch }
        guard epoch < UInt64.max else { return nil }
        epoch += 1
        running = true
        return epoch
    }

    /// The first real callback establishes a baseline, never a synthetic offline change.
    mutating func observe(_ path: Path, epoch observedEpoch: UInt64) -> UInt64? {
        guard running, observedEpoch == epoch else { return nil }
        guard let previous = lastPath else {
            lastPath = path
            return nil
        }
        guard previous != path else { return nil }
        lastPath = path
        guard generation < Self.maximumGeneration else { return nil }
        generation += 1
        return generation
    }

    /// Queued old monitor callbacks and superseded Main publications are ignored.
    func permitsDelivery(epoch observedEpoch: UInt64, generation observedGeneration: UInt64) -> Bool {
        running && observedEpoch == epoch && observedGeneration == generation
    }

    /// Explicit owner teardown only; Scene changes and finite-window expiry do not call this.
    mutating func stop() {
        running = false
        // Retain the counter and last real path so a restarted monitor can detect a change.
    }
}
