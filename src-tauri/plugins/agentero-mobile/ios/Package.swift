// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tauri-plugin-agentero-mobile",
    platforms: [.iOS("18.2")],
    products: [.library(name: "tauri-plugin-agentero-mobile", type: .static, targets: ["tauri-plugin-agentero-mobile"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-agentero-mobile", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
