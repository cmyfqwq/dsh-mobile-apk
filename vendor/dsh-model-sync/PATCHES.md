# dsh-model-sync — vendor 固化副本（0.13.3 W7）

- **来源**：社区插件 `@aiwayds/dsh-model-sync` 0.3.1（npm，MIT License，作者 fliu56，
  github.com/fan56/dsh-model-sync）。本目录为其 lib 产物固化副本（去 sourcemap），
  与 `dshmarketplace-plugin`/`dsh-undo-savepoint` 同款 vendor 模式。
- **为什么 vendor 而非市场安装**：模型同步是 0.13.3 拍板的结构性工作（决策台账 D4-P3/D5），
  必须随快照出厂在场、不依赖用户手动安装；pi.dev 目录漂移防护三件套的第三件。
- **交互模型（ZCode 式隐式补给，用户拍板 D5）**：
  - 启动 +5s 首跑 + 默认 240 分钟定时轮 + 设置变更重臂（`scope.watch`）。
  - settings 模式（默认）：fetch pi.dev 目录 → 翻译（容量 sanity / reasoningEfforts S2 门 /
    compat S5 门 / base-matching 分类）→ `settings.mutate` 写回 llm-pi-ai
    （revision + SETTINGS_CONFLICT 冲突重试 + modelOverrides 互斥折叠 + models-store 重放）。
  - 静默自动写：字段级 merge，用户显式值（displayName/apiKeyEnv/api/baseURL/models 字段）永不
    被覆盖；失败只落 logger，不弹 UI、不抛会话错误。
  - 四级降级管线：pi.dev 目录 →（未来 models.dev）→ 引擎内建 discovery → 跳过（本版取首尾）。
  - 可选审查面：`/model-sync` 斜杠命令（经 dsh-commands registry，若宿主提供）。
- **与上游 0.3.1 的差异**：无代码改动（逐字节 lib 副本，仅去 .map）。配置经
  `model-sync` settings 命名空间（settings.yaml 可覆写 managedRoutes/intervalMinutes 等）。
- **引擎兼容锚点**：依赖 `settings.describe()` 的 `user.providers` 形态与
  `settings.mutate` revision 语义（dsh-settings 0.1.2-rc.1）；`llm-pi-ai` 命名空间
  validate 链的目录强校验由 W4 pi-drift-F1 降级补丁兜底（显式列表不可服务时降级为
  「该模型缺席」而非整包拒绝）——两者互为犄角，缺一不可。
- **Android 路径注意**：models-store 落 `HOME/.dsh/models-store.json`（引擎 shellEnv 的
  HOME=files/home，插件 `homedir()` 直读即可）；断网/404 时静默保留 last-good（零破坏）。
