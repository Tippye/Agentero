# 无条件写存储的可选降级同步（设计稿）

2026-11-20 · 状态：**一期已实现并验证** · 触发案例：fnOS 自带 WebDAV（FN Connect `dav.*.fnos.net` 端点）忽略 `If-Match` / `If-None-Match`，连接测试通过但首轮同步被 `engine.rs` 的条件写硬拦截停（"remote does not enforce conditional writes"）。现行协议与安全边界见[同步说明](../backend/sync.md)，硬拦截的由来见[同步审计](vault-sync-review.md) A 项（P1：两台设备并发无条件覆盖 HEAD → 输家新增笔记被误判为远端删除而从磁盘消失）。

**已确认决策**：① 一期仅 WebDAV（S3/OSS 二期）；② opt-in 后允许自动同步，警告卡片常驻；③ 手动「远端覆盖本地」丢弃的本地内容**直接丢弃、不存冲突副本**，执行前弹确认窗预览影响（见下节）。

## 目标与非目标

**目标**：在用户**显式 opt-in** 的前提下，让忽略条件头的 WebDAV 服务器（fnOS 自带 WebDAV、hacdias/webdav 等）也能同步；默认行为不变（探测失败仍硬停）；不重新引入 P1 的删除丢失。

**非目标**：不改远端布局与格式；不动 Git / 官方云后端（它们自带原子性）；不做多绑定；不承诺无条件写存储上的严格线性一致。

## 参考实现与取舍

| 项目 | 做法 | 对本方案的取舍 |
|---|---|---|
| [Joplin 同步锁规格](https://joplinapp.org/help/dev/spec/sync_lock/) | 锁文件写在同步目标上；**确定性仲裁**：列出锁文件，最旧的有效锁获胜，同时间戳比 clientId；TTL 过期可被忽略；自己的锁过期 ⇒ 取消当前操作 | 采纳其仲裁与 TTL 思路。差异：Joplin 的 SYNC 锁允许多个并存（条目级模型），Agentero 只有一个可变 HEAD，需要**排他**的发布锁；但持锁窗口只有 3–4 个请求，不需要 Joplin 的周期刷新机制 |
| [super-productivity #8960 / #9004](https://github.com/super-productivity/super-productivity/issues/8960) | 实测 WebDAV 的 check-then-write（GET 比对后无条件 PUT）存在 GET→PUT 竞争，会静默覆盖并发客户端已确认的写入；修复为有强 ETag 时真 `If-Match`，否则退化为内容哈希比对 | 证明**纯 check-then-write 不可作为安全依据**。本方案的 read-back 校验只作兜底探测，主互斥靠发布锁 + 既有 fork 合并 |
| [remotely-save + fnOS FN Connect 实测](https://subk.me/?p=717) | FN Connect 公共中继对瞬时并发限频，concurrency=5 引发假性 401 / 连接重置；concurrency=1 才稳定 | Agentero WebDAV 上传本就是串行循环（`upload_missing`），保持不变；锁请求也串行。这是 fnOS 场景的硬约束 |
| Agentero 既有安全网 | fork 合并（无共同祖先时按新增/编辑合并，**不推断删除**）、冲突副本、恢复日志、按 manifest key 的空转短路、`sync_remote_history_missing` 守卫 | 全部保留。`engine.rs` 注释已明确这些机制让 plain-PUT 分叉"收敛而不丢本地数据"——降级模式站在它们之上，而不是替掉它们 |

**为什么不用 MKCOL 做互斥锁**：MKCOL 对已存在集合返回 405 在 RFC 4918 里有规定，但 fnOS / FN Connect 未实测；且部分服务器拒绝 DELETE 非空集合，锁目录清理多一步。Joplin 式仲裁只需要 **PUT + PROPFIND**，两者在 fnOS 上均已验证可用（`ensure_root` 走 PROPFIND，probe 的试写走 PUT）。

**为什么不用"单设备模式"（无锁、仅靠 fork 合并）**：fork 合并能防 P1 的删除丢失，但两台设备自动同步（默认 30 分钟间隔）并发发布仍是大概率事件，会持续产生冲突副本与版本回退噪声。锁把并发发布压到极小概率，成本只是每次发布 ~4 个请求。

## 协议设计（仅降级模式）

### 不变量

- blob 内容寻址、manifest key 唯一随机 → 普通 PUT 幂等无害，直接去掉条件头；上传顺序、串行执行、`pushed.jsonl` 续传全部不变。
- fork 合并、冲突副本、恢复日志（intent → apply → publish → accept）、空转短路、history-missing 守卫原样保留。
- 探测 `probe_conditional_writes` 不变，仍测服务器真实行为。

### 发布锁（只保护 HEAD 发布窗口）

1. **锁文件**：`locks/<deviceId>-<nonce>.json`，内容 `{ deviceId, acquiredAt }`。`deviceId` 为每设备持久化 UUID（`.agentero/sync/device.json`，新增）。扁平文件，不依赖 MKCOL。
2. **获取**：PUT 自己的锁文件 → `PROPFIND Depth:1` 列出 `locks/` → 仲裁：按服务器 `getlastmodified` 排序（缺失时回退内容里的 `acquiredAt`），**最旧的有效锁获胜**，同时间戳按 `deviceId` 字典序。赢家是自己 ⇒ 持锁；否则 DELETE 自己的锁文件，抖动退避后重试（≤5 次，复用 `MAX_CAS_RETRIES` 量级），仍失败 ⇒ 报"同步 contention"类错误，下轮再来。
   - 用服务器 mtime 排序意味着**单一时钟**，规避客户端时钟偏移；1 秒粒度造成的平局由 deviceId 确定性打破。两个客户端同秒 PUT 后各自列表，算出同一个赢家。
3. **持锁窗口**：重新 GET HEAD → 若与合并基线不同 ⇒ 释放锁、在锁外重合并/补传、重新获取（复用现有 CAS 重试循环的形状）→ 普通 PUT HEAD → **GET read-back 校验**（内容 ≠ 所写 ⇒ 按 CAS 输家处理，走既有重试）→ DELETE 自己的锁文件（尽力而为）。
4. **TTL 90s，不刷新**：持锁窗口只有 3–4 个请求，正常远低于 TTL；PUT HEAD 前若发现已持锁超过 TTL ⇒ 放弃本轮（Joplin 规则：自己的锁过期 ⇒ 取消，因为期间他端可能已做使缓存失效的操作）。崩溃残留的锁过期后可被抢占，无需人工清理。
5. **合作者假设**：降级模式的所有 Agentero 客户端都遵守锁；正常模式客户端被探测拦停、根本不会写这个 store，因此不存在混合协议写者。其他应用写同一目录不在保护范围（同步目录是应用私有的）。

### vault.json 首次接触

`ensure_remote_identity` 的 create-if-absent 退化为普通 PUT + **GET read-back 比对 vaultId**；不一致 ⇒ 硬错误"remote store belongs to a different vault"。残余竞争窗口（两个不同 vault 同时绑定同一空目录）文档化：后果是绑定错误而非文件丢失，下一轮对账即暴露。

### 模式判定

```
probe 成功                        → 现行 CAS 协议（不变）
probe 失败 && allow_degraded_sync → 降级协议（本节）
probe 失败 && 未 opt-in           → 现行硬停（改 domain code + i18n，见下）
```

`allow_degraded_sync` 是**每设备**配置（`sync.json` 按设备存）：每台设备都要单独打开。UI 风险文案必须写明这一点。

## 配置、IPC 与 UI

- `SyncBackendConfig.allow_degraded_sync: bool`（`serde(default)` false）。改 bindings 类型 ⇒ 按仓库规则重新生成 `src/lib/core/bindings.ts`（`AGENTERO_UPDATE_BINDINGS=1 cargo test -p agentero export_typescript_bindings`）；事件 payload 不变，`events_contract` 仍需跑。
- **设置页同步 pane**（桌面 / 移动共用）：探测失败时把现在的被动小字提示升级为警告卡片 + 显式 Switch「允许降级同步」+ 风险说明（可能产生冲突副本、已删除文件可能复活、仅用于自己控制的存储、所有设备都需开启）。开关随 `syncConfigure` 持久化。opt-in 后自动同步照常运行，警告卡片常驻。
- **硬停错误本地化**：`engine.rs` 该错误改 `AppError::domain("sync_no_conditional_writes", …)`；前端 `reportSyncError` 与 `syncState` 监听器映射到现有 `sync.noConditionalWrites`（en / zh-CN 文案已存在，无需新增 i18n 键）。
- **CLI**：`agentero sync configure` 暴露同名 flag（`cli/src/commands/sync.rs`），语义与桌面一致。
- **依赖**：锁列表需要解析 PROPFIND multistatus（href + getlastmodified）。core 新增 `roxmltree`（src-tauri 已用 0.20，成熟小依赖），只解析这两个字段，不做通用 XML 层。

## 风险与边界（opt-in 即视为接受）

| 风险 | 后果 | 缓解 |
|---|---|---|
| 仲裁 best-effort（列表不一致、mtime 缺失回退客户端时钟且偏移大） | 并发 HEAD PUT → 分叉 | fork 合并收敛、不推断删除；read-back 校验触发重试；最坏产生冲突副本 |
| 分叉合并的保守性 | 他端合法删除的文件可能复活 | 冲突副本可见、可手动清理；文档与 UI 明示 |
| 服务器不支持 PROPFIND Depth:1 / getlastmodified | 锁无法仲裁 | 降级模式启用前用一次性探测验证（列入实施 checklist，fnOS 需实连确认） |
| 非合作写者（其他应用、旧版 Agentero 手工绕过） | 不受锁保护 | 同步目录应用私有；旧版被探测拦停，天然不写 |
| FN Connect 中继限频 | 假性 401 / 重置 | 全程序串行（现状已满足）；锁仅 +4 请求/发布 |

**分期**：一期仅 WebDAV（trait 加默认"不支持"的发布锁方法，WebDAV 实现）。S3 无条件写后端（OSS）可用 ListObjectsV2 的 LastModified 复用同一仲裁，列二期；孤儿锁/旧 manifest 回收亦列二期。

## 测试计划

- **本地单元测试（按仓库规则不提交）**：内存 store 忽略条件头 + 模拟并发发布者——断言收敛、无删除丢失、分歧编辑产生冲突副本、仲裁赢家一致、过期锁抢占、read-back 校验捕获竞争、TTL 超期放弃本轮。
- **实连验证**：扩展既有 ignored `two_device_roundtrip_against_webdav`，加 `AGENTERO_SYNC_WEBDAV_TEST_DEGRADED=1` 变体；由用户以本人 fnOS 凭据通过环境变量运行（凭据不进仓库）。重点实测 fnOS 的 PROPFIND Depth:1 / getlastmodified / 锁文件 PUT-DELETE 行为。
- 提交前：`cargo test -p agentero export_typescript_bindings`、`cargo test -p agentero app::events_contract`、`pnpm typecheck`、`pnpm deps:check`，及 `features::sync` 既有测试。

## 手动覆盖（远端覆盖本地 / 本地覆盖远端）

与降级模式同期实现的独立能力：**所有对象存储后端**（S3 / WebDAV / 官方云；Git 拒绝，用它自己的命令）都提供两个手动方向，作为合并结果不符合预期时的逃生门。

| 方向 | 语义 | 发布 |
|---|---|---|
| `remoteToLocal`（force pull） | 本地文件完全对齐远端 HEAD 清单：下载远端独有、还原被修改、**删除本地独有**。被丢弃的本地内容直接丢弃，不存冲突副本（用户显式选择）。尊重下载策略：按需类别保持虚拟，分歧的物理字节删除转虚拟。 | 不发布新版本；采用远端 HEAD 为基线（复用 adopt 路径与恢复日志） |
| `localToRemote`（force push） | 本地全量扫描发布为新 HEAD（version + 1）。远端独有文件移出清单，其他设备下次同步经正常三方合并推断删除。本地无任何改动，故不需要恢复日志。 | 正常模式走 CAS；降级模式走发布锁 + 普通 PUT + read-back |

- **影响预览**：`overwrite_preview` 只读计算 `{willDeleteLocal, willDownload, willRemoveRemote, willUpload, remoteVersion}`，不写本地（不 flush sidecar）、不写远端、不做 store 绑定 / recovery resume。
- **确认**：设置页弹窗展示预览计数 + 破坏性说明，确认按钮 destructive 样式；CLI 先打印预览再 `prompt::confirm`（非交互需 `--yes`）。
- **可恢复性**：force push 天然可恢复——旧 manifest 与 blob 仍在远端（GC 前）；force pull 的丢弃不可恢复，靠确认弹窗防误触。
- **入口**：设置页同步 pane 两个 outline 按钮（绑定已保存且无未保存草稿时显示）+ `agentero sync overwrite <remote-to-local|local-to-remote>`。IPC：`sync_overwrite_preview` / `sync_overwrite`（新命令，bindings 重生成；复用 `sync:state` / `sync:progress` 事件，无新事件）。
- 执行持 Vault 锁与进程内 lease，失败记入 `last_error`，与普通 pass 一致。

## 待确认

（已全部确认，见文首决策。）

## 验证记录（2026-11-20）

- **实连正常模式**：Docker `httpd:2.4` + `mod_dav` + `FileETag Digest`（强制 `If-Match`），`two_device_roundtrip_against_webdav` 全流程通过（探测 `conditional writes: true`，发布/加入/编辑/分歧冲突/收敛）。
- **实连降级模式**：Docker `ghcr.io/hacdias/webdav`（忽略全部条件头，复现 fnOS 行为），`AGENTERO_SYNC_WEBDAV_TEST_DEGRADED=1` 全流程通过（探测 `conditional writes: false`，发布锁 + 普通 HEAD PUT + read-back，分歧冲突收敛、无删除丢失）。
- **单元**：`cargo test -p agentero-core --lib features::sync::` 117 通过 / 1 失败 / 2 忽略；唯一失败 `config::tests::simultaneous_configuration_updates_keep_both_vaults` 为既有环境问题（沙箱下测试子线程写 tempdir 被拒，os error 5），与本次改动无关。新增降级/覆盖/探测内存测试与 webdav 锁仲裁纯函数测试本地通过后按政策移除，未提交。
- **契约与前端**：`export_typescript_bindings`（重生成）、`app::events_contract`（10 通过）、`pnpm typecheck`、`pnpm deps:check`、`cargo check -p agentero-cli` 均通过。
- **顺带修复**：`upload_missing` 上传保留冲突副本时改读副本文件本身——apply-before-publish 时序下源文件已被远端版本覆盖，旧逻辑读源文件导致哈希不符（`changed during sync`）；该 bug 在正常模式同样潜伏，实连分歧冲突步骤暴露并修复。
- **探测修正**：`probe_conditions` 门槛改为 `If-Match` CAS（安全关键保证），不再要求 `If-None-Match` 也被强制——坚果云（忽略 `If-None-Match`、强制 `If-Match`）恢复为正常模式；`vault.json` 创建后一律 read-back 比对堵并发创建竞争。