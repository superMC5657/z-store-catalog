# AGENTS.md

本仓库是 Z-Store 的公共应用清单（`catalog.json`）与维护脚本。任何代理或贡献者动手前先读这一页。

## 常用命令

- 编译汇总清单：`node scripts/build-catalog.mjs`（`apps/` -> `catalog.json`）
- 校验（CI 同款，提交前必须通过）：`node scripts/validate-catalog.mjs`
- Issue payload 预演：`node scripts/ingest-issue.mjs --body-file issue.md --dry-run`
- 运行单测：`node --test scripts/ingest-issue.test.mjs scripts/build-catalog.test.mjs scripts/showcase.test.mjs`
- 编译自荐清单：`node scripts/build-showcase.mjs`（`showcase/` -> `showcase.json`；`--prune` 下架到期 / 转正，`--remove owner/repo` 下架单条）
- 自荐 Issue 预演：`node scripts/ingest-showcase.mjs --body-file issue.md --author <login> --dry-run`
- 数据保鲜：`node scripts/refresh-catalog.mjs`

Node >= 18，脚本零运行时依赖；不要为了改清单引入新依赖。

## catalog 架构与规则

- **真源分离**：每个应用作为独立文件存放于 `apps/<owner>/<repo>.json`（小写），PR 仅修改或新增对应的单个文件，彻底杜绝多 PR 并发合并时的 Git 冲突。
- 根目录 `catalog.json` 为客户端直接读取的聚合产物，由 `scripts/build-catalog.mjs` 从 `apps/` 增量编译生成（静态字段以 `apps/` 为准，已有条目的 `stars` / `forks` / `default_version` 从现有 `catalog.json` 保留），按 `added_at` 升序、同日按 `id` 字典序排列。
- 字段顺序固定：`id, name, owner, repo, icon, icon_bg, description, description_en, category, category_name, aliases, default_version, added_at, license, stars, forks, is_verified, homepage, install_dirs, search_subdirs, publishers, platforms, identifiers`。`install_dirs` / `search_subdirs` / `publishers` 为可选项（省略即可），其余为固定位置，不得乱序；校验脚本会拦截。
- `id` 必须是 `owner/repo` 小写；`added_at` 用 UTC `YYYY-MM-DD`；收录条目 `is_verified` 为 `true`。
- `platforms` 不能为空；`identifiers` 只放各平台真实可执行名。
- 中文简介写 `description`，英文原文写 `description_en`；分类键取自 `scripts/lib/catalog-shared.mjs` 的 `CATEGORIES`。
- 能用脚本生成或追加就不要手写；写入后必须跑校验。

## 开发者自荐（showcase）

- 与精选收录完全分开：条目真源为 `showcase/<owner>/<repo>.json`，根目录 `showcase.json` 为客户端读取的聚合产物（`{ version: 1, generated_at, entries }`，按提交日期倒序）；`showcase/history.json` 记录每个仓库的下架日期，用于 180 天冷却。
- 条目字段固定为 `id, submitted_by, pitch, pitch_en, keywords, submitted_at, expires_at, stars_at_submit, renewed, issue_url`；客户端会对整份清单严格校验，任一条目非法即整份拒绝，所以只经脚本写入。
- 只放自荐元数据，不放名称、图标、Star、平台等卡片字段（客户端从仓库实时获取，防止自报数据）。
- 规则：提交人须是所有者 / 协作者（无法自动确认时 needs-review）；OSI 协议；最新 Release 有可安装构建包；近 180 天有推送；不在 `catalog.json`；展示 90 天，到期前 14 天内可续期一次；每人同时最多 2 个有效条目；没有付费位，不接受链接、联系方式。
- 自荐 PR 一律人工合并。

## 工作流

- `issue-to-pr.yml`：解析收录 Issue 的 `payload_json`，补全元数据与平台信息后生成 `apps/<owner>/<repo>.json` 并开 PR，写入 `catalog-ingest` 门禁状态；默认 `AUTO_MERGE_POLICY=manual` 由维护者/作者人工确认合并。
- `build-catalog.yml`：每天 00:00 UTC（北京时间 08:00）定时或手动扫描 `apps/` 增量编译生成 `catalog.json` 并提交入库。
- `catalog-gate.yml`：对人工 PR 写 `catalog-ingest` commit status；bot PR 由 `issue-to-pr.yml` / `refresh-catalog.yml` 自己写。
- `showcase.yml`：`showcase` 标签的 Issue → `ingest-showcase.mjs` 校验 → 写 `showcase/` 与 `showcase.json` → PR（人工合并）；`showcase-report` 举报 Issue 贴 `confirmed` 后自动生成下架 PR。
- `refresh-catalog.yml`：依赖定时 `build-catalog.yml` 成功后串联触发（或手动触发），刷新 stars / forks / release；走 PR + `catalog-ingest`。

## 提交

- 维护者本地开发：在分支上改完后直接 `git merge` 进本地 `main` 再 push，不必为此开 PR。ruleset 的 `pull_request` / `required_status_checks` 只约束外部贡献，管理员的 `bypass_mode` 是 `always`。
- 使用 conventional commits：`feat(catalog): ...`、`fix(scripts): ...`、`docs: ...`。
- 一个 PR 只做一件事；不要顺手改无关条目或 workflow。
- 不要提交 token、API key、个人路径。
