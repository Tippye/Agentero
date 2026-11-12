// Pure policy for one finite UIKit window shared by sync and transfer work.
struct MobileFiniteWindow {
    enum Effect: Equatable {
        case begin(UInt64)
        case end(UInt64)
        case expired
    }

    private(set) var foreground: Bool
    private(set) var activeEpoch: UInt64?
    private(set) var expired = false
    private(set) var lastGeneration: UInt64 = 0
    private var hasWork = false
    private var nextEpoch: UInt64 = 0

    init(foreground: Bool) {
        self.foreground = foreground
    }

    static func generation(_ raw: String) -> UInt64? {
        guard let value = UInt64(raw), value > 0, String(value) == raw else { return nil }
        return value
    }

    mutating func apply(generation: UInt64, syncCount: UInt32, transferCount: UInt32) -> [Effect] {
        guard generation > lastGeneration else { return [] }
        lastGeneration = generation
        let work = syncCount > 0 || transferCount > 0
        let started = work && !hasWork
        hasWork = work
        if !work {
            expired = false
            return end()
        }
        guard started, foreground, activeEpoch == nil else { return [] }
        guard nextEpoch < UInt64.max else {
            expired = true
            return [.expired]
        }
        nextEpoch += 1
        activeEpoch = nextEpoch
        expired = false
        return [.begin(nextEpoch)]
    }

    mutating func setForeground(_ value: Bool) -> [Effect] {
        foreground = value
        // Visibility does not complete work or renew the system's finite budget.
        return []
    }

    mutating func expire(_ epoch: UInt64) -> [Effect] {
        guard activeEpoch == epoch else { return [] }
        activeEpoch = nil
        expired = true
        return [.end(epoch), .expired]
    }

    mutating func cancel() -> [Effect] {
        hasWork = false
        return end()
    }

    private mutating func end() -> [Effect] {
        guard let epoch = activeEpoch else { return [] }
        activeEpoch = nil
        return [.end(epoch)]
    }
}
