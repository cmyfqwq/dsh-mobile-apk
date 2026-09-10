# scripts/patches/ — vendor 固化插件统一补丁模块（Phase 2a，2026-09-05）

快照注入链全部 vendor 补丁的**唯一入口**。此前补丁散落 `patch-marketplace.mjs`（A-D）与 `patch-undo-mobile.mjs`（E1-E7）两份脚本、双仓各一副本，漂移风险实锤（apk 仓副本曾缺补丁 C/D，云端构建产出缺补丁 APK）——本目录将其统合为一框架。

## 组成

| 文件 | 职责 |
|---|---|
| `apply-patches.mjs` | 唯一 runner：`--check`（门禁验证）/ `--apply`（幂等施加+自验）/ `--list` / `--only` |
| `registry.json` | 补丁登记表：id / 目标文件 / 摘要 / 来源（issue、PRD）/ 幂等标记。与 runner 内 IMPLS **一一对应**，启动时交叉校验，漂移即拒 |
| `data/compat-map.json` | 补丁 D 的兼容性数据（COMPAT_MAP/NOTE）。增补别名只改此文件，`--apply` 对已修补文件做 map 幂等刷新 |
| `README.md` | 本文档 |

## 补丁清单（详见 registry.json）

- **dshmarketplace-plugin 0.1.5**：A pre-execute 守卫（全工具崩溃）、B execPath 安全化（apk#83/#89 bad ELF magic）、C 不可安装置灰（soft：锚点失配仅告警不拒打包）、D 移动兼容徽章 + `mobile:` 过滤（server/client 两侧）
- **dsh-undo-savepoint 0.3.8**：E1-E7 移动端裁剪（头部只留快照徽章、移除快捷键行与全局键盘监听、徽章宽度封顶）

## 用法

```bash
# 构建门禁（build-apk-013.ps1 / build-apk.mjs 已接入；默认 ensure 语义=缺席即施加）
node scripts/patches/apply-patches.mjs vendor

# 只验证不写（严格门禁）
node scripts/patches/apply-patches.mjs vendor --check

# 列出登记表
node scripts/patches/apply-patches.mjs vendor --list
```

## 新增补丁流程

1. 在 `apply-patches.mjs` 的 `IMPLS` 加实现（`file` / `check(src)` / `apply(src)`；apply 抛错 = 锚点失配拒写）；
2. 在 `registry.json` 加同 id 条目（摘要 + 来源登记）——漏加即启动交叉校验失败；
3. 跑 `--apply` 验证幂等与自验；锚点用**足够长的唯一字符串**（minified 代码短锚点易误伤）；
4. 双仓同步（铁律）：本目录整体镜像到 `dsh-mobile-apk/scripts/patches/`；
5. 两仓 AGENTS.md 更新记录表登记。

## 锚点失效处置

`--apply` 报「锚点未命中」= 上游 minified 代码形态已变：从报错附带的上下文片段人工核对新形态 → 更新 IMPLS 锚点与 registry marker → `--apply` 重放。禁止为了过门禁放松 check 语义。

## 历史

- 2026-09-05 Phase 2a：统合 patch-marketplace.mjs（A/B/C/D）+ patch-undo-mobile.mjs（E1-E7）为本模块，旧脚本删除；双仓 scripts 同版（雷点 10）。
## 2026-09-10 追上游 0.1.5-rc.1 的补丁增减

- **退役 pi-drift-F1**：上游 0.1.5 的 dsh-llm-pi-ai 原生实现了同类容错——
  resolveRouteModels(request, validation) 与 resolveProfiles(providers, validation) 增加
  strict/deferred 双模（写严格、读宽容）：未知 modelOverrides id 记入 modelErrors 诊断而不抛错，
  非严格路径下 PiAiCatalogError 被捕获后只跳过该 provider（0.1.5 lib/index.js:633/646/1051/1086-1099）。
  F1 的三处 invalid() 降级与 skipped 标记失去了锚点，也不应再用补丁覆盖上游的原生行为。
- **保留并已对齐 0.1.5 锚点**：attach-durable-F2（祖先 fsync 守卫）、boot-pending-G1（3 处）、
  pi-toolcall-G2（4 处）——均在 0.1.5-rc.1 产物上验证命中。
