# 收录申请 Issue 全自动合并方案

> 状态：P1/P2/P3 已上线并验证（Issue #4 / #5 / #13）；Jules 工作流已恢复，等待 `JULES_API_KEY` 激活
> 仓库：`superMC5657/z-store-catalog`
> 关联：PR #3（`feat(ci): 收录 Issue 自动转 PR + Jules 评审第一道门`，已关闭，分支已删除）

---

## 1. 结论先行

**推荐架构：确定性脚本写入 `catalog.json`，GitHub Actions 负责开 PR、跑门禁、合并；Jules 只做语义复核，不负责写文件。**

理由：

1. 客户端提交的 Issue 正文已经是结构化 `payload_json`（单条对象或数组），把它归一化后追加到 `catalog.json` 是一个**确定性数据变换**，用 20 行 Node 就能完成，不需要 LLM。
2. 现有 `scripts/add-app.mjs` + `scripts/lib/catalog-shared.mjs` 已经具备抓取仓库信息、推断平台/标识符、探测图标的能力，直接复用即可补齐「客户端 payload 缺字段」的问题（Issue #1 就是因为缺 `identifiers`、`platforms` 为空被卡住）。
3. Jules 是异步编码代理，适合**语义判断**（分类是否合理、简介是否匹配上游、平台声明是否与 Release 资产一致）和**异常修复**，不适合逐条 Issue 的写盘：它有配额、延迟、且输出不确定，把合并成败押在它身上会让流水线变慢且不可复现。
4. PR #3 已经走通了 80% 的路（Issue → PR → Jules 评审），但**刻意没有自动合并**，最后仍由维护者点 Merge。本方案在它的基础上补三件事：**字段富化**、**自动合并门禁**、**并发/幂等**。

**分阶段落地：**

| 阶段 | 合并方式 | 适用 |
| --- | --- | --- |
| P1（今天就能用） | 可信作者直合；外部作者只开 PR | 维护者自己的客户端提交 |
| P2 | 外部作者满足信誉阈值后自动合并 | 社区投稿放量 |
| P3（可选） | GitHub 原生 auto-merge + 分支保护 | 需要审计/强制 CI 时 |

---

## 2. 现状与痛点

### 2.1 提交链路

Z-Store 客户端在「收录申请」时生成一个预填 Issue：

- 单条标题：`[收录申请] owner/repo`
- 批量标题：`[批量收录申请] N 项`
- 正文包含 `### payload_json` + 一个 ` ```json ` 代码块（单对象或数组）
- 创建 URL：`https://github.com/superMC5657/z-store-catalog/issues/new?title=...&body=...`

Issue #5（`debpalash/voicestudio`）是标准样例；Issue #1（`farion1231/cc-switch`）缺少 `identifiers`，`platforms` 为空——这类 payload 目前必须人工补。

客户端侧不需要改动：运行时从本仓库同步，合并后下一次同步就能看到新应用；本地 `submitted` 状态由 z-store 的 `retire_on_sync` 收口。编译期 `include_str!` 的种子只在下一次 z-store 发版时重新拷贝，本流水线不碰客户端仓库。

### 2.2 现在的人工步骤

1. 维护者看到 Issue，复制 `payload_json`；
2. 手动运行 `pnpm add:app owner/repo`（或直接编辑 `catalog.json`）；
3. 补 `category_name`、`icon_bg`、`added_at`、`platforms`、`identifiers`；
4. 本地 `node scripts/validate-catalog.mjs`；
5. commit → push → 开 PR → 等 CI → merge；
6. 回 Issue 手动关闭。

任何一步都可能漏字段或造成排版漂移（`formatCatalogJson` 会把短数组压成一行）。

### 2.3 PR #3 的遗留

PR #3 已实现：

- `scripts/ingest-issue.mjs`：解析 `payload_json`、按 `owner/repo` 去重、固定字段顺序、追加写入；
- `.github/workflows/issue-to-pr.yml`：Issue → 分支 `catalog/issue-N` → PR（`Closes #N`），重复触发复用分支/PR；
- `.github/workflows/jules-pr-review.yml`：Jules 只读评审 diff，输出 `VERDICT: APPROVE|REJECT`，打 `jules-approved` / `jules-rejected`；
- `validate-catalog.mjs` 导出 `validateCatalog()`，可在内存中校验后再写盘。

**没有解决：**

- payload 缺字段时直接失败，没有从 GitHub API 补齐（Issue #1 被拒）；
- 评审通过后仍要人工 merge；
- 无自动合并策略、无并发保护（与每日 `refresh-catalog.yml` 竞争 `catalog.json`）；
- 用 `workflow_dispatch` 手动触发评审来绕过「GITHUB_TOKEN 创建的 PR 不触发 `pull_request` workflow」。

本方案可以理解为 **PR #3 + 字段富化 + 自动合并策略**，而不是另起炉灶。

---

## 3. 目标流程

```
客户端提交 Issue（含 ### payload_json）
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ issue-to-pr.yml        （issues: opened / edited）          │
│  1. 解析 payload（对象或数组，上限 50 条）                   │
│  2. 归一化 + 富化：GitHub API 补 stars/forks/license/       │
│     version/platforms/identifiers/icon                      │
│  3. 去重：已在 catalog → 评论并关闭 duplicate               │
│  4. 内存校验 validateCatalog(next)                          │
│  5. 写 catalog.json → 分支 catalog/issue-N → PR（Closes #N）│
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ validate-pr.yml        schema / 唯一性 / 平台 / 图标 URL    │
│ jules-verdict          语义硬门禁（fail-closed）             │
│ auto-merge gate        作者信任度 + 仓库信誉 + 门禁结果     │
└─────────────────────────────────────────────────────────────┘
        │  全部通过
        ▼
squash merge → main → 显式 close Issue（Closes #N 作为文本兜底）
        │
        ▼
refresh-catalog.yml 定时保鲜 stars/forks/default_version
```

---

## 4. 组件设计

### 4.1 `scripts/ingest-issue.mjs`（改造 PR #3 的版本）

#### 4.1.1 解析

- 只认 `### payload_json` 之后、第一个 ` ```json ` 代码块；
- 支持单对象与数组；数组为空 / 非对象 / 超过 50 条 → 整条 Issue 拒绝（原子性，不做部分写入）；
- 正文超过 64 KB → 拒绝（GitHub Issue 正文上限为 65536 字符）；
- 不执行 Issue 里的任何代码。

#### 4.1.2 归一化与富化

**原则：人写的文案优先，API 事实覆盖动态字段，推断只补空缺。**

| 字段 | 来源优先级 |
| --- | --- |
| `id` | **强制** `${owner}/${repo}` 小写；与 payload.id 不一致时以 `owner/repo` 为准 |
| `name` | payload → `repo.name` |
| `owner` / `repo` | payload；必须是合法 GitHub 坐标 |
| `icon` | payload（必须通过 HTTPS + `image/*` + 300 B ~ 2 MB 校验）→ `probeRepoLogo()` |
| `icon_bg` | payload → `CATEGORY_GRADIENTS[category]` |
| `description` | payload → `repo.description` → 拒绝 |
| `description_en` | payload → `repo.description` |
| `category` | payload（必须在 `CATEGORIES` 内）→ `guessCategory(topics, description)` |
| `category_name` | 由 `CATEGORIES` 映射，**不信任 payload** |
| `aliases` | payload；去重、去空、上限 20 |
| `default_version` | payload → `releases/latest.tag_name` → `"latest"` |
| `added_at` | **今天 UTC**（已有的保留原值） |
| `license` | GitHub API `license.spdx_id`（有效时）→ payload（必须在 OSI 白名单内）；API 返回 `NOASSERTION` 且 payload 也无有效值时 → `needs-review` |
| `stars` / `forks` | **GitHub API**（永不信任 payload） |
| `is_verified` | `true`（进入 catalog 即视为已核验） |
| `homepage` | payload（补 `https://`）→ `repo.html_url` |
| `platforms` / `identifiers` | payload **完整**时保留；缺失/为空时用 `deducePlatformsAndIdentifiers(repo.name, latestRelease.assets)` |

> 实现上把 `guessCategory()` 从 `add-app.mjs` 提到 `scripts/lib/catalog-shared.mjs`，两边共用，避免第二份分类启发式。

**富化失败不静默：**

- API 404 / 仓库 archived → 拒绝；
- 仓库是 fork → 不硬拒，打 `needs-review`（维护中的 fork 也可能合格，需人工确认）；
- 没有 Release 或没有二进制资产 → 不是硬失败，但打 `needs-review`（CONTRIBUTING 要求有 Releases 资产）；
- 图标探测不到 → 用 `https://avatars.githubusercontent.com/u/<owner_id>?v=4` 兜底，仍失败则 `needs-review`。

#### 4.1.3 去重

- 已有同 `id`：默认视为重复投稿 → 评论「已收录」+ 关闭 Issue（`state_reason: not planned`），不建 PR；
- 需要更新已有条目时，给 Issue 打 `update` 标签，走「更新」分支（只允许改文案/图标/标识符，不允许改 `added_at`）；
- 同一 Issue 内重复 id → 整条拒绝。

#### 4.1.4 校验与写盘

- 用 `validateCatalog(next)` 在内存中校验（PR #3 已把校验器抽成可导出函数）；
- 通过后用 `formatCatalogJson()` 写盘，保证短数组单行、2 空格缩进；
- 再跑一次 CLI `node scripts/validate-catalog.mjs` 作为双保险；
- 失败时 `git checkout -- catalog.json`，不推送分支。

#### 4.1.5 输出

给 workflow 的机器可读结果（`--out result.json`）：

```json
{
  "ok": true,
  "action": "add",
  "issue": 5,
  "ids": ["debpalash/voicestudio"],
  "warnings": ["platforms inferred from release assets"],
  "skipped": []
}
```

同时生成 PR 标题/正文、Issue 评论素材（沿用 PR #3 的做法）。

### 4.2 `.github/workflows/issue-to-pr.yml`

```yaml
on:
  issues:
    types: [opened, edited, labeled]
  workflow_dispatch:
    inputs:
      issue_number: { required: true }
      dry_run: { type: boolean, default: false }

permissions:
  contents: write
  issues: write
  pull-requests: write

concurrency:
  group: catalog-issue-${{ github.event.issue.number || inputs.issue_number }}
  cancel-in-progress: false
```

要点：

- 触发条件：正文含 `### payload_json`；`edited` 只在 `changes.body` 存在时跑；`labeled` 只认 `auto-merge` / `retry`；
- 防自触发：`github.event.sender.login != 'github-actions[bot]'`；
- checkout `main`，用 `CATALOG_BOT_TOKEN`（或 GitHub App token）拉代码和开 PR；没有配置时回退 `github.token`，并在 PR 里注明 CI 可能不跑；
- 分支名固定 `catalog/issue-<N>`，重复触发 `git push --force-with-lease` 更新同一个 PR（幂等）；
- PR 正文包含 `Closes #<N>`；merge 成功后 workflow 还会显式 `gh issue close`——`GITHUB_TOKEN` 合并时 `Closes` 的自动关闭不一定会触发（Issue #5 实测）；
- 创建 PR 后**不需要**手动 dispatch 评审：配置了 PAT/App token 时 `pull_request` 事件会自然触发；
- `dry_run=true` 时只评论解析/校验结果，不建分支。

### 4.3 `catalog-gate.yml` + `catalog-ingest` 状态（P3 必需检查）

**为什么不用 `Validate Catalog Schema & Rules` 当必需 check：** `GITHUB_TOKEN` 创建的 PR 的 `pull_request` run 会停在 approval-required，check 不会上报；再加上 `paths:` 过滤，必需 check 会永久 Pending。用 PAT 可以解决，但不值得为一条数据流水线引入长期 token。

P3 改用统一的 commit status **`catalog-ingest`**：

- `issue-to-pr.yml` 在 PR 创建后、合并前，在自己的 head SHA 上写 `catalog-ingest=success`（它已经跑过同款校验）；
- `catalog-gate.yml` 对所有 PR 用 **base 分支的可信脚本** 校验 PR 里的 `catalog.json`，并写同一个 status；
- 规则集只要求 `catalog-ingest`，**不需要 PAT/App token**；
- fork PR 的 `GITHUB_TOKEN` 只读，写不了 status，需要维护者 bypass 后手动合并（主流程走 Issue，不受影响）。

`validate-pr.yml` 保留为普通 CI，不作为必需 check（它有 `paths` 过滤，跳过时的 Pending 不会阻塞合并）。

### 4.4 Jules 硬门禁：`jules-verdict`

- 规则集 `main-protection` 要求 `catalog-ingest` + **`jules-verdict`** 两个状态；
- 人工 PR：`jules-pr-review.yml` 用 **base 分支的脚本**校验 PR 里的 `catalog.json`（不执行 PR 代码），再调 Jules 评审，写 `jules-verdict=success|failure`；
- bot 收录 PR：`issue-to-pr.yml` 在创建 PR 后内联调用 `review-pr.mjs`，写同一个 `jules-verdict`，再决定是否写 `catalog-ingest` 和合并；
- 每日 refresh PR：动态字段变更，不做语义评审；`refresh-catalog.yml` 直接写 `jules-verdict=success`（描述 `Exempt: daily refresh`）；
- 只读评审，要求输出：

```
VERDICT: APPROVE
REASON: <一句话>
```

- `APPROVE` → `jules-verdict=success` + `jules-approved`；`REJECT` / 超时 / 无结论 / 缺 key → `jules-verdict=failure`（fail-closed），PR 留在 `needs-review`，不合并；
- 配额：免费档 15 任务/天、3 并发，单次 5–60 分钟；每条 PR/每次 push 消耗一次任务，量大时升级 Pro 或改成只对 `catalog/issue-*` 评审；
- `JULES_API_KEY` 缺失时**必须 fail-closed**，不能跳过——否则规则集会一直等不到 `jules-verdict`。

### 4.5 自动合并步骤

在评审 workflow 末尾（同一个 job，拿到 APPROVE 后）执行：

```bash
# P1：直接合并（无需仓库设置）
gh pr merge "$PR" --repo "$REPO" --squash --delete-branch

# P3：原生 auto-merge（需要 allow_auto_merge + 分支保护）
gh pr merge "$PR" --repo "$REPO" --auto --squash --delete-branch
```

合并前再确认：

- PR 只改了 `catalog.json`；
- 所有必需 check 通过（`catalog-ingest` + `jules-verdict`）；
- 没有 `needs-review` / `jules-rejected` 标签；
- PR head 仍是最新（`gh pr view --json mergeable,mergeStateStatus`）；
- `mergeStateStatus == BEHIND` → `gh pr update-branch <n>`，等 check 重跑后再合并（GitHub 不会替 auto-merge 自动变基）。

**`gh pr merge --auto` 的两个坑（已核实）：**

1. **无分支保护时 `--auto` 会被静默忽略，PR 立即合并。** 这是 P1 `direct` 模式可以不用任何仓库设置的原因；如果确实想「等 CI 绿灯再合」，必须有 required check 或 required review。
2. **`--delete-branch` 在 auto-merge 路径下是 no-op。** 需要仓库设置 `delete_branch_on_merge: true`（或合并后手动删 ref）。

> **不要**在 `pull_request` 事件里用 `pull_request_target` + checkout PR 代码；数据仓库只处理数据，杜绝代码执行面。

### 4.6 与 `refresh-catalog.yml` 的协同

`refresh-catalog.yml` 目前**直接 push main**，每天 00:00 UTC 改 `stars`/`forks`/`default_version`。它和收录 PR 会竞争同一个 `catalog.json`。

两种处理：

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| A. 串行（推荐 P1） | 两个 workflow 共用 `concurrency: catalog-main`；refresh 在 push 前 `git pull --rebase` | 零改造成本，低并发足够 |
| B. 全部 PR 化（P3） | refresh 也开 PR，走同一套门禁 + auto-merge | 可开分支保护、可审计，但每日多一次 PR |

如果启用分支保护，必须选 B，或把 `github-actions[bot]` 加入 ruleset 的 bypass 列表（GitHub 对 bot 的 bypass 支持因仓库类型而异，需实测）。

### 4.7 涉及文件

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `scripts/lib/catalog-shared.mjs` | 修改 | 导出 `guessCategory()`；可选新增 `fetchRepoFacts()` 统一封装 GitHub API |
| `scripts/validate-catalog.mjs` | 修改 | 导出 `validateCatalog()`；支持 `CATALOG_PATH` 环境变量（PR #3 已做） |
| `scripts/ingest-issue.mjs` | 新增 | 解析 / 富化 / 去重 / 校验 / 输出 PR 素材 |
| `.github/workflows/issue-to-pr.yml` | 新增 | Issue → 分支 → PR → Jules 内联门禁 → 合并 |
| `.github/workflows/jules-pr-review.yml` | 新增 | 人工 PR 的 Jules 硬门禁（写 `jules-verdict`） |
| `.github/workflows/catalog-gate.yml` | 新增 | 人工 PR 的 `catalog-ingest` 状态 |
| `.github/workflows/refresh-catalog.yml` | 修改 | 改为 PR 化，写 `catalog-ingest` + 豁免 `jules-verdict` |
| `AGENTS.md` + `.github/jules/*.md` | 新增 | Jules 的仓库规则与任务提示词 |
| `CONTRIBUTING.md` / `README.md` | 修改 | 说明「提交后自动处理」，以及 `needs-review` / `auto-merge` 标签含义 |
| `package.json` | 修改 | 增加 `ingest:issue` 脚本，便于本地复现 |

---

## 5. 自动合并门禁矩阵

| # | 门禁 | 规则 | 不通过 |
| --- | --- | --- | --- |
| G1 | payload 形状 | 可解析、1–50 条、每条是对象 | 评论 + `needs-review`，不开 PR |
| G2 | schema | `validateCatalog` 零 error | 评论具体字段，不开 PR |
| G3 | 身份 | `id === lower(owner/repo)`，全库唯一 | 重复 → 关闭；不一致 → 拒绝 |
| G4 | 仓库事实 | 公开、非 archived、owner/repo 可解析；fork 单独标记 | archived/404 拒绝；fork → `needs-review` |
| G5 | 许可证 | SPDX 在 OSI 白名单（ADR-0018） | `needs-review` |
| G6 | 可下载性 | 有 Release 或资产；`platforms` 与资产不矛盾 | `needs-review` |
| G7 | 图标 | HTTPS、`image/*`、300 B–2 MB、非内网地址 | 自动探测；仍失败 → `needs-review` |
| G8 | 文案 | `description` 4–500 字符、无 HTML/脚本；`description_en` 非空 | `needs-review` |
| G9 | 作者信任 | 见下方策略 | 只开 PR，不合并 |
| G10 | 语义（硬门禁） | Jules `APPROVE` + `jules-verdict=success` | 不合并（fail-closed） |

### 作者信任策略（`AUTO_MERGE_POLICY` 仓库变量）

| 值 | 行为 |
| --- | --- |
| `trusted`（默认） | `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` 才自动合并；外部作者只开 PR |
| `all` | 任何作者，只要 G1–G8 全过 + 仓库信誉达标（stars ≥ 50、最近 18 个月有 push、非空 description）就自动合并 |
| `label` | 只有 Issue 带 `auto-merge` 标签才自动合并（最保守） |

当前仓库已切到 `all`；如需保守，随时 `gh variable set AUTO_MERGE_POLICY --body trusted`。外部作者走 `all` 时仍要求 `reputationOk=true`。

### 合并方式（`AUTO_MERGE_MODE`）

| 值 | 前置条件 | 说明 |
| --- | --- | --- |
| `direct`（默认） | 无 | workflow 内校验通过后 `gh pr merge --squash`；PR 仍留审计记录 |
| `native` | 开启 Allow auto-merge + 分支保护/规则集 | `gh pr merge --auto`；等 CI 绿灯后 GitHub 自动合并 |

---

## 6. Jules 在流水线中的正确位置

### 6.1 官方能力与限制（2026-10 核实）

| 项目 | 事实 |
| --- | --- |
| GitHub 触发 | 给 Issue 打 **`jules` 标签**（大小写不敏感）是唯一官方 Issue 触发器；没有「assign 给 @jules」或 Issue 评论触发 |
| PR | API 创建 session 时默认**不开 PR**，必须显式 `automationMode: "AUTO_CREATE_PR"`；标签触发的任务会回帖 PR 链接 |
| 自动合并 | **没有**。Jules 只创建/更新自己的 PR；合并在 GitHub 侧完成 |
| 配置文件 | 只官方读取仓库根的 **`AGENTS.md`**；`JULES.md` / `.jules/` 不是官方配置 |
| API | `POST https://jules.googleapis.com/v1alpha/sessions`，`x-goog-api-key`；alpha，字段可能变 |
| 额度 | 免费 **15 任务/天、3 并发**；Pro 100/15；Ultra 300/60；按用户计，不跨账号池化 |
| 时长 | 无官方 SLA，社区观测 5–60 分钟；简单改动 1–2 分钟 |
| 分支 | 只能选 `startingBranch` 作为**起点**；输出是 Jules 自己的新分支 + PR，**不能推到已有分支** |
| 环境 | 独立 Ubuntu VM，预装 Node 22/pnpm/Python/Rust 等，有公网；可跑 `node scripts/*` 与测试 |
| 修复 | CI Fixer 能自动修它自己 PR 上的红灯，但仍不合并 |

来源：<https://jules.google/docs/running-tasks/>、<https://jules.google/docs/api/reference/sessions/>、<https://jules.google/docs/usage-limits/>、<https://jules.google/docs/environment/>、<https://jules.google/docs/changelog/2025-06-26/>。

### 6.2 能做什么

- 语义复核：分类是否合理、简介是否与上游一致、`platforms` 是否与 Release 资产矛盾、图标是否明显不对；
- 发现 schema 查不出的问题：仓库已归档/改名、描述过期、平台虚标；
- 异常修复：payload 结构没问题但文案/分类需要重写时，用 `jules` 标签让它开一个**新** PR（需要维护者合并，不能更新既有 `catalog/issue-N` 分支）；
- 维护性任务：修 CI、批量体检历史条目（PR #3 的 `jules-maintenance.yml` 已打过样）。

### 6.3 不建议做什么

- **不要**让 Jules 直接读 Issue 改 `catalog.json` 开 PR 作为主路径：
  - 免费档 15 任务/天、3 并发，每条投稿消耗一个任务，社区投稿一多就排队；
  - 单次 5–60 分钟，比脚本慢两个数量级；
  - 输出不确定，可能重排/重格式化 367 KB 的 `catalog.json`；
  - API 仍是 `v1alpha`，不可作为唯一依赖。
- **不要**把 Jules 的 `APPROVE` 当安全保证：它只是 LLM 判断，schema/许可证/图标校验仍以确定性脚本为准。
- **不要**让 `jules` 标签对所有人生效：任何有 label/triage 权限的人都能烧配额并触发仓库写入；workflow 里要校验 actor 白名单。

### 6.4 推荐组合

```
确定性门禁（G1–G9）  →  必须通过
Jules 语义门禁（G10） →  必须通过（jules-verdict=success；缺 key/超时/REJECT 一律 fail-closed）
每日 refresh PR       →  豁免语义评审，直接写 jules-verdict=success
```

### 6.5 失败/降级

| 情况 | 行为 |
| --- | --- |
| 未配置 `JULES_API_KEY` | fail-closed：写 `jules-verdict=failure`，不合并，打 `needs-review` |
| Jules 超时 / 配额耗尽 / 无 VERDICT | fail-closed：写 `jules-verdict=failure`，不自动合并，打 `jules-rejected` + `needs-review` |
| Jules REJECT | 评论 `REASON`，写 `jules-verdict=failure`，打 `jules-rejected`；维护者可 bypass 规则集人工合并 |
| Jules 误判 | 修改 Issue/payload 后 re-run（会重新评审）；不要直接删 status |
| 每日 refresh PR | 豁免：`refresh-catalog.yml` 直接写 `jules-verdict=success` |
| 需要 Jules 修文案 | 打 `jules` 标签开新 PR；原自动 PR 保持 `needs-review`，人工二选一 |

### 6.6 评审提示词（只读）

```
你是 z-store-catalog 的收录评审。只读，不要修改任何文件。
检查这 4 件事：
1. owner/repo 是否仍可访问、未归档、不是 fork；
2. category 是否与仓库实际用途一致（分类表见 scripts/lib/catalog-shared.mjs）；
3. description / description_en 是否与上游仓库简介一致，无夸大或错误；
4. platforms / identifiers 是否与最新 Release 资产矛盾。
最后只输出：
VERDICT: APPROVE|REJECT
REASON: <一句话>
```

> 该 prompt 与 PR #3 的 `review-pr.mjs` 一致；Jules 返回任何其他格式（包括没有 VERDICT）都按 REJECT 处理。

---

## 7. 安全与滥用防护

1. **Issue 正文只当数据**：不拼 shell、不 `eval`、不渲染 HTML；描述做控制字符/长度清洗。
2. **不执行 PR 代码**：校验用 base 分支的 `validate-catalog.mjs`；`catalog/issue-*` PR 只允许改 `catalog.json`。
3. **SSRF**：图标 URL 只允许 `https`，拒绝 `localhost`、`127.*`、`10.*`、`192.168.*`、`169.254.*`、`::1`；GitHub 托管 runner 本身也访问不到内网。
4. **资源上限**：Issue 正文 ≤ 64 KB、条目 ≤ 50、单条 JSON ≤ 16 KB、图标 ≤ 2 MB、`aliases` ≤ 20。
5. **最小权限**：workflow 显式声明 `contents: write` / `issues: write` / `pull-requests: write`；其余 `read`。
6. **Token**：
   - 首选 GitHub App（`actions/create-github-app-token`），短期 token，PR 事件能正常触发；
   - 次选 fine-grained PAT `CATALOG_BOT_TOKEN`（`contents` / `pull-requests` / `issues` 读写）；
   - 都没有时回退 `github.token`：能开 PR/合并，但 PR 的 `pull_request` run 会停在 **approval-required**（需要人工点「Approve workflows to run」），必需 check 不会自动上报，auto-merge 会一直等；post-merge 的 `push` workflow 也不会跑。这是 PR #3 手动 dispatch 评审的原因，而 dispatch 产生的 check 又不满足分支保护——所以**只要启用原生 auto-merge，就必须用 App/PAT**。
7. **审计**：每个自动合并都留 PR + Issue 评论 + label，可回溯到 payload 与 enrichment 来源。
8. **防刷**：`all` 模式下要求 stars ≥ 50、最近 18 个月有 push、非 fork、非 archived；不满足只开 PR。

---

## 8. 失败处理与幂等

| 场景 | 行为 |
| --- | --- |
| 同一 Issue 重复触发（opened + edited + labeled） | 复用 `catalog/issue-N` 分支与 PR，force-with-lease 更新，不产生第二个 PR |
| Issue 编辑后 payload 变了 | 重新解析，PR 内容整体替换；旧条目若已不在 payload 中则从分支回滚（基于 main 重新生成） |
| 分支/PR 已合并 | 检测到 PR merged → 不再处理，评论「已收录」 |
| Issue 已关闭 | 跳过（除非 `retry` 标签） |
| 校验失败 | 评论具体字段 + `needs-review`，不推送分支 |
| 合并冲突 | `gh pr update-branch` 重试一次；仍失败 → `needs-review` |
| API 限流 | 退避重试 3 次；仍失败 → `needs-review` |

---

## 9. 并发与竞态

**同 Issue 串行**：workflow 级 `concurrency: group: catalog-issue-<N>`，`cancel-in-progress: false`，保证 opened/edited/labeled 三次触发不会互相覆盖分支。

**跨 Issue / refresh 的 `catalog.json` 写冲突**，两种做法：

| 方案 | 做法 | 注意 |
| --- | --- | --- |
| A. 单写者队列 | 所有写流程共用 `group: catalog-main`，并设置 `queue: max` | GitHub 默认只保留 **1 个 pending**：第 3 个 run 会取消第 2 个（第 2 个变 cancelled），高并发会丢投稿。`queue: max` 可保留最多 100 个 pending，需确认仓库/套餐支持 |
| B. 乐观并发（推荐） | 不共享 group；每个 PR 合并前检查 `mergeStateStatus`，`BEHIND` 时 `gh pr update-branch`，冲突则基于最新 main 重新生成分支并重试 2 次 | 吞吐更好；`update-branch` 会触发 `synchronize`，用 App/PAT 时 check 会自动重跑 |

**refresh 协同：**

- `refresh-catalog.yml` push 前 `git pull --rebase`，失败退避重试 2 次；
- 它与收录 PR 不共享 group 时，可能出现「refresh 刚 push，PR 变 BEHIND」——按方案 B 处理即可；
- P3 若启用「Require branches to be up to date」，必须显式 `gh pr update-branch`（`strict_required_status_checks_policy: true`），GitHub 不会替 auto-merge 自动变基；不想维护这一步就把 strict 设为 `false`，或改用 merge queue（需要 workflow 增加 `merge_group` 触发）。

---

## 10. 落地步骤

### P1（约 0.5 天，零仓库设置）

- [x] 把 PR #3 的 `scripts/ingest-issue.mjs` 取回（commit `6c0aa9c`），补 4.1.2 的富化逻辑；
- [x] 把 `guessCategory()` 提到 `scripts/lib/catalog-shared.mjs`；
- [x] 保留 `validate-catalog.mjs` 的可导出 `validateCatalog()` + `CATALOG_PATH`；
- [x] 新增 `.github/workflows/issue-to-pr.yml`，同 Issue 用 `concurrency: catalog-issue-<N>`；
- [x] 用 Issue #5（标准）和 Issue #1（缺字段）做 dry-run 回归（两条均通过 362→364 全量校验）；
- [x] 在 `refresh-catalog.yml` 加 `git pull --rebase` + 冲突重试；
- [ ] 打开仓库设置：Actions 允许创建 PR（当前 `can_approve_pull_request_reviews=true`，已满足）；
- [ ] 配置 `CATALOG_BOT_TOKEN`（可选；P1 `direct` 模式不是必须，但配置后 PR 会正常触发 CI）；
- [x] 提交实现分支（PR #6）；合并后观察前 10 条真实 Issue。

### P2（外部作者放量）

- [ ] 增加 G9 信誉阈值与 `AUTO_MERGE_POLICY=all`；
- [x] 增加 `needs-review` / `auto-merge` / `duplicate` / `update` 标签；
- [ ] 观察外部作者误判，调整阈值（目前只验证了 owner 提交与本地模拟）。

### P3（已上线，原生 auto-merge + Jules 硬门禁）

- [x] 仓库设置开启 **Allow auto-merge** 与 **Automatically delete head branches**：
  `gh api -X PATCH repos/superMC5657/z-store-catalog -f allow_auto_merge=true -f delete_branch_on_merge=true`
- [x] 新增 `catalog-gate.yml`；`issue-to-pr.yml` 在 PR 后写 `catalog-ingest` status；
- [x] 建 main 规则集 `main-protection`：Require PR、Required status checks = `catalog-ingest`、Block force push、禁止删除分支；
- [x] `refresh-catalog.yml` 改为固定分支 `chore/refresh-baseline` + PR + `catalog-ingest`；
- [x] `AUTO_MERGE_MODE=native`；`strict_required_status_checks_policy=false`。
- [x] fork PR 需要维护者 bypass（规则集给 RepositoryRole admin 配了 bypass；只读 token 无法写 status），主流程走 Issue 不受影响。

已验证：Issue #13 → PR #14 原生 auto-merge 并显式关闭 Issue；每日 refresh → PR #15 通过 `catalog-ingest` 合并；PR #17/#18/#19 人工 PR 的 `Catalog Gate` / `Validate Catalog` / Jules skip 均正常。

---

## 11. 验收用例

| # | 输入 | 期望 |
| --- | --- | --- |
| 1 | Issue #5（字段完整） | 新增 1 条，校验通过，PR 合并，Issue 自动关闭 |
| 2 | Issue #1（缺 `identifiers`、`platforms: []`） | 自动推断 3 端平台与标识符，合并成功 |
| 3 | 重复 `debpalash/voicestudio` | 评论「已收录」，关闭 Issue，不建 PR |
| 4 | 坏 JSON / 缺 `owner` | 评论具体错误 + `needs-review`，无分支 |
| 5 | 批量 3 条 | 1 个 PR 追加 3 条，`Closes #N` |
| 6 | 同一 Issue 重复运行 | 复用同一分支/PR，无重复条目 |
| 7 | 外部作者 | 开 PR，打 `needs-review`，不自动合并 |
| 8 | Jules REJECT / 超时 | 不合并，打 `jules-rejected`，评论原因 |
| 9 | 与 refresh 同时运行 | 无冲突；PR 变 BEHIND 时自动 update-branch 后合并 |
| 10 | 已归档仓库 | 拒绝并说明原因 |

---

## 12. 可行性验证（本地 dry-run，2026-10-20）

用仓库里两条真实 Issue 的正文做了原型验证（脚本只放临时目录，未改动仓库）：

| Issue | payload 状态 | 验证结果 |
| --- | --- | --- |
| #5 `debpalash/voicestudio` | 字段完整 | 追加 1 条，`catalog.json` 363 条全量校验通过 |
| #1 `farion1231/cc-switch` | `platforms: []`、完全没有 `identifiers` | 从最新 Release 资产推断出 `windows/macos/linux` 与对应标识符，363 条全量校验通过 |

富化时实时读取的上游事实（示例）：#5 stars=78005、license=AGPL-3.0、latest=v0.5.6；#1 stars=146587、license=MIT、latest=v4.0.16。

结论：**「客户端 payload 不全 → 脚本补齐 → 通过现有校验器」这条路是通的**，不需要人工补 JSON，也不需要 Jules 参与写盘。

> 正式实现需补上 `FIELD_ORDER` 固定字段顺序（原型为了验证只做了值层面的归一化），并按 4.1.2 的优先级合并。

---

## 13. 备选方案对比

| 方案 | 速度 | 可靠性 | 成本 | 适用 |
| --- | --- | --- | --- | --- |
| **A. 确定性脚本 + Actions（推荐）** | 秒级 | 高，可复现 | 免费 | 逐条收录 |
| B. Jules 直接改 catalog 开 PR | 5–60 分钟 | 中，输出不确定 | 免费 15 任务/天、3 并发 | 异常修复、一次性迁移 |
| C. 纯人工 | 分钟级 | 高 | 人力 | 现状 |
| D. GitHub Action 直接 push main（无 PR） | 秒级 | 高 | 免费 | 不推荐：丢审计与 CI 门禁 |

**最终建议：A 作为主路径；B 只做 G10 语义复核与异常修复；C 只保留「人工覆盖」开关。**

---

## 14. 待确认

1. 外部作者是否要自动合并，还是先只服务 owner 自己的客户端提交？（决定 `AUTO_MERGE_POLICY`）
2. 是否接受「PR 由 bot 直接 squash 合并」而暂不启用分支保护？（P1 vs P3）
3. Jules 评审是否保留？如果保留，需要 `JULES_API_KEY`；如果不保留，G10 整体删掉，流程更短。
