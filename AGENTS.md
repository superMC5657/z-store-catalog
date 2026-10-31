# AGENTS.md

本仓库是 Z-Store 的公共应用清单（`catalog.json`）与维护脚本。任何代理或贡献者动手前先读这一页。

## 常用命令

- 校验（CI 同款，提交前必须通过）：`node scripts/validate-catalog.mjs`
- 单应用收录：`node scripts/add-app.mjs <owner/repo> -y`
- Issue payload 预演：`node scripts/ingest-issue.mjs --body-file issue.md --dry-run`
- Issue 解析单测：`node --test scripts/ingest-issue.test.mjs`
- 批量核验：`GH_TOKEN=... node scripts/batch-add.mjs --dry-run`
- 数据保鲜：`node scripts/refresh-catalog.mjs`

Node >= 18，脚本零运行时依赖；不要为了改清单引入新依赖。

## catalog.json 规则

- 新条目追加到数组末尾；不改动既有条目，禁止整体重排或重格式化。
- 字段顺序固定：`id, name, owner, repo, icon, icon_bg, description, description_en, category, category_name, aliases, default_version, added_at, license, stars, forks, is_verified, homepage, install_dirs, search_subdirs, publishers, platforms, identifiers`。`install_dirs` / `search_subdirs` / `publishers` 为可选项（省略即可），其余为固定位置，不得乱序；校验脚本会拦截。
- `id` 必须是 `owner/repo` 小写；`added_at` 用 UTC `YYYY-MM-DD`；收录条目 `is_verified` 为 `true`。
- `platforms` 不能为空；`identifiers` 只放各平台真实可执行名。
- 中文简介写 `description`，英文原文写 `description_en`；分类键取自 `scripts/lib/catalog-shared.mjs` 的 `CATEGORIES`。
- 能用脚本生成或追加就不要手写；写入后必须跑校验。

## 工作流

- `issue-to-pr.yml`：解析收录 Issue 的 `payload_json`，校验后开 PR，再按 `AUTO_MERGE_POLICY`（trusted / all / label）与 `AUTO_MERGE_MODE`（direct / native）自动合并。不要绕过它手改 `catalog.json`。
- `catalog-gate.yml`：对人工 PR 写 `catalog-ingest` commit status；bot PR 由 `issue-to-pr.yml` / `refresh-catalog.yml` 自己写。
- `validate-pr.yml`：PR 与 `main` 的格式校验（普通 CI，不是必需 check）。
- `refresh-catalog.yml`：每日刷新 stars / forks / release；走 PR + `catalog-ingest`。

## 提交

- 维护者本地开发：在分支上改完后直接 `git merge` 进本地 `main` 再 push，不必为此开 PR。ruleset 的 `pull_request` / `required_status_checks` 只约束外部贡献，管理员的 `bypass_mode` 是 `always`。
- 使用 conventional commits：`feat(catalog): ...`、`fix(scripts): ...`、`docs: ...`。
- 一个 PR 只做一件事；不要顺手改无关条目或 workflow。
- 不要提交 token、API key、个人路径；`scripts/seed/` 是运行产物，已被 git 忽略。
