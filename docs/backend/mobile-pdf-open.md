# Android 系统打开 PDF

Android 分支接入系统「用 Agentero 打开」的单份 PDF 入口，将系统授权文档导入当前本地文献库。冷启动通过插件 `load` 读取一次启动 Intent，已运行时通过公开 `Plugin.onNewIntent` 接收；不覆盖 Activity 的 Wry/Tauri Intent 分派，也不借用仅支持 `agentero:` 的配对深链处理器。

## 原生接收边界

- 清单只增加 `ACTION_VIEW`、`content` scheme 与 `application/pdf` 的独立过滤器。没有 `file://`、任意网页、`SEND`、`SEND_MULTIPLE` 或文本分享入口。
- MIME 只用作路由，不能证明文件内容是 PDF。只接受一份 `Intent.data`；ClipData 可以为空，或只有同一个 URI。不同 URI、多项、文字、HTML、嵌套 Intent 和额外 stream 均拒绝。
- 必须有 `FLAG_GRANT_READ_URI_PERMISSION` 且当前进程实际获得读取授权。URI 长度有界，必须为合法 `content://`，拒绝解码后带用户前缀的 authority；不会把 URI 变为本地文件路径。
- 原生邮箱最多保留一个待处理 URI。第一份保留，后续有效请求显示英中本地化的忙碌提示，用户可在处理后重新打开。已运行的 Intent 先到时不会再重放旧启动请求；清空和销毁不会重新读取已消费的冷启动 Intent。
- URI 只留在原生内存中，不发送到前端、不写日志或磁盘、不请求持久授权。读取权限仍受 Android Activity/task 与提供器生命周期限制；长时间挂起或关闭之后没有延迟读取保证，需要重新打开。

## 当前文献库与资源所有权

前端先注册不含文档信息的 `mobile:external-pdf-pending` 唤醒事件，再读取当前待处理项。事件、前台聚焦和可见性变化只请求一次检查，不使用轮询；没有文献库、页面隐藏或已有导入占用时不领取。事件注册迟到、卸载和切换文献库均按当前已提交的挂载/文献库 epoch 隔离；手动选择器、浏览器选择与系统打开共享准入锁，忙碌时合并一个唤醒，在当前操作结束后检查。

`paper_import_opened_pdf(vaultPath)` 不接收 URI、路径、FD 或请求正文，只允许主应用窗口提交当前本地文献库。iOS 和桌面没有 Android 待处理文档时返回 null，不尝试调用 Android 插件。Rust 注册一次原生唤醒通道后再领取邮箱；原生待处理项在领取时从邮箱移除，随后才打开 descriptor，读取失败不会在每次聚焦时自动重试同一来源。

Rust 在领取前捕获规范 Vault 路径与目录身份，并取得与选择器相同的独占许可。现有私有 opener 在打开和查询名称前验证精确 provider，拒绝未知 provider、本应用/共享 UID 与跨资料用户前缀；使用只读 `openFileDescriptor`，保留完整文件/pipe 语义，不丢弃 AssetFileDescriptor 的子区间。提供器 I/O 在现有有界线程池执行；FD 转交继续使用既有 detach/resolve 所有权规则，返回后由 Rust `File` 管理。

空邮箱不会创建暂存目录或启动后台工作。真正领取到文件后，单个宿主拥有者保留 FD、许可、临时目录和既有后台 transfer 租约直到复制与入库真实完成；调用页面销毁不提前删除仍在复制的文件，也不把已开始的入库宣称为取消。暂存继续复用原生选择器的 64KiB 分块、前 1024 字节 PDF 标头检查、严格 256MiB 单文件与 1GiB 批次实际读取预算，不整份读入 WebView、不要求 Seek。显示名只作为受限文件名；提供器名称中的不成对 UTF-16 surrogate 会在原生 JSON/FD 返回前被省略，合法 emoji 配对保留，避免可选元数据破坏 JNI 解码。标题继续由原有入库/后续识别策略处理。

暂存前及提交前再次核对 Vault 身份，复用同一个导入内核、去重、Catalog 写入与准备计划。旧页面的迟到结果不刷新新文献库或弹出错误。系统打开成功入库后只刷新文献库，不自动切走正在阅读/编辑的文档，不替换未保存草稿，也不打开 Agent 侧栏；用户从文献库选择论文阅读。该行为不等于多窗口文档打开，也未增加 Agent 请求或未知远程操作重放。

## 验证边界

原生纯 JVM 策略检查覆盖动作/MIME、URI 与授权、相同/不同 ClipData、文本和 stream 拒绝，以及邮箱的单次领取、容量、清理与冷暖启动顺序。它们不模拟 Binder 授权或提供器。Rust 复用的标头、流式上限、私有暂存及 Vault 身份检查继续回归；新增拥有者检查在等待点丢弃调用接收者，确认真实操作结束前许可与临时目录仍有效。事件契约断言唤醒序列化为 null，不含文档字段。

前端检查覆盖监听先于领取、空邮箱无重复请求、共享准入锁、隐藏/忙碌时唤醒合并、卸载和旧文献库迟到结果隔离。本轮 16 项前端交接检查通过；移动端/PDF 回归共 1262 项通过、10 项既有跳过，TypeScript 与依赖图（1478 模块、8116 边）通过。Rust 插件 4 项、原生暂存/所有权 10 项、事件契约 10 项、移动命令登记及严格 workspace/all-targets Clippy 通过，绑定已生成；随后宿主全套 929 项中 919 通过、10 项既有外部环境用例忽略，包含绑定只读比对与事件契约。Android 插件与应用 Kotlin 重新编译、58 项 JVM 检查通过。完整端到端还需设备验证：文件管理器/邮件/云提供器的读取授权、冷启动、已在前台时再次打开、拒绝与取消、任务被关闭后的授权失效，以及实际入库后的文献库显示。当前无连接设备，不能以编译和纯策略检查替代这些验收。iOS 文档打开与系统分享、多份/文本分享均仍在后续范围。

参考：

- [Tauri Android Plugin 的公开生命周期](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.5/crates/tauri/mobile/android/src/main/java/app/tauri/plugin/Plugin.kt)
- [Tauri deep-link 插件的冷启动与 onNewIntent 处理](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/deep-link/android/src/main/java/DeepLinkPlugin.kt)
- [Android 临时 URI 读取授权](https://developer.android.com/training/secure-file-sharing/share-file)
- [Android ACTION_VIEW](https://developer.android.com/reference/android/content/Intent#ACTION_VIEW)
