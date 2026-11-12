# 平台后台适配

平板后台由 Rust 持有任务与计数，原生层提供 OS 能力和实际状态。iOS 不提供常驻申请或伪保活令牌；远端 Agent 任务不依赖平板连接继续运行。

## 原生边界

本地插件 [agentero-mobile](../../src-tauri/plugins/agentero-mobile/src/lib.rs) 仅在移动端注册，采用仓库锁定的 Tauri 2.12.5 公开 `PluginHandle::run_mobile_plugin_async` 和原生 Plugin 桥。WebView 不直接访问原生命令；应用的生成绑定与命令白名单负责 UI 契约。后台状态明确区分能力、用户开启、通知许可、系统前台状态和实际运行中的服务。

共享分支初始原生桥严格返回未实现、不支持的能力；Android / iOS 分支各提供自己的实际适配，不把缺失适配当作成功。内部方法为 `readState`、`configure`、`requestNotifications`、`openSettings`、`apply`；最后一个只接受 Rust 持有的 Agent / 同步 / 传输计数，不接收提示词、标题、主机信息或正文。只读查询不申请权限。

Android 使用独立的 Agent `specialUse` 与同步/传输 `dataSync` 服务；用户主动开启，新的服务只能在可见时启动，划掉任务和通知停止动作结束本机服务。iOS 仅给同步与传输提供系统允许的短时收尾窗口，Agent 计数不申请窗口。具体实施和设备边界由各平台分支的方案记录，接口见[平板共享方案](../development/tablet-shared.md)。

## 选型

对比 [tauri-background-service](https://github.com/dardourimohamed/tauri-background-service) 的通用常驻 actor、自动恢复与单服务策略后，本项目采用系统 API 的薄适配器：需要两种独立计数服务、划掉即停止、默认不自动恢复、iOS 不承诺常驻。桥与权限组合复用 [Tauri 官方移动插件接口](https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/Plugins/develop-mobile.mdx)；本地 SDK 和官方 dialog 2.7.2 的 Android/Swift 包装用于核对准确的生成和调用约定。没有复制 AGPL 的 DSH Go 实现。
