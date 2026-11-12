import Foundation
import Tauri
import UIKit
import WebKit

struct StylusNativeCapability: Encodable {
    let id: String
    let source = "nativePencilInteraction"
    let actions = ["toggleEraser", "previousTool", "showColorPalette"]
    let doubleTap = true
    let barrelButton = false
    let invertedPen = false
    let hardwarePresence = false
}
struct StylusNativePresence: Encodable {
    let available: Bool
    let proximity: Bool? = nil
    let source = "nativePencilInteraction"
    let adapterId: String
    enum CodingKeys: String, CodingKey { case available, proximity, source, adapterId }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(available, forKey: .available)
        try values.encodeNil(forKey: .proximity)
        try values.encode(source, forKey: .source)
        try values.encode(adapterId, forKey: .adapterId)
    }
}
struct StylusNativeState: Encodable { let adapters: [StylusNativeCapability]; let presence: [StylusNativePresence] }
struct StylusNativeTargetArgs: Decodable { let generation: String; let windowLabel: String; let targetToken: String; let active: Bool }
private struct StylusNativeAction: Encodable { let action: String; let source = "nativePencilInteraction"; let adapterId: String; let targetToken: String }
private struct StylusNativeMessage: Encodable {
    let kind: String
    let windowLabel: String
    let targetToken: String?
    let event: StylusNativeAction?
    let presence: StylusNativePresence?
}

private protocol StylusNativeAdapter: AnyObject {
    var capability: StylusNativeCapability { get }
    var observed: Bool { get }
    func attach(_ view: WKWebView, action: @escaping (String?) -> Void)
    func dispose()
}

private final class ApplePencilStylusAdapter: NSObject, StylusNativeAdapter, UIPencilInteractionDelegate {
    let capability = StylusNativeCapability(id: "apple-pencil-interaction")
    private(set) var observed = false
    private weak var view: WKWebView?
    private var interaction: UIPencilInteraction?
    private var action: ((String?) -> Void)?
    func attach(_ view: WKWebView, action: @escaping (String?) -> Void) {
        dispose()
        self.view = view; self.action = action
        let interaction = UIPencilInteraction()
        interaction.delegate = self
        view.addInteraction(interaction)
        self.interaction = interaction
    }
    func dispose() {
        if let interaction = interaction { view?.removeInteraction(interaction) }
        interaction = nil; action = nil; view = nil
    }
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        precondition(Thread.isMainThread)
        guard interaction === self.interaction else { return }
        observed = true
        let preference: String
        switch UIPencilInteraction.preferredTapAction {
        case .switchEraser: preference = "switchEraser"
        case .switchPrevious: preference = "switchPrevious"
        case .showColorPalette: preference = "showColorPalette"
        default: preference = "ignore"
        }
        action?(StylusTargetPolicy.tapAction(preference))
    }
}

private final class WeakStylusView { weak var view: WKWebView?; init(_ view: WKWebView) { self.view = view } }

final class MobileStylusController {
    private weak var plugin: Plugin?
    private var views: [WeakStylusView] = []
    private var adapters: [StylusNativeAdapter] = []
    private weak var targetView: WKWebView?
    private var gate = StylusTargetPolicy()
    init(plugin: Plugin) {
        precondition(Thread.isMainThread)
        self.plugin = plugin
        if UIDevice.current.userInterfaceIdiom == .pad { adapters = [ApplePencilStylusAdapter()] }
    }
    func attach(_ view: WKWebView) {
        precondition(Thread.isMainThread)
        views.removeAll { $0.view == nil }
        if !views.contains(where: { $0.view === view }) { views.append(WeakStylusView(view)) }
    }
    func state() -> StylusNativeState {
        StylusNativeState(adapters: adapters.map { $0.capability }, presence: adapters.map {
            StylusNativePresence(available: $0.observed, adapterId: $0.capability.id)
        })
    }
    func setTarget(_ args: StylusNativeTargetArgs) throws -> StylusNativeState {
        precondition(Thread.isMainThread)
        guard let generation = StylusTargetPolicy.parseGeneration(args.generation), UUID(uuidString: args.targetToken) != nil,
              !args.windowLabel.isEmpty, args.windowLabel.utf8.count <= 128 else { throw StylusAdapterError.invalid }
        guard generation > gate.generation else { return state() }
        let candidates = views.compactMap { $0.view }.filter { Self.isVisible($0) }
        if args.active && candidates.count != 1 { throw StylusAdapterError.inactive }
        _ = gate.apply(generation: generation, token: args.targetToken, window: args.windowLabel, active: args.active)
        if args.active {
            adapters.forEach { $0.dispose() }
            targetView = candidates[0]
            for adapter in adapters {
                adapter.attach(candidates[0]) { [weak self, weak adapter] action in
                    guard let self = self, let adapter = adapter else { return }
                    self.emit(adapter: adapter, action: action)
                }
            }
        } else if gate.token == nil {
            adapters.forEach { $0.dispose() }; targetView = nil
        }
        return state()
    }
    private static func isVisible(_ view: WKWebView) -> Bool {
        UIApplication.shared.applicationState == .active && view.window?.isKeyWindow == true && !view.isHidden && view.alpha > 0
    }
    private func emit(adapter: StylusNativeAdapter, action: String?) {
        precondition(Thread.isMainThread)
        guard let view = targetView, Self.isVisible(view), let token = gate.token, let window = gate.window else { return }
        let presence = StylusNativePresence(available: adapter.observed, adapterId: adapter.capability.id)
        try? plugin?.trigger("stylus-event", data: StylusNativeMessage(kind: "presence", windowLabel: window, targetToken: token, event: nil, presence: presence))
        if let action = action {
            try? plugin?.trigger("stylus-event", data: StylusNativeMessage(kind: "action", windowLabel: window, targetToken: nil,
                event: StylusNativeAction(action: action, adapterId: adapter.capability.id, targetToken: token), presence: nil))
        }
    }
    deinit {
        let owned = adapters
        if Thread.isMainThread { owned.forEach { $0.dispose() } }
        else { DispatchQueue.main.async { owned.forEach { $0.dispose() } } }
    }
}

enum StylusAdapterError: Error { case invalid, inactive }
