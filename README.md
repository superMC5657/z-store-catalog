# Z-Store Catalog

<p align="center">
  <img src="https://raw.githubusercontent.com/superMC5657/z-store/main/src-tauri/icons/128x128.png" width="96" height="96" alt="Z-Store Logo" />
</p>

<p align="center">
  <b>Z-Store 官方开源应用收录清单与生态数据仓库</b><br>
  Official Open-Source Application Catalog & Manifest Repository for <a href="https://github.com/superMC5657/z-store">Z-Store</a>.
</p>

<p align="center">
  <a href="./catalog.json"><img src="https://img.shields.io/badge/Apps-373-blue.svg" alt="Apps Count" /></a>
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
  "id": "localsend/localsend",
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
- `id`: 唯一标识符，必须为小写 `owner/repo`（如 `localsend/localsend`）；
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

---

## 📁 目录结构 (Directory Layout)

```text
z-store-catalog/
├── apps/                  # 【唯一真源】按 <owner>/<repo>.json 拆分的独立应用清单，PR 只改对应文件
├── scripts/               # 维护脚本（编译、校验、Issue 入库、定时保鲜）与单元测试
│   └── lib/               # 共享核心库（分类定义、图标探测评分、平台推断、JSON 格式化）
├── .github/workflows/     # GitHub Actions 自动化流水线（Issue 转 PR、PR 门禁、自动编译、每日保鲜）
├── docs/                  # 自动化收录与门禁机制说明文档
├── catalog.json           # 【编译产物】由 scripts/build-catalog.mjs 从 apps/ 自动汇总，供客户端拉取
├── AGENTS.md              # 维护者与 AI 代理操作规范
├── CONTRIBUTING.md        # 社区贡献指南
└── package.json           # 脚本快捷命令与 ESM 模块声明
```

---

## 🛠️ 本地维护脚本 (Scripts)

所有脚本均为零依赖的 Node 原生 ESM 脚本（Node ≥ 18）。

| 脚本 | 作用 |
| --- | --- |
| `scripts/ingest-issue.mjs` | **收录 Issue 自动入库**：解析 Issue 正文的 `payload_json`，从 GitHub API 补齐 stars/forks/license/platforms/identifiers/icon，校验后生成 `apps/<owner>/<repo>.json`；CI 由 `.github/workflows/issue-to-pr.yml` 调用，默认 dry-run |
| `scripts/build-catalog.mjs` | **聚合编译器**：扫描 `apps/<owner>/<repo>.json` 独立清单，校验排序后编译生成根目录 `catalog.json` |
| `scripts/lib/catalog-shared.mjs` | **共享核心库**：分类定义、图标评分器、平台/标识符推断、JSON 排版格式化 |
| `scripts/refresh-catalog.mjs` | **数据保鲜**：定时（CI）或手动刷新全部应用 Stars / Forks / 最新 Release Tag |
| `scripts/validate-catalog.mjs` | **规范校验**：检查必填字段、ID 唯一性、分类/平台合法性、图标 URL 格式，PR 自动化检查即此脚本 |

### 常用命令

```bash
# 从 apps/ 编译生成根目录 catalog.json
pnpm build

# 校验 catalog.json 格式与数据合法性
pnpm test

# 运行单测
pnpm test:ingest

# 批量保鲜（自动获取最新 Stars、Forks 与 Release Tag）
pnpm refresh
```

---

## 📄 开源许可 (License)

本项目采用 [MIT License](./LICENSE)。
