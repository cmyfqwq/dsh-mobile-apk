# AGENTS.md — dsh-mobile-apk 开发地图（索引主文件）

> **AI 主动更新条款（必须最先执行）**：本文件是唯一权威入口，采用「主文件索引 + docs/AGENTS/ 详档」结构。**任何代码变更导致描述失真时：① 主文件对应行当轮更新；② 细节写入 docs/AGENTS/ 对应详档（坑→gotchas.md 追加递增编号；版本历史→更新记录表登记，3 条之前的行滚入 changelog-archive.md）。** 若发现文档与源码不一致，以源码为准并当场修正。**查询规范：优先用 grep 在 docs/AGENTS/ 详档内定位（见下方路由表），不要凭记忆猜细节。**
>
> **过期风险声明**：代码演进可能快于文档更新；一切以源码为准。

---

## 1. 仓库概览

- **角色**：DeepSeek Harness 安卓壳应用（`com.dsharnessmobile.shell`）。职责边界 = 只保留安卓平台权能与桥（前台服务/看门狗/WebView/SAF 桥/快照解压/UndoGate/ADB 授权/审计/控制台/日志）；**AI 可见能力全部来自插件**。
- **运行时形态**：内嵌 Termux 快照（`assets/snapshot.tar.xz` → files/usr + files/home）；引擎 `@deepseek-ai/dsh` **0.1.2-rc.1**（0.13.3 起构建期 overlay；/api 全前缀浏览器鉴权——壳侧 EngineAuth 带 Cookie）监听 127.0.0.1:3080；WebView 加载引擎 Web UI。
- **构建链**：minSdk 26 / targetSdk 34 / compileSdk 36；Kotlin 2.0.21；AGP 8.8.2；Java 17。
- **版本状态**：**0.13.3 开发中（vc30；引擎升级/鉴权/MuxClient 重做/文件引用重构/W1-W10 代码面全绿；回归与 push/PR 待用户口令）**。0.13.2 已发布（vc29，悬浮球 v2.1 全套）。当前开放跟踪：#115（市场 Phase2）、#108（数据备份）。
- **兄弟仓库**（协调仓子目录，本仓内含自包含副本——**坑 36 同步铁律**：协调仓改子仓源码/bump 版本后必须 robocopy 镜像到本仓，lib/ 产物一并拷）：`dsh-shell-termux`、`dsh-client-ui-responsive`（0.1.13）、`dsh-host-web-compat`（0.1.9）、`plugins/`（bridge 0.1.4 / manage / linux-env / file-open）、`vendor/`（marketplace、undo-savepoint、dsh-model-sync + PATCHES.md）。
- **上游** deepseek-ai/deepseek-harness（协调仓 `dsh/` 只读 checkout）：**零改动**；一切适配走补丁/插件/壳侧。

## 2. 构建命令速查（在协调仓根执行）

```powershell
pwsh -File scripts\build-apk-013.ps1 -Suffix ""   # 一键双 ABI（门禁失败即拒打包）
pwsh -File scripts\build-apk-013.ps1 -Fast        # dev 快速档（单 ABI x86_64 + preset 1；产物禁发布）
node scripts\build-snapshot-013.mjs <arm64|x86_64> # 快照构建（Windows 需 WSL）
node scripts\smoke-bridge.mjs                      # bridge 冒烟
adb -s <serial> install -r -t out\v<版本>\...apk    # 装机（同签名 debug keystore）
```

门禁链：统一补丁 → 引擎 overlay 抽验（check-engine-overlay）→ 单 pass 注入 → 挂载集 → 机密 → third-party → elf-check → gradle。云端自包含构建：`.github/workflows/build-apk.yml`。

## 3. 高频雷点 TOP（一行一条；全量 42 坑 grep docs/AGENTS/gotchas.md）

- **坑 37**：快照重解压中（~8-12 分钟）**禁 force-stop/杀进程**——唯一完成标志 = `.snapshot-fingerprint` 翻转 + `.dsh-backup` 消失；中途杀 → 看门狗拉半解压运行时剪掉用户配置。
- **坑 18/30**：debug 包默认 x86_64 快照装 arm64 必崩；真机安装只用 ps1 对应 ABI 命名产物。
- **坑 19**：真机改 cordis.patch.yml 后必须冷启动 app（force-stop + start）才重装配。
- **坑 33**：壳侧所有本地引擎调用一律 `Proxy.NO_PROXY`（系统代理劫持探针）。
- **坑 38**：运行时补丁升级引擎时必须逐个核对（rc.2 锁定 asset 会抹掉新引擎代码——0.13.3 prompt 阻断实锤）。

## 4. 详档路由表（grep 形式查询）

| 要查什么 | grep 建议 | 文档 |
|---|---|---|
| 坑 N 详情/新坑登记 | `grep -n "^38\.\|^39\." docs/AGENTS/gotchas.md` 或按关键词（`borrowSession`/`store-rehome`/`MANAGE_EXTERNAL_STORAGE`/`run-as`/`overlay`） | docs/AGENTS/gotchas.md |
| 某 .kt 文件职责/函数位置 | `grep -n "<文件名>.kt" docs/AGENTS/modules.md` | docs/AGENTS/modules.md |
| 桥方法签名/通道语义 | `grep -n "<方法名>" docs/AGENTS/BRIDGE-API.md`；0.13.3 增量 grep `pickFilePath\|remote.mux\|EngineAuth` docs/AGENTS/bridge-api.md | docs/AGENTS/bridge-api.md |
| 构建失败/门禁/环境差异 | `grep -n "门禁\|WSL\|abi" docs/AGENTS/build-and-env.md` | docs/AGENTS/build-and-env.md |
| 运行时补丁（assets/patched） | `grep -n "patched\|applyAssetPatch" docs/AGENTS/RUNTIME-PATCHES.md` | docs/AGENTS/RUNTIME-PATCHES.md |
| 35 模块地图/依赖方向 | `grep -n "模块\|依赖" docs/AGENTS/ARCHITECTURE.md` | docs/AGENTS/ARCHITECTURE.md |
| android.* API 清单/守卫点 | `grep -n "API 等级\|android\." docs/AGENTS/ANDROID-API-USAGE.md` | docs/AGENTS/ANDROID-API-USAGE.md |
| gradle 依赖与升级策略 | `grep -n "依赖\|升级" docs/AGENTS/DEPENDENCIES.md` | docs/AGENTS/DEPENDENCIES.md |
| GPL 合规三形态 | `grep -n "copyright\|LICENSES" docs/AGENTS/gpl-compliance.md` | docs/AGENTS/gpl-compliance.md |
| 待办与已知缺口 | `grep -n "F[0-9]\|未实现" docs/AGENTS/known-gaps.md` | docs/AGENTS/known-gaps.md |
| 版本历史 | `grep -n "0.13.2" docs/AGENTS/changelog-archive.md` | docs/AGENTS/changelog-archive.md |

## 5. 更新记录表（最近 3 条；完整历史 docs/AGENTS/changelog-archive.md）

| 时间 | 版本 | 更新内容 | 更新者 |
|---|---|---|---|
| 2026-09-06 | 0.13.3 | **0.13.3 开发批落地（W1-W10）**：壳侧 EngineAuth（P0/P1）/MuxClient remote.mux/setTextZoom 退役/vc30；构建链 overlay+抽验门禁+pi-drift-F1+model-sync；ui-responsive 0.1.13（store-rehome 适配：client-store 内联 + slots-augment + RUNTIME_STORE_EXEMPTION 退役——rc.1 loader module table 不再应答 client-runtime require 的 boot 硬阻断修复）；host-web-compat 0.1.9（withResolvers + 引用文件按钮）；运行时补丁重出（SPJ/ATT rename 回退）与退役（fs-local/primitives）；AI 实测 read 工作目录外文件 PASS | AI 开发助手 |
| 2026-09-06 | 0.13.3 | **AGENTS 结构改造（用户拍板）**：主文件瘦身索引 + docs/AGENTS/ 详档（gotchas/modules/build-and-env/bridge-api/gpl-compliance/known-gaps/changelog-archive + Phase 4 五文档迁入）；grep 形式查询路由表；新坑 38-42 登记 | AI 开发助手 |
| 2026-09-06 | 0.13.2-fix | **Phase 5 终包回归收官**：双模拟器终包探活双 200、零 FATAL；F8 dumpsys 实证球窗 z 序/中心重合；F9 任务移除=完整关闭；报告 docs/PHASE5-REGRESSION-2026-09-05.md | AI 开发助手 |
