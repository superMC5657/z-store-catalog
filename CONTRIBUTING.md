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

#### 方式 A：极速智能收录（推荐，10 秒搞定）
运行自动收录脚本，输入 GitHub 仓库地址，脚本会自动抓取 Stars、Forks、Releases 产物、推断支持平台并探测高清 Logo：

```bash
pnpm add:app <github-repo-url>
# 或
node scripts/add-app.mjs <owner/repo>
```

#### 方式 B：手动在 `catalog.json` 末尾追加
在 `catalog.json` 数组中添加一项，填入基础信息：

```json
{
  "id": "app-unique-id",
  "name": "App Name",
  "category": "develop",
  "description": "应用一句话中文简介",
  "owner": "github-username",
  "repo": "repository-name",
  "forge": "github",
  "icon": "https://raw.githubusercontent.com/owner/repo/main/logo.png",
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
在提交 PR 之前，请在终端运行校验脚本：

```bash
node scripts/validate-catalog.mjs
```

若输出 `✅ 校验通过！` 则说明数据格式符合规范。

### 4. 提交 Pull Request
提交 Commit 并发起 PR：
- Commit 信息建议形如：`feat(app): add <app-name>`；
- PR 提交后，GitHub Actions 会自动运行格式校验；
- 审核通过并合并后，全网 Z-Store 客户端将自动同步展示！
