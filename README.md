# Z-Store Catalog

<p align="center">
  <img src="https://raw.githubusercontent.com/superMC5657/z-store/main/src-tauri/icons/128x128.png" width="96" height="96" alt="Z-Store Logo" />
</p>

<p align="center">
  <b>Z-Store 官方开源应用收录清单与生态数据仓库</b><br>
  Official Open-Source Application Catalog & Manifest Repository for <a href="https://github.com/superMC5657/z-store">Z-Store</a>.
</p>

<p align="center">
  <a href="./catalog.json"><img src="https://img.shields.io/badge/Apps-341-blue.svg" alt="Apps Count" /></a>
  <a href="./scripts/validate-catalog.mjs"><img src="https://img.shields.io/badge/Validation-Passing-brightgreen.svg" alt="Validation" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License" /></a>
</p>

---

## 📖 简介 (Introduction)

本仓库是 [Z-Store](https://github.com/superMC5657/z-store)（基于 Tauri 2 + Rust 的跨平台开源应用商店）的官方数据源仓库。

参照成熟包管理器（如 Homebrew Cask、Winget-pkgs、Scoop Bucket）的工程实践，我们将**生态内容数据**与**客户端运行时引擎**彻底解耦。本仓库负责：
- 集中收录与维护全球优秀的开源软件；
- 提供各平台（Windows / macOS / Linux / Android / iOS）原生标识符定义与分类索引；
- 通过 GitHub Actions 全自动保鲜上游 Star 数、Fork 数与最新 Release Tag；
- 接受来自开源社区的收录 PR。

---

## 📦 数据结构 (Manifest Schema)

清单根文件为 [`catalog.json`](./catalog.json)，数据结构规范如下：

```json
{
  "id": "localsend",
  "name": "LocalSend",
  "owner": "localsend",
  "repo": "localsend",
  "icon": "https://raw.githubusercontent.com/localsend/localsend/main/app/assets/img/logo-512.png",
  "icon_bg": "linear-gradient(135deg, #0284c7, #0369a1)",
  "description": "跨平台的开源局域网文件传输工具，无需互联网，基于安全协议高速传输。",
  "description_en": "An open-source cross-platform alternative to AirDrop.",
  "category": "network",
  "category_name": "网络工具",
  "aliases": ["局域网传输", "隔空投送", "快传", "airdrop", "file transfer"],
  "default_version": "v1.18.2",
  "added_at": "2026-10-16",
  "license": "Apache-2.0",
  "stars": 90581,
  "forks": 5051,
  "is_verified": true,
  "homepage": "https://localsend.org",
  "platforms": ["windows", "macos", "linux", "android", "ios"],
  "identifiers": {
    "windows": ["localsend_app.exe", "LocalSend.exe"],
    "linux": ["localsend", "localsend_app"],
    "macos": ["LocalSend.app"],
    "android": ["org.localsend.localsend_app"],
    "ios": ["org.localsend.localsendApp"]
  }
}
```

### 字段说明
- `id`: 唯一标识符，小写字母、数字与连字符；
- `description` / `description_en` / `aliases`: 中文简介、英文原文简介与搜索别名，供客户端展示与检索（`description` 为中文人工文案，`description_en` 默认取 GitHub 仓库英文原文）；
- `icon`: 应用官方高清图标 URL（优先仓库内资源；所有图标均经过存活性核验与人工目检）；
- `icon_bg`: 客户端渲染图标时的渐变底色，与分类对应；
- `category` / `category_name`: 分类键与中文名（`system` `network` `media` `security` `dev` `graphics` `office` `reading` `ops` `games`）；
- `platforms`: 支持的设备端（`windows`, `linux`, `macos`, `android`, `ios`）；
- `identifiers`: 各端原生识别符，供客户端本地已安装扫描与拉起使用；
- `default_version` / `stars` / `forks`: 由 CI 定时保鲜自动填充，提交 PR 时可省略。
- `added_at`: 该应用被收录进 `catalog.json` 的日期（UTC，`YYYY-MM-DD` 格式），由收录脚本自动填入当天日期；保鲜脚本只更新动态字段，绝不改动此字段。其中 2026-10-16 为无 git 历史可查条目的回填占位日期（工作区新增），前两档 2026-09-10 / 2026-09-13 为 git 历史首次出现日。

---

## 🤝 贡献收录 (Contributing)

欢迎开源软件作者或社区爱好者向 Z-Store 提交优秀的开源软件！

详细提交流程与规范请参阅：👉 [CONTRIBUTING.md](./CONTRIBUTING.md)

### Issue → 自动 PR

客户端「提交收录申请」生成的 Issue 只要正文包含 `### payload_json`，`.github/workflows/issue-to-pr.yml` 会自动：

1. 用 `scripts/ingest-issue.mjs` 解析单条或批量 payload，并按 `owner/repo` 去重；
2. 用 `scripts/validate-catalog.mjs` 同款规则校验，失败时在 Issue 下回复具体原因；
3. 追加到 `catalog.json`，推送 `catalog/issue-<n>` 分支并创建 PR（正文含 `Closes #<n>`）。

维护者只需 review / merge。首次启用需满足任一条件：

- 仓库设置开启 `Settings → Actions → General → Allow GitHub Actions to create and approve pull requests`；
- 或配置 `CATALOG_BOT_TOKEN` secret（fine-grained PAT，`contents` / `pull-requests` / `issues` 读写）。使用 PAT 时自动 PR 还会触发 `validate-pr.yml`。

### Jules 维护代理（可选）

仓库根 `AGENTS.md` 规定了清单字段顺序、校验命令与提交规范，Jules 会自动读取。两种用法：

1. **API 工作流**：在 Jules 设置页生成 API key，添加为仓库 secret `JULES_API_KEY`；然后在 Actions → `Jules Maintenance` → Run workflow，选择：
   - `catalog-audit`：检查失效/改名仓库、错误分类、过期简介、与产物不符的平台；
   - `fix-ci`：复现并修复 `main` 上的 CI 失败；
   - `custom`：自行填写任务。

   未配置 `JULES_API_KEY` 时工作流会跳过，不会报错。默认每月 1 日 03:00 UTC 跑一次 `catalog-audit`，不需要可删除 workflow 里的 `schedule`。

2. **`jules` 标签**：安装 Jules GitHub App 并授权本仓库后，给维护类 Issue 打 `jules` 标签，Jules 会接管并开 PR。**不要**给公开发布收录申请 Issue 打该标签——那条链路已由 `issue-to-pr.yml` 处理，避免重复 PR 和配额浪费。

Jules 官方目前仅保证英文；中文提示词可用，但产出仍需人工复核。免费额度为 15 个任务/天。

### Jules 评审（合并前第一道门）

`jules-pr-review.yml` 在 PR 打开或更新时：

1. 用 `main` 上的 `validate-catalog.mjs` 校验 PR 的 `catalog.json`（不执行 PR 里的脚本）；失败则评论并停止；
2. 收录 PR 只允许改动 `catalog.json`；
3. 让 Jules 读 PR diff，输出 `VERDICT: APPROVE|REJECT` 与 `REASON`；
4. 把结论评论到 PR，并打 `jules-approved` / `jules-rejected` 标签。

**它不合并 PR。** 维护者看过结论后手动 merge；Jules 只是第一道语义门，不替代 schema 校验和最终 review。

`REJECT` 会让 `Jules PR Review` check 变红（仍可手动 merge）；如果希望变成硬门禁，可在 branch protection 中把该 check 设为 required。

所有同仓库、非 draft 的 PR 都会评审（fork PR 跳过）；自动生成的收录 PR 由 `issue-to-pr.yml` 显式触发评审。

需要 `JULES_API_KEY`。Jules 结论是 LLM 判断，不是安全保证；API 为 `v1alpha`，免费额度 15 任务/天。每次 push / ready_for_review 都会重新评审，消耗 1 个任务；频繁推送会消耗配额。

---

## 🛠️ 本地维护脚本 (Scripts)

所有脚本均为零依赖的 Node 原生 ESM 脚本（Node ≥ 18）。

| 脚本 / 目录 | 作用 |
| --- | --- |
| `scripts/add-app.mjs` | **单应用交互收录**：输入 GitHub 链接，自动抓取元数据、推断平台与标识符、探测图标，交互确认后写入 catalog.json（支持 `-y` 全自动） |
| `scripts/batch-add.mjs` | **批量智能收录**：读取 `scripts/seed/YYYY-MM-DD/` 日期档候选清单逐个收录（`--date` 指定，默认当天 UTC），内置 Release 二进制资产校验、四级图标探测（种子提示 → Git Trees 全库评分 → 静态路径 → 头像兜底）与实时字节验证；每成功一个立即写盘，中断可续跑，自动跳过已收录仓库 |
| `scripts/discover-apps.mjs` | **热门挖掘**：全自动挖掘热门开源软件，产出同日期档 `auto.json`；与 batch-add 用同一 `--date` 即同一批输入，可直接被消费 |
| `scripts/seed/YYYY-MM-DD/*.json` | **候选种子库**：按日期归档的待收录应用清单（含中文简介、英文简介、别名等人工文案；`batch-report*.json` / `seed-excluded.json` 为运行产物，不计入输入）。重复执行会自动去重跳过已收录项，是扩充收录的入口 |
| `scripts/lib/catalog-shared.mjs` | **共享核心库**：分类定义、图标评分器、平台/标识符推断、JSON 排版格式化，供单应用与批量两条收录路径复用，保证产出格式一致 |
| `scripts/refresh-catalog.mjs` | **数据保鲜**：定时（CI）或手动刷新全部应用 Stars / Forks / 最新 Release Tag |
| `scripts/validate-catalog.mjs` | **规范校验**：检查必填字段、ID 唯一性、分类/平台合法性、图标 URL 格式，PR 自动化检查即此脚本 |
| `scripts/ingest-issue.mjs` | **Issue 自动收录**：解析收录申请 Issue 正文的 `payload_json`，按 owner/repo 去重、复用校验规则后追加 `catalog.json`；由 `.github/workflows/issue-to-pr.yml` 在 Issue 创建时自动调用并开 PR |
| `scripts/review-pr.mjs` | **Jules PR 评审**：创建只读 Jules session 评审 PR diff，解析 `VERDICT: APPROVE|REJECT`，输出结论 JSON 与 PR 评论；由 `.github/workflows/jules-pr-review.yml` 调用，结论作为人工合并前的第一道参考 |
| `scripts/seed/YYYY-MM-DD/` | 按日期归档的种子与运行产物（git 忽略，同日覆盖、换日新建）：输入种子（含 discover 挖掘 `auto.json`）+ batch-add 报告 `batch-report.json`（每应用状态/图标来源/失败原因）+ 淘汰审计 `seed-excluded.json` |

### 常用命令

```bash
# 极速一键收录新应用（全自动调 API 抓取、推断平台、探测图标并双向写入）
pnpm add:app <github-url-or-owner/repo>
# 或支持全自动无交互模式 (-y)
node scripts/add-app.mjs localsend/localsend -y

# 批量收录（需 GitHub Token，5000 次/小时限额；种子按日期档读写，--date 指定，默认当天 UTC）
GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs
# 仅核验种子不写入（dry-run）/ 仅处理指定分类或仓库
GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs --dry-run
GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs --date=2026-10-01 --dry-run --limit=2
GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs --category=dev --repo=owner/name

# 热门挖掘（产出同日期档 auto.json，与 batch-add 用同一 --date 即同一批输入）
node scripts/discover-apps.mjs --date=2026-10-01 --limit=50

# 校验 catalog.json 格式与数据合法性
pnpm test

# 批量保鲜（自动获取最新 Stars、Forks 与 Release Tag）
pnpm refresh
```

---

## 📄 开源许可 (License)

本项目采用 [MIT License](./LICENSE)。
