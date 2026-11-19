# 开发草稿

本目录只放：

1. **工程规划**（版本切片、发布）
2. **尚未实现**的功能设计稿，以及仍要对照实现的设计记录

已实现功能的说明在 [`../frontend/`](../frontend/index.md) 与 [`../backend/`](../backend/index.md)，按功能分篇。

较大的设计改动先在 GitHub 开 [RFC issue](https://github.com/poco-ai/Agentero/issues/new?template=rfc.yml) 评审，结论收敛后再把设计稿落到本目录。

## 未实现草稿

| 文档 | 主题 |
|---|---|
| [android-stylus-oppo-xiaomi.md](android-stylus-oppo-xiaomi.md) | OPPO 优先、小米其次的论文阅读手写笔方案：原生笔迹层、OPPO 官方笔端书写触觉、厂商动作、压感与真机验收。**设计稿，未实施** |
| [vault-sync-review.md](vault-sync-review.md) | Vault 同步审计与实施记录：五个反例、修复策略、落盘恢复及验收边界。 |
| [rfc-scholarly-data-resolution.md](rfc-scholarly-data-resolution.md) | 学术数据解析与补全 RFC：来源编排、身份与字段证据、venue、PwC、机构 PDF 获取边界。**设计稿，待评审** |
| [usage-analytics.md](usage-analytics.md) | \#239 Activity 总线。P0 存储已落地：XDG `usage.sqlite`（见 [../backend/usage.md](../backend/usage.md)） |
| [decision-layer.md](decision-layer.md) | 通用决策层：规则 / System One（jEV/Clef）/ LLM 统一为可插拔 provider + routing。**已落地**（见 [../backend/decision.md](../backend/decision.md)），保留为设计记录 |
| [A2A.md](A2A.md) | 第一版是本机 Agent 经已连接的远程 Vault SSH 委派远端 CLI Agent。完整 Agent Card + Task 仍是草稿 |
| [tablet-shared.md](tablet-shared.md) | 平板端（Android 平板 / iPad）实施方案的共享部分（在 `mobile` 分支维护）：本地 Vault、同步、可扩展远程 Agent、手写、多窗口；仅 Android 申请后台常驻。平台篇 `tablet-android.md`、`tablet-ios.md` 分别在 `android`、`ios` 分支。**开发中**，完成范围与未验收项见共享篇实施进度表 |
| [tablet-ios.md](tablet-ios.md) | 平板端实施方案的 iOS / iPadOS 篇：工程配置、存储与 Keychain、后台任务、分屏与多窗口、Apple Pencil、发布。**开发中**，实际完成范围见平台篇开头 |

macOS 签名与公证（已实现流程说明）在 [`../test/macos-signing.md`](../test/macos-signing.md)。

LaTeX 写作与构建能力已落地，项目设置、依赖自动编译、统一底部问题列表、写作问题卡片与日志对话框、SyncTeX、项目补全与大纲见 [`../frontend/latex.md`](../frontend/latex.md)；本机工具链及边界见 [`../backend/latex.md`](../backend/latex.md)。文件树入口与源码、预览一体的项目编辑区见 [`../frontend/writing.md`](../frontend/writing.md)。

本目录没有单独的 Roadmap / TODO 文件：未决项按能力记在对应已实现文档的「限制与后续」里。内置 provider（翻译 / embedding / 正文 OCR）的未决清单——`⟦n⟧` 占位符透传待真实 key 验证、Hunyuan-MT 模板空格待 A/B、目标语言从 en/zh-CN 扩到 37 种、把内嵌 key 换成网关签发的 per-install activation token——在 [`../backend/builtin-provider.md`](../backend/builtin-provider.md) §限制与后续。
