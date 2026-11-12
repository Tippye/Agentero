import Foundation
import Tauri
import WebKit

class AgenteroMobilePlugin: Plugin {
    private lazy var background = MobileBackgroundController(plugin: self)
    private lazy var stylus = MobileStylusController(plugin: self)

    override func load(webview: WKWebView) {
        DispatchQueue.main.async { [weak self] in
            _ = self?.background
            self?.stylus.attach(webview)
        }
    }

    private func onMain(_ invoke: Invoke, _ operation: @escaping (MobileBackgroundController) throws -> Void) {
        let work = { [weak self] in
            guard let self = self else {
                invoke.reject("Background adapter unavailable", code: "background_unavailable")
                return
            }
            do { try operation(self.background) }
            catch { invoke.reject("Invalid background arguments", code: "background_invalid") }
        }
        if Thread.isMainThread { work() }
        else { DispatchQueue.main.async(execute: work) }
    }

    private func withStylus(_ invoke: Invoke, _ operation: @escaping (MobileStylusController) throws -> Void) {
        let work = { [weak self] in
            guard let self = self else { invoke.reject("Stylus adapter unavailable", code: "stylus_unavailable"); return }
            do { try operation(self.stylus) }
            catch { invoke.reject("Stylus target unavailable or invalid", code: "stylus_unavailable") }
        }
        if Thread.isMainThread { work() }
        else { DispatchQueue.main.async(execute: work) }
    }

    @objc func stylusState(_ invoke: Invoke) {
        withStylus(invoke) { invoke.resolve($0.state()) }
    }

    @objc func stylusSetTarget(_ invoke: Invoke) {
        withStylus(invoke) { controller in
            invoke.resolve(try controller.setTarget(invoke.parseArgs(StylusNativeTargetArgs.self)))
        }
    }

    @objc func readState(_ invoke: Invoke) {
        onMain(invoke) { $0.readState(invoke) }
    }

    @objc func configure(_ invoke: Invoke) {
        onMain(invoke) { controller in
            let args = try invoke.parseArgs(MobileBackgroundConfigureArgs.self)
            controller.configure(invoke, enabled: args.enabled)
        }
    }

    @objc func requestNotifications(_ invoke: Invoke) {
        onMain(invoke) { $0.requestNotifications(invoke) }
    }

    @objc func openSettings(_ invoke: Invoke) {
        onMain(invoke) { controller in
            let args = try invoke.parseArgs(MobileBackgroundSettingsArgs.self)
            controller.openSettings(invoke, target: args.target)
        }
    }

    @objc func apply(_ invoke: Invoke) {
        onMain(invoke) { controller in
            let args = try invoke.parseArgs(MobileBackgroundApplyArgs.self)
            controller.apply(invoke, args: args)
        }
    }
}

@_cdecl("init_plugin_agentero_mobile")
func initPlugin() -> Plugin { AgenteroMobilePlugin() }
