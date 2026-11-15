# 收录申请自动化与门禁说明

本文档说明 Z-Store 应用清单的现状架构与自动化流水线，供维护者和贡献者查阅。

---

## 1. 整体架构

仓库采用**「单应用真源拆分 + 自动编译汇总」**架构：

- **真源**：`apps/<owner>/<repo>.json`（全小写路径），每个应用独立一个文件，PR 仅改动对应应用，互不冲突。
- **汇总产物**：根目录 `catalog.json`，由 `scripts/build-catalog.mjs` 扫描 `apps/` **增量编译**生成（静态字段以 `apps/` 为准，已有条目的 `stars` / `forks` / `default_version` 从现有 `catalog.json` 保留），按 `added_at` 升序、同日按 `id` 字典序排列，供 Z-Store 客户端读取。因此每日 `refresh-catalog` 只需更新 `catalog.json`，无需改动 `apps/`。

---

## 2. 两条收录与合入路径

### 路径 A：客户端 Issue 一键投稿（`issue-to-pr.yml`）

Z-Store 客户端提交收录申请时，会生成正文包含 `### payload_json` 的 GitHub Issue：

1. **解析与补齐**（`scripts/ingest-issue.mjs`）：
   - 提取 `payload_json`（单对象或数组，最多 50 条，正文上限 64 KB）；
   - 从 GitHub API 实时拉取 `stars`、`forks`、`license`、最新 Release 版本与资产（不信任客户端上报的动态数值）；
   - 缺 `platforms` / `identifiers` 时根据 Release 二进制资产自动推断；
   - 缺图标或图标不可用时自动探测（仓库 hint → Simple Icons → Git Trees 评分 → 仓库头像兜底），并做 HTTPS / 非内网（防 SSRF）/ 字节大小（≥ 300 B）校验；
   - 已有同 `id` 默认按重复提交评论并关闭 Issue；若 Issue 带 `update` 标签则走更新分支（保留原 `added_at`）。
2. **校验与建 PR**：
   - 内存全量跑 `validateCatalog()`，写盘 `apps/<owner>/<repo>.json` 后再跑一次 `validate-catalog.mjs`；
   - 推送到固定分支 `catalog/issue-<N>` 并创建/更新 PR（幂等，重复触发不会产生多个 PR）；
   - 在 head commit 上写入必需状态 `catalog-ingest=success`。
3. **合并策略（默认人工确认）**：
   - 仓库变量 `AUTO_MERGE_POLICY` 默认为 `manual`：PR 绿标就绪后由维护者人工点击 Merge；
   - 若存在低星、非 OSI 协议、fork、无二进制 Release 或缺图标等情况，会自动打上 `needs-review` 标签并列出原因；
   - 维护者给 Issue 贴 `auto-merge` 标签（且无 `needs-review`）时，允许流水线自动 squash merge 并关闭原 Issue。

### 路径 B：人工提交 PR（`catalog-gate.yml`）

社区贡献者直接 Fork 仓库、新增或修改 `apps/<owner>/<repo>.json` 并发起 PR：

- **`catalog-gate.yml`（必需门禁）**：使用 **base 分支的可信脚本**检出 PR 中变更的 `apps/` 目录，运行 `build-catalog.mjs` + `validate-catalog.mjs`，通过后写入 `catalog-ingest=success`（不执行外部 PR 自带的脚本，确保安全）。
- **Fork PR 说明**：由于 GitHub 对 fork PR 的 `GITHUB_TOKEN` 只读，无法写入 commit status，需要维护者检查通过后 bypass 合并。

---

## 3. 合并后编译与日常维护

| 工作流 | 触发时机 | 职责 |
| --- | --- | --- |
| `build-catalog.yml` | `main` 上 `apps/**` 变更或 PR 合入 | 自动执行 `node scripts/build-catalog.mjs` 更新根目录 `catalog.json` 并提交入库 |
| `validate-pr.yml` | PR 或 `main` 推送 | 普通 CI：运行 `validate-catalog.mjs` 及 `scripts/*.test.mjs` 单元测试 |
| `refresh-catalog.yml` | 每天 00:00 UTC / 手动 | 运行 `refresh-catalog.mjs` 更新 `stars` / `forks` / `license` / `description_en` / `default_version`（不改动 `added_at`），通过 PR + `catalog-ingest` 合入 |

---

## 4. 安全边界与校验规则

- **数据与代码隔离**：Issue 正文只作为 JSON 数据解析，不拼接 shell、不 `eval`；外部 PR 门禁只运行 `main` 分支的校验脚本。
- **SSRF 防护**：图标 URL 仅允许 `https://`，拒绝 `localhost` 及内网保留 IP 段。
- **资源上限**：Issue 正文 ≤ 64 KB、单次批量 ≤ 50 条、`description` ≤ 500 字符、`aliases` ≤ 20 个。
- **合并前检查项**：`validateCatalog` 检查 23 个字段的固定键顺序、`id === lower(owner/repo)`、`added_at` 为合法 UTC 日期、平台与分类取值合法。
