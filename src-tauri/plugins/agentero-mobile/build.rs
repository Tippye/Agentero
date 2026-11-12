fn main() {
    // The native bridge is called by Rust only. WebViews use the application's
    // generated, allowlisted commands and cannot acquire raw OS leases.
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .ios_path("ios")
        .build();
}
