import Foundation

struct MobileBackgroundState: Encodable {
    let platform = "ios"
    let persistentConnection = false
    let finiteTasks = true
    let backgroundTransfer = false
    let enabled = false
    let foreground: Bool
    let notificationPermission: String
    let notificationsEnabled: Bool
    let batteryOptimizationIgnored: Bool? = nil
    let agentActive = false
    let syncActive = false
    let finiteTaskActive: Bool
    let finiteTaskExpired: Bool

    enum CodingKeys: String, CodingKey {
        case platform, persistentConnection, finiteTasks, backgroundTransfer, enabled
        case foreground, notificationPermission, notificationsEnabled
        case batteryOptimizationIgnored, agentActive, syncActive, finiteTaskActive, finiteTaskExpired
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(platform, forKey: .platform)
        try values.encode(persistentConnection, forKey: .persistentConnection)
        try values.encode(finiteTasks, forKey: .finiteTasks)
        try values.encode(backgroundTransfer, forKey: .backgroundTransfer)
        try values.encode(enabled, forKey: .enabled)
        try values.encode(foreground, forKey: .foreground)
        try values.encode(notificationPermission, forKey: .notificationPermission)
        try values.encode(notificationsEnabled, forKey: .notificationsEnabled)
        try values.encodeNil(forKey: .batteryOptimizationIgnored)
        try values.encode(agentActive, forKey: .agentActive)
        try values.encode(syncActive, forKey: .syncActive)
        try values.encode(finiteTaskActive, forKey: .finiteTaskActive)
        try values.encode(finiteTaskExpired, forKey: .finiteTaskExpired)
    }
}

struct MobileBackgroundConfigureArgs: Decodable { let enabled: Bool }
struct MobileBackgroundSettingsArgs: Decodable { let target: String }
struct MobileBackgroundApplyArgs: Decodable {
    let generation: String
    let agentCount: UInt32
    let syncCount: UInt32
    let transferCount: UInt32
}
