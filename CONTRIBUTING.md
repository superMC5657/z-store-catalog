# 贡献指南 (Contributing Guide)

感谢你关注并愿意为 **Z-Store** 生态贡献新的开源软件！

---

## 📋 收录准则 (Inclusion Criteria)

为保障广大用户的安全与优质体验，提交至本仓库的应用需满足以下基本原则：

1. **必须开源 (Open Source)**：拥有合法的开源协议（如 MIT, Apache-2.0, GPL, AGPL, BSD 等），且托管于公开代码仓库（GitHub / Codeberg / GitLab）；
2. **拥有正规 Releases 资产**：项目需具备可公开下载的二进制发布产物（如 `.exe`, `.msi`, `.zip`, `.dmg`, `.AppImage`, `.deb`, `.apk` 等）；
3. **安全与纯净**：不得含有任何恶意后门、流氓广告推装、挖矿代码或侵犯用户隐私行为；
4. **高质量与持续维护**：项目代码处于活跃或可用状态。

---

## 🚀 提交新应用步骤 (Step-by-Step)

### 1. Fork 本仓库并创建分支
```bash
git checkout -b add-my-app
```

### 2. 添加应用配置

#### 方式 A：通过 Issue 提交（推荐，客户端一键收录）
参见下方第 5 节「通过 Issue 提交」，由 `issue-to-pr.yml` 自动补全元数据并创建 PR。

#### 方式 B：手动新增 `apps/<owner>/<repo>.json`
在 `apps/<owner>/<repo>.json`（全小写路径）中新建应用清单文件，填入基础信息：

```json
{
  "id": "owner/repo",
  "name": "App Name",
  "owner": "owner",
  "repo": "repo",
  "icon": "https://raw.githubusercontent.com/owner/repo/main/logo.png",
  "icon_bg": "linear-gradient(135deg, #2563eb, #1d4ed8)",
  "description": "应用一句话中文简介",
  "description_en": "One-line English description (defaults to upstream GitHub repo description)",
  "category": "dev",
  "category_name": "开发编程",
  "aliases": ["appname", "keyword"],
  "default_version": "v1.0.0",
  "added_at": "2026-10-23",
  "license": "MIT",
  "stars": 1000,
  "forks": 50,
  "is_verified": true,
  "homepage": "https://example.com",
  "platforms": ["windows", "macos", "linux"],
  "identifiers": {
    "windows": ["AppName.exe"],
    "linux": ["appname"],
    "macos": ["AppName.app"],
    "android": [],
    "ios": []
  }
}
```

> 手动新增时，`added_at` 请填写提交当天的 UTC 日期（`YYYY-MM-DD` 格式）；合入 `main` 后 `build-catalog.yml` 会自动编译生成根目录 `catalog.json`。

#### 可选分类 (`category`):
- `system`: 系统增强、文件管理、快捷启动器、压缩工具
- `network`: 远程桌面、局域网互传、网络工具、下载器
- `media`: 影音播放、录屏推流、媒体转码
- `security`: 密码管理器、加密工具、安全审计
- `dev`: 代码编辑器、终端模拟器、调试工具
- `graphics`: 图像查看、截图标注、3D 建模设计
- `office`: 笔记文档、知识库、个人生产力
- `reading`: 电子书管理、阅读器、文献管理
- `ops`: 容器管理、运维面板、监控工具
- `games`: 开源游戏引擎、游戏模拟器、游戏启动器

### 3. 本地验证
在提交 PR 之前，请在终端运行编译与校验脚本：

```bash
node scripts/build-catalog.mjs
node scripts/validate-catalog.mjs
```

若输出 `✅ 校验通过！` 则说明数据格式符合规范。

### 4. 提交 Pull Request
提交 Commit 并发起 PR：
- Commit 信息建议形如：`feat(app): add <app-name>`；
- PR 提交后，GitHub Actions 会自动运行格式校验；
- 审核通过并合并后，全网 Z-Store 客户端将自动同步展示！

### 5. 通过 Issue 提交（客户端一键收录）

Z-Store 客户端「提交收录申请」会打开一个预填 Issue，正文包含 `### payload_json`。仓库的 `issue-to-pr.yml` 会自动：

1. 解析 payload，并从 GitHub API 补齐 stars / forks / license / 最新版本；
2. 缺 `platforms` / `identifiers` 时从最新 Release 资产推断，缺图标时自动探测；
3. 通过 `validate-catalog.mjs` 后创建 PR，并在合并后自动关闭 Issue。

维护者可以：
- 给 Issue 打 `update` 标签：更新已收录条目，而不是按重复关闭；
- 给 Issue 打 `auto-merge` 标签：在数据校验通过的前提下强制自动合并（PR 保持原样，不直接改动）；
- 看到 `needs-review` 标签：说明存在需要人工确认的字段（协议、图标、平台等）。

### 6. 合并门禁

所有合入 `main` 的 PR 均需通过 `catalog-ingest` 状态检查（由规则集保护）：

- **人工 PR**：由 `catalog-gate.yml` 基于 base 分支脚本校验 PR 内容后打上 `catalog-ingest=success`；
- **客户端 Issue PR**：由 `issue-to-pr.yml` 自动清洗补齐并写入 `catalog-ingest=success` 门禁状态，由维护者/作者核对后确认合并（亦可打 `auto-merge` 标签触发自动合并）；
- **每日 refresh PR**：由 `refresh-catalog.yml` 自动保鲜并写入 `catalog-ingest=success` 后合并。
