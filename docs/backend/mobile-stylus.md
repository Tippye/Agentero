# 移动端手写笔适配

PDF 笔迹持久化继续使用共享的 page-space ink 数据；本模块只提供能力、来源明确的笔观察和高层工具动作，不持有文件、同步或 Agent 工作。

## 当前覆盖

| 平台 / 来源 | 实际实现 | 不宣称的能力 |
|---|---|---|
| Web PointerEvent | 实际 pen 接触观察；标准按钮、反转笔尖、压力等由 PDF 输入层处理 | 不列出系统已连接的笔，不根据品牌猜测功能 |
| Android `InputManager` / `InputDevice` | 泛用适配器注册设备变化监听，以公开 `SOURCE_STYLUS` 查询输入源；标准侧键与反转笔尖仍由 Web 输入处理，避免重复切换 | 注册输入源可能是内置数字化器，并不证明某支实体笔连接；无标准笔身双击能力，无反射或未公开 OEM 接口 |
| iPad `UIPencilInteraction` | 当前可见 WKWebView 上接收双击，尊重 `preferredTapAction`，映射橡皮、上一个工具、调色板；观察到回调后才报告可用 | 不枚举 Pencil 硬件连接；不假定所有 Pencil 支持双击；本轮不声明 Pencil Pro squeeze 或悬停能力 |
| 桌面 / 共享分支原生 stub | 返回空适配器与空原生观察，Web 输入可独立工作 | 不伪造 Android/iOS 原生能力 |

能力中的 `hardwarePresence` 当前均为 `false`。`StylusPresence.available` 的含义必须结合 `source`：`nativeInputDevice` 是已注册的 stylus 输入源，`nativePencilInteraction` 是实际收到 Pencil 交互，`pointer` 是本视图收到 pen 指针。未知距离为显式 `proximity:null`，不是断开连接。

## 数据与路由

共享插件的 Rust-only 方法是 `stylusState` 与 `stylusSetTarget`，原生事件通过 `stylus-event` 频道直接到 Rust。插件仍没有面向 WebView 的原生命令 handler；应用只开放生成绑定中的 `mobile_stylus_get_state` 与 `mobile_stylus_set_target`。

- 高层动作是 `toggleEraser`、`previousTool`、`nextColor`、`showColorPalette`、`select`。适配器的 `actions` 只列自己真正实现的子集；当前 Pencil 只产生橡皮、上个工具和调色板三种动作。`select` 只表示进入选择/套索模式，绝不代表没有坐标的文字选中。
- PDF 使用 `activateStylusTarget(documentKey)` 获得独立 UUID token，在隐藏、切文档或卸载时清理；多个订阅者必须用 `isStylusTarget(documentKey)` 确认自己仍是当前所有者。清理立即使旧 token 失效，异步原生清理不影响新文档。
- Rust 从调用的 WebView 获取窗口标签，原生激活与清理使用进程级单调递增的十进制 `u64` generation 字符串。旧 generation 不能复活旧目标或取消新目标。Rust 在任何激活之前注册原生频道，按窗口与 token 对事件做二次校验，定向发出 `mobile:stylus-action` / `mobile:stylus-presence`。
- Android 使用真实 `WebView.isAttachedToWindow`、`hasWindowFocus`、`isShown` 和 Activity 焦点检查；iOS 使用实际 WKWebView 的 key window、可见性与活动状态，存在多个无法区分的候选视图时拒绝激活。移动端不调用 pinned Tao 的通用桌面焦点 getter。桌面才使用 `is_visible` / `is_focused`。
- facade 串行提交激活/清理，等监听注册完成后再激活；收到事件时再次检查文档 token 与页面可见性。取消后的晚到监听会释放，原生不可用时不会改走未经授权的 JS/native 通道。

公开 facade：`subscribeStylusActions`、`subscribeStylusPresence`、`getMobileStylusState`、`activateStylusTarget`、`isStylusTarget`、`observeStylusPointerPresence`。公开类型来自 Rust 生成绑定，没有第二套可漂移 schema。

## 品牌扩展契约

Android `StylusAdapter` 的 `probe`、`presence`、`start`、`dispose` 和注册表是未来 OEM 适配的边界。新增品牌必须先证明 SDK/系统 API 是公开且可随应用发布的，显式加入适配器与准确的来源/能力枚举，再增加对应的生命周期与真机测试。不要根据品牌字符串开启泛用双击，也不要用反射探测私有 SDK。未实现的功能保持 `false` 或空动作列表。

iOS 的 `StylusNativeAdapter` 同样统一 probe 数据、绑定当前视图与 dispose；更换目标先移除旧 `UIPencilInteraction`，引用视图和插件均为弱引用。新硬件手势须有明确的最低系统和完整 SDK 类型检查后再声明，不能因为部署下限是 18.2 就假定实际硬件具备该能力。

## 验证与限制

facade 测试覆盖当前 token 路由、跨文档旧清理、监听注册前取消、观察来源、隐藏视图。Swift 纯策略测试覆盖 generation、过期清理与用户偏好动作；所有 Swift 文件可语法解析，但当前环境没有完整 Xcode/iPhoneOS SDK，因此不等同于 UIKit SDK 编译或真机验收。Android SDK 编译、Root Rust 生成绑定/事件契约检查由协调后的集成验证执行，不能用语法或纯策略测试替代。

参考：

- [Android InputDevice 公开 API](https://developer.android.com/reference/android/view/InputDevice) 与 [Android 13 AOSP 实现](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-13.0.0_r1/core/java/android/view/InputDevice.java)。
- [UIKit UIPencilInteraction](https://developer.apple.com/documentation/uikit/uipencilinteraction)、[preferredTapAction](https://developer.apple.com/documentation/uikit/uipencilinteraction/preferredtapaction) 与 [处理双击示例](https://developer.apple.com/documentation/applepencil/handling-double-taps-from-apple-pencil)。
- [Tauri 2.12.5 Swift 插件 API](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/mobile/ios-api/Sources/Tauri/Plugin/Plugin.swift) 与同版本 Android Plugin 生命周期/频道 API。
- 调研了 [Android 官方 input-samples](https://github.com/android/input-samples)，该仓库已明确弃用；不引入其旧工程或第三方输入框架。此处只封装当前公开 API，笔迹渲染仍复用现有成熟组件。
