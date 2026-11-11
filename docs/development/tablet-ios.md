# 平板端实施方案：iOS / iPadOS 篇

> 状态：**设计稿，未实现，待评审**。基线 `66ecc126`（v0.15.5，Tauri 2.12.5 / tao 0.37.2），行号对应该提交。
> 两端共用部分在 `mobile` 分支维护，见 [tablet-shared.md](tablet-shared.md)。`ios` 基于 `mobile`，这里只写 iOS / iPadOS 特有工作；文中 S0–S9 指共享篇工作项。本次仅修改方案，应用配置尚未实施。

## 1. 结论

- iPad 是主要目标；同一个安装包继续在 iPhone 上运行，iPhone 只用窄档布局，不做多窗口和手写。
- **已明确仅 Android 申请后台常驻，iOS 不实现常驻入口或申请流程。** iOS 只做可恢复任务、系统允许的有限后台处理和回到前台后的重连（I5）。应用挂起后不依赖连接继续存活；远端 Agent 任务照常运行。挂起期间的完成通知需要服务器推送，首个版本不提供。
- 分屏的前提已经满足：工程没有设置 `UIRequiresFullScreen`，iPad 四个方向都支持。真正的多窗口要在 Info.plist 里打开多场景，并做一次技术验证（I6）。
- 手写先验证 WebView 路线，延迟不达标再上原生书写层（I7）。

## 2. 现状

| 项 | 现状 | 位置 |
|---|---|---|
| 工程 | XcodeGen 模板是事实来源，`gen/apple/` 由 Tauri 生成 | `src-tauri/ios-project.yml`、`src-tauri/tauri.ios.conf.json`、`src-tauri/Info.ios.plist` |
| 最低系统 | iOS 15.0 | `src-tauri/ios-project.yml:5` |
| 目录 | 已适配：配置在 `Library/Application Support`，缓存在 `Library/Caches` | `crates/agentero-core/src/paths.rs:23` |
| 密钥 | 只有 Bridge 身份进了 Keychain，且未指定可访问性；配对资料和同步凭据是 JSON 文件 | `src-tauri/src/integration/bridge/identity.rs:319`–`:376` |
| 命令 | Bridge 客户端命令已注册；同时注册了全部通用命令 | `src-tauri/src/app/handlers.rs:333` |
| Info.plist | 相机用途说明、本地网络用途说明（文案写的是开发服务器）、`agentero://` 链接；没有场景清单、后台模式、文档类型、文件共享相关键 | `src-tauri/Info.ios.plist`、`src-tauri/ios-project.yml:39` |
| 权限文件 | 空 | `src-tauri/gen/apple/agentero_iOS/agentero_iOS.entitlements` |
| 隐私清单 | 没有 `PrivacyInfo.xcprivacy` | — |
| 发布 | TestFlight 工作流只能手动触发，自动发布自 2026-10-16 起冻结 | `.github/workflows/ios-testflight.yml`、[../test/ios-testflight.md](../test/ios-testflight.md) |

## 3. 平台工作项

### I1 工程与配置

- **最低系统版本定为 iOS/iPadOS 18.2。** 体验与功能优先，不再以 Tailwind CSS 的 Safari 16.4 样式下限作为支持目标。Safari 18.2 起支持 PointerEvent 的合并事件和预测事件，适合作为 Web 手写路线的验证基线；Pencil Pro 挤压 API 的系统要求也已覆盖，但仍需对应硬件。实施时同步改 `ios-project.yml`、`tauri.ios.conf.json`、`scripts/ios-release-check.mjs` 和发布检查，不保留旧系统兼容包袱。
- 系统版本不代表全部能力可用：WKWebView 中事件、输入延迟和掌触仍须真机验证；iOS/iPadOS 26 的持续处理任务和窗口行为按系统版本启用，18.2 上使用现有有限后台任务与分屏。
- **Info.plist 增加的键**（写在 `ios-project.yml` 的 `info.properties` 和 `Info.ios.plist`）：

  | 键 | 用途 | 归属 |
  |---|---|---|
  | `UIApplicationSceneManifest`，其中 `UIApplicationSupportsMultipleScenes = true` | 多窗口 | I6 |
  | `UIBackgroundModes`：`fetch`、`processing`；`BGTaskSchedulerPermittedIdentifiers` | 后台同步 | I5 |
  | `CFBundleDocumentTypes`（PDF） | 「打开方式」里出现 Agentero | I4 |
  | `UIFileSharingEnabled`、`LSSupportsOpeningDocumentsInPlace` | Vault 在「文件」应用里可见（取决于 D-iOS-2） | I2 |
  | 更新 `NSLocalNetworkUsageDescription` 文案 | 连接局域网里的自部署服务器 | I9 |

- **权限文件**：App Group（分享扩展与主应用共用收件箱）。推送能力等到有推送服务时再加。描述文件要包含这些能力。
- **隐私清单**：新增 `PrivacyInfo.xcprivacy`。本地 Vault 和同步会用到文件时间戳、磁盘空间这类需要声明理由的接口。
- **本地插件**：共享篇第 5 节的 `agentero-mobile` 插件，iOS 侧用 Swift 实现，按 Tauri 的移动端插件结构接入。
- `scripts/ios-release-check.mjs` 目前只检查文件、图标和相机说明，补上对新增键的检查。

### I2 存储与文件

- **Vault 位置**：`Documents/Vault/`。打开文件共享后用户能在「文件」应用里看到自己的笔记和 PDF，符合「离开应用后数据仍可读」的原则。代价是用户可能在外部改动文件；回到前台时的重扫能吸收这种改动。如果不希望可见，改放 `Library/Application Support/`（D-iOS-2）。
- `.agentero/catalog.sqlite` 跟随 Vault。缓存（模型、远程 PDF 缓存、缩略图）留在 `Library/Caches`，系统可清理，代码要能重建。
- **备份**：`Documents` 默认进入设备备份。已配置同步且可以重新下载的 PDF 标记为不备份，避免备份体积膨胀；笔记和标注始终备份。
- **数据保护**：保持系统默认级别（首次解锁后可读），后台任务在锁屏时才能读写 Vault。不要改成「仅解锁时可读」。
- **外部目录**：首个版本不支持把 Vault 建在 iCloud Drive 或其他文件提供器目录里。那需要安全作用域书签和文件协调，而且 SQLite 放在云盘目录里不可靠。

### I3 密钥存储

- 把 `identity.rs` 里只服务 Bridge 身份的 Keychain 读写，抽成插件的通用密钥接口。迁入：Bridge 配对资料、同步凭据、远程 Agent 的设备私钥与令牌、主机公钥固定表。
- 写入时指定「首次解锁后可读、仅本设备」。现有代码没有指定可访问性，系统默认是解锁时才可读，后台任务在锁屏状态下会读取失败。
- 已有用户的 JSON 凭据在首次启动时迁入 Keychain 并删除原文件（Bridge 身份已有同样的迁移逻辑，`identity.rs:270`）。

### I4 导入、分享、导出

| 入口 | 做法 |
|---|---|
| 应用内选文件 | 文档选择器。`tauri-plugin-dialog` 已是依赖，先验证它在 iOS 上返回的文件能否直接读取；不能就在本地插件里实现，选中后复制进 Vault |
| 「打开方式」 | 声明 PDF 文档类型；Tauri 2.11 起移动端文件关联会触发 `RunEvent::Opened`，收到后进导入队列 |
| 系统分享面板 | 新增分享扩展 target（在 `ios-project.yml` 里加）。扩展内存上限很低，只做一件事：把文件或链接写进 App Group 收件箱。主应用激活时取走并导入 |
| 拖放 | iPad 上从其他应用拖 PDF 进来。WebView 的拖放事件是否可用需要验证，放在 M5 |
| 导出 | 系统分享面板和「存储到文件」：笔记、带批注的 PDF 副本、BibTeX / RIS |
| 扫描纸质文档 | 系统文档扫描界面生成 PDF 后走导入。后置 |

### I5 后台与通知

本节的后台任务用于短时收尾、同步和文件传输，不是常驻能力。共享接口返回 `persistentConnection = false`；设置不展示电池优化豁免或常驻申请。通知授权也不意味着允许持续运行。

系统提供的几种机制和各自的限制：

| 机制 | 限制 | 用在哪 |
|---|---|---|
| 退后台时申请的短时任务 | 时间很短且不保证，超时会被终止 | 收尾：保存草稿、写完当前文件、让正在进行的同步轮次结束或落到断点 |
| 后台刷新任务 | 由系统决定时机，每次最多约 30 秒 | 轻量同步。引擎在「已是最新」时整轮只有 1 次请求，适合这个窗口 |
| 后台处理任务 | 系统挑空闲时段（通常在充电时）运行 | 大量上传下载、Catalog 重建 |
| 后台传输会话 | 由系统进程代传；只支持 HTTP(S)，上传必须来自文件，重定向总是跟随，连续发起会被限速 | 大 PDF 下载。属于优化，后置：同步引擎的请求在 Rust 里，要另做一条「下载清单交给系统、完成后回填」的路径，S3 还得用预签名地址 |
| 持续处理任务（iOS 26 起） | 必须由用户在前台操作发起；系统用实时活动展示进度，用户可取消；资源紧张时系统会终止它，尤其是没有进度的任务 | 用户点「离线保存整个集合」这类有明确进度的批量任务 |

不能做的事：

- **不能在后台长时间维持 Agent 连接。** 审核规则要求后台模式只能用于其本来用途，不能借音频、定位等模式保活。持续处理任务也不适合，等待远端回复没有可报告的进度。
- **后台收不到 Agent 完成通知**，除非有服务器推送。ds-harness-remote 的代码里没有找到推送实现；Agentero 自己的中继把推送列在后续阶段（[../frontend/mobile.md](../frontend/mobile.md) §8.4）。首个版本的行为是：应用在前台或刚退后台的短时窗口内，用本地通知；之后要等用户回到应用，重连后补齐状态并在应用内提示。

通知权限在第一次用到时才申请（第一次发出 Agent 任务时），不在启动时弹。

### I6 分屏与多窗口

- **窗口缩放**：iPadOS 18 及以前是分屏浏览和侧拉，支持台前调度的机型另有自由窗口；iPadOS 26 起是窗口化模式，`UIRequiresFullScreen` 已被废弃。工程没有设置这个键，所以应用现在就会被系统缩放，S4 的三档布局要覆盖从约三分之一屏到全屏的宽度。tao 0.36 已修复 iPadOS 26 的窗口控件遮挡 WebView 内容的问题，仓库的 0.37.2 包含该修复。
- **多窗口**：
  1. Info.plist 打开多场景。
  2. Rust 侧处理系统发起的新场景请求（用户长按图标选「新窗口」），以及应用内「在新窗口打开」——后者复用桌面的 `doc_window_open`。
  3. 每个场景是一个独立的 WebView，各自加载一份 PDF 渲染引擎。先量单窗口内存，再定同时打开的窗口上限。
  4. 系统会断开并稍后重建场景。按窗口标签落盘路由（S7）；场景会话标识和窗口标签怎么对应，要在技术验证里确认。
- **M0 技术验证的出口条件**：在 iPad 上开第二个窗口并加载应用；两个窗口各自调用命令、各自收到事件；杀掉其中一个再恢复，回到原论文原页码。验证不通过则多窗口后置，窗口缩放不受影响。
- iPhone 不开多场景入口。

### I7 Apple Pencil

数据格式、存储、同步、显示都在共享篇 S6。这里只定输入层。

**先验证路线 A（WebView 指针事件）**，在 M0 实测三件事：

- 笔尖到墨迹的延迟，在 120 Hz 机型上是否可接受；
- 压力、倾角、合并事件、预测事件在 WKWebView 里是否可用，采样率多少；
- 手掌搁在屏幕上时页面会不会被带着滚动。书写模式下笔落下期间要屏蔽触摸滚动。

**路线 A 不达标时用路线 B**：在 WebView 上盖一个原生书写层。优先做法是只接收 Pencil 触摸的手势识别器加自绘墨迹——手指触摸自然落到下面的 WebView，滚动缩放不用另外处理；落笔结束后把点序列交给前端，按共享格式保存，原生层清空。备选是 PencilKit 画布，能直接得到系统的笔刷、橡皮和套索，但它自带滚动视图，手指穿透和与 PDF 的缩放同步都要额外解决，数据也要在 `PKDrawing` 和共享格式之间来回转换。

无论哪条路线都要做的原生部分（放在本地插件里）：

- Pencil 双击和挤压手势，转成前端事件切换工具。双击需要第二代或 Pro；挤压只有 Pro 支持；第一代没有这些手势。
- 在可编辑区域之外的书写模式下，避免系统的手写输入（随手写）截获笔迹。

硬件差异要在界面上体现：Apple Pencil（USB-C）没有压感，笔迹用固定宽度；悬停只在部分机型可用，只作增强，不作前提。

### I8 WebView 与输入

- **内存**：系统在内存紧张时会终止 WebView 的内容进程。Tauri 2.11 增加了这个事件的处理入口；收到后重新加载页面并按落盘的路由恢复。草稿自动保存（S2）是这条路径不丢数据的前提。
- **软键盘**：用可视视口计算布局，键盘弹出时编辑器滚到光标处，PDF 一侧保持页码。
- **安全区**：沿用 `env(safe-area-inset-*)`；iPadOS 26 窗口化后左上角有窗口控件，标题栏留出位置。
- **外接键盘和触控板**：快捷键走 Web 的键盘事件；触控板悬停和右键可用，所以悬停菜单在有指针时保留，触摸时走长按。
- **左缘返回手势**：在书写模式下停用（S4）。

### I9 远程 Agent 的 iOS 部分

- 默认使用 ds-harness-remote，通过 `mobile` 的 provider 契约接入。认证、通知和恢复流程按后端能力驱动，保留其他远程后端的模块接入点；所有 provider 都遵守 iOS 不常驻的生命周期约束。
- 回到前台、网络切换时立即重连，不等心跳超时。网络变化由插件监听后通知 Rust。
- 账号登录用系统的网页认证会话，不在应用内嵌网页。
- 连接局域网里的自部署服务器会触发本地网络权限弹窗，用途说明文案要改。连接由 Rust 发起，不经过系统对 WebView 的明文流量限制；共享篇已规定明文 HTTP 只允许回环和私网地址。
- **审核相关的两点**，上架前要定（D-iOS-3）：
  - 托管服务的登录方式是 GitHub、Google、知乎等第三方登录。审核规则 4.8 要求提供第三方登录的应用同时提供一种隐私保护等价的登录方式，「某个第三方服务的客户端」是例外之一，是否适用有不确定性。把扫码配对做成 iOS 上的首选路径，可以绕开账号登录。
  - 规则 5.1.1(v) 要求支持创建账号的应用提供应用内删除账号。应用内只做登录、不做注册，并提供「退出并撤销本设备」。

### I10 发布

- 沿用 TestFlight 流程（[../test/ios-testflight.md](../test/ios-testflight.md)）。描述文件加入 App Group；分享扩展有自己的 Bundle ID 和描述文件，CI 的签名密钥要相应增加。
- 审核说明要重写：现在的说明是「必须先配对桌面才能用」，有了本地 Vault 后应用可以独立使用，说明改为直接导入 PDF 体验，远程 Agent 作为可选功能另行描述。
- 出口合规：现有清单列的是 TLS、X25519 / XSalsa20-Poly1305、Ed25519。远程 Agent 通道新增 Noise IK（X25519、ChaCha20-Poly1305、SHA-256），提交前按实际情况更新答卷。
- 隐私问卷：新增的数据流向是用户自己配置的同步存储和远程 Agent 服务器。

## 4. 里程碑中的 iOS 部分

| 里程碑 | iOS 工作 |
|---|---|
| M0 | I1（版本、插件骨架、隐私清单）；I3；两项技术验证：I6 多窗口、I7 手写路线 A |
| M1 | I2；I4 的选文件与「打开方式」；I8 |
| M2 | I5 的短时任务、后台刷新、后台处理 |
| M3 | I9 |
| M4 | I7 定型（路线 A 或 B）、Pencil 手势 |
| M5 | I6 多窗口落地；I4 的分享扩展和拖放；I5 的持续处理任务；I10 |

## 5. 真机验收

设备与系统：

- 一台仍在支持范围内的旧 iPad（最低系统版本）、一台 M 系列 iPad、iPad mini（窄宽度）、一台 iPhone（回归）。
- iPadOS 18.2（最低版本，分屏浏览、侧拉、台前调度）和 iPadOS 26（窗口化、持续处理任务）；发布时再覆盖当时最新稳定系统，不测试 18.2 以下兼容性。
- Apple Pencil 第二代、Pro、USB-C 三种；外接键盘和触控板。

清单：

1. 飞行模式下建库、导入、阅读、高亮、写笔记；杀进程后内容都在。
2. 窗口从三分之一屏拖到全屏再拖回，页码、缩放、草稿不变。
3. 两个窗口并排读两篇论文；回收其中一个后恢复到原位置。
4. 同步进行中切到后台再回来，同步从断点继续，没有重复上传。
5. 锁屏状态下触发后台刷新，同步能读到凭据并完成。
6. 发出 Agent 任务后离开应用十分钟，回来能看到完整结果；等待确认的请求仍可处理。
7. 手写：缩放和旋转后笔迹不偏；手掌搁屏不误触；USB-C 笔正常书写。
8. 内存压力下 WebView 被终止后自动恢复，草稿不丢。
9. 从 Safari 和「文件」分享 PDF、链接到 Agentero，回到应用后已入库。

## 6. 待决事项

| # | 事项 | 建议 |
|---|---|---|
| D-iOS-1（已定） | 体验与功能优先的最低版本 | iOS/iPadOS 18.2；实施时同步工程、预检和发布配置 |
| D-iOS-2 | Vault 是否在「文件」应用里可见 | 可见，放 `Documents/Vault/` |
| D-iOS-3 | 远程 Agent 的登录方式与审核规则 4.8、5.1.1(v) | iOS 上扫码配对为首选；账号登录只登录不注册 |
| D-iOS-4 | 是否为 Agent 完成通知建推送服务 | 首个版本不做；Bridge 通道后续随中继一起做 |
| D-iOS-5 | 恢复随版本自动发布 TestFlight 的时机 | M1 出口后恢复内测发布 |

## 7. 参考

- 共享部分：[tablet-shared.md](tablet-shared.md)
- 现有 iOS 发布流程：[../test/ios-testflight.md](../test/ios-testflight.md)
- 后台任务策略：<https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app>
- 持续处理任务：<https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados>
- 后台下载：<https://developer.apple.com/documentation/foundation/downloading-files-in-the-background>
- 多窗口：<https://developer.apple.com/documentation/uikit/supporting-multiple-windows-on-ipad>
- `UIRequiresFullScreen` 废弃说明：<https://developer.apple.com/documentation/bundleresources/information-property-list/uirequiresfullscreen>
- PencilKit：<https://developer.apple.com/documentation/pencilkit>；Pencil 手势：<https://developer.apple.com/documentation/uikit/apple-pencil-interactions>
- 审核规则（2.5.4、4.8、5.1.1）：<https://developer.apple.com/app-store/review/guidelines/>
- Tailwind CSS 浏览器要求：<https://tailwindcss.com/docs/compatibility>
- PointerEvent 支持数据（合并/预测事件 Safari 18.2）：<https://github.com/mdn/browser-compat-data/blob/main/api/PointerEvent.json>
- tao 更新记录（移动端多窗口、场景）：<https://github.com/tauri-apps/tao/blob/dev/CHANGELOG.md>
