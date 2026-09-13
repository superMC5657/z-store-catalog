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
  "chinese_name": "LocalSend 局域网快传",
  "owner": "localsend",
  "repo": "localsend",
  "icon": "https://raw.githubusercontent.com/localsend/localsend/main/app/assets/img/logo-512.png",
  "icon_bg": "linear-gradient(135deg, #0284c7, #0369a1)",
  "description": "跨平台的开源局域网文件传输工具，无需互联网，基于安全协议高速传输。",
  "category": "network",
  "category_name": "网络工具",
  "aliases": ["局域网传输", "隔空投送", "快传", "airdrop", "file transfer"],
  "default_version": "v1.18.2",
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
- `chinese_name` / `description` / `aliases`: 中文显示名、一句话简介与搜索别名，供客户端展示与检索；
- `icon`: 应用官方高清图标 URL（优先仓库内资源；所有图标均经过存活性核验与人工目检）；
- `icon_bg`: 客户端渲染图标时的渐变底色，与分类对应；
- `category` / `category_name`: 分类键与中文名（`system` `network` `media` `security` `dev` `graphics` `office` `reading` `ops` `games`）；
- `platforms`: 支持的设备端（`windows`, `linux`, `macos`, `android`, `ios`）；
- `identifiers`: 各端原生识别符，供客户端本地已安装扫描与拉起使用；
- `default_version` / `stars` / `forks`: 由 CI 定时保鲜自动填充，提交 PR 时可省略。

---

## 🤝 贡献收录 (Contributing)

欢迎开源软件作者或社区爱好者向 Z-Store 提交优秀的开源软件！

详细提交流程与规范请参阅：👉 [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 🛠️ 本地维护脚本 (Scripts)

所有脚本均为零依赖的 Node 原生 ESM 脚本（Node ≥ 18）。

| 脚本 / 目录 | 作用 |
| --- | --- |
| `scripts/add-app.mjs` | **单应用交互收录**：输入 GitHub 链接，自动抓取元数据、推断平台与标识符、探测图标，交互确认后写入 catalog.json（支持 `-y` 全自动） |
| `scripts/batch-add.mjs` | **批量智能收录**：读取 `scripts/seed/` 候选清单逐个收录，内置 Release 二进制资产校验、四级图标探测（种子提示 → Git Trees 全库评分 → 静态路径 → 头像兜底）与实时字节验证；每成功一个立即写盘，中断可续跑，自动跳过已收录仓库 |
| `scripts/seed/*.json` | **候选种子库**：按 10 大分类维护的待收录应用清单（含中文名、简介、别名等人工文案）。重复执行会自动去重跳过已收录项，是扩充收录的入口 |
| `scripts/lib/catalog-shared.mjs` | **共享核心库**：分类定义、图标评分器、平台/标识符推断、JSON 排版格式化，供单应用与批量两条收录路径复用，保证产出格式一致 |
| `scripts/refresh-catalog.mjs` | **数据保鲜**：定时（CI）或手动刷新全部应用 Stars / Forks / 最新 Release Tag |
| `scripts/validate-catalog.mjs` | **规范校验**：检查必填字段、ID 唯一性、分类/平台合法性、图标 URL 格式，PR 自动化检查即此脚本 |
| `scripts/batch-report.json` | 批量收录的运行报告（生成物）：每个应用的图标来源、版本、淘汰原因，供人工审计 |

### 常用命令

```bash
# 极速一键收录新应用（全自动调 API 抓取、推断平台、探测图标并双向写入）
pnpm add:app <github-url-or-owner/repo>
# 或支持全自动无交互模式 (-y)
node scripts/add-app.mjs localsend/localsend -y

# 批量收录（需 GitHub Token，5000 次/小时限额）
GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs
# 仅核验种子不写入（dry-run）/ 仅处理指定分类或仓库
GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs --dry-run
GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs --category=dev --repo=owner/name

# 校验 catalog.json 格式与数据合法性
pnpm test

# 批量保鲜（自动获取最新 Stars、Forks 与 Release Tag）
pnpm refresh
```

---

## 📄 开源许可 (License)

本项目采用 [MIT License](./LICENSE)。
