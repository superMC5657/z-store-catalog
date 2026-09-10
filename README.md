# Z-Store Catalog

<p align="center">
  <img src="https://raw.githubusercontent.com/superMC5657/z-store/main/src-tauri/icons/128x128.png" width="96" height="96" alt="Z-Store Logo" />
</p>

<p align="center">
  <b>Z-Store 官方开源应用收录清单与生态数据仓库</b><br>
  Official Open-Source Application Catalog & Manifest Repository for <a href="https://github.com/superMC5657/z-store">Z-Store</a>.
</p>

<p align="center">
  <a href="./catalog.json"><img src="https://img.shields.io/badge/Apps-39-blue.svg" alt="Apps Count" /></a>
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
  "category": "network",
  "description": "开源且跨平台的局域网文件与消息互传利器",
  "owner": "localsend",
  "repo": "localsend",
  "forge": "github",
  "icon": "https://raw.githubusercontent.com/localsend/localsend/main/assets/img/logo-512.png",
  "platforms": [
    "windows",
    "macos",
    "linux",
    "android",
    "ios"
  ],
  "identifiers": {
    "windows": ["LocalSend.exe"],
    "linux": ["localsend_app", "localsend"],
    "macos": ["LocalSend.app"],
    "android": ["org.localsend.localsend_app"],
    "ios": ["org.localsend.localsendApp"]
  },
  "default_version": "v1.17.0",
  "stars": 60500,
  "forks": 3800,
  "license": "Apache-2.0"
}
```

### 字段说明
- `id`: 唯一标识符，小写字母、数字与连字符；
- `platforms`: 支持的设备端（`windows`, `linux`, `macos`, `android`, `ios`）；
- `identifiers`: 各端原生识别符，供客户端本地已安装扫描与拉起使用；
- `default_version` / `stars` / `forks`: 由 CI 定时保鲜自动填充，提交 PR 时可省略。

---

## 🤝 贡献收录 (Contributing)

欢迎开源软件作者或社区爱好者向 Z-Store 提交优秀的开源软件！

详细提交流程与规范请参阅：👉 [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 🛠️ 本地维护脚本 (Scripts)

```bash
# 校验 catalog.json 格式与数据合法性
pnpm test
# 或
node scripts/validate-catalog.mjs

# 自动保鲜（拉取 GitHub 最新 Stars 与 Release Tag）
GITHUB_TOKEN=your_token node scripts/refresh-catalog.mjs
```

---

## 📄 开源许可 (License)

本项目采用 [MIT License](./LICENSE)。
