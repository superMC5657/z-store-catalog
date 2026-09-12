#!/usr/bin/env node

/**
 * add-app.mjs
 * 
 * Z-Store 应用极速收录工具：
 * 仅需输入 GitHub 仓库链接，全自动完成：
 * 1. 抓取 GitHub 仓库基本信息（Stars, Forks, License, Description, Homepage）；
 * 2. 检索最新 Release Tag 与产物 Asset 列表；
 * 3. 智能推断支持平台 (platforms) 与可执行文件名标识符 (identifiers)；
 * 4. 自动探测仓库高清 Logo / Icon；
 * 5. 交互式确认/微调（支持 -y / --yes 全自动无交互）；
 * 6. 格式化写入 publish/z-store-catalog/catalog.json；
 * 7. 若在本地工作区，自动同步至根目录客户端离线种子 (catalog.json)；
 * 8. 执行规范校验。
 * 
 * 用法:
 *   node scripts/add-app.mjs https://github.com/localsend/localsend
 *   pnpm add localsend/localsend
 *   pnpm add https://github.com/owner/repo --yes
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const catalogPath = path.join(rootDir, 'catalog.json');

// 标准分类映射与中文名称
const CATEGORIES = [
  { key: 'system', name: '系统实用', desc: '系统增强、文件管理、快捷启动、压缩工具' },
  { key: 'network', name: '网络工具', desc: '远程桌面、局域网互传、网络工具、下载器' },
  { key: 'media', name: '影音播放', desc: '影音播放、录屏推流、媒体转码、音乐播放' },
  { key: 'security', name: '安全加密', desc: '密码管理、加密工具、安全审计、双重验证' },
  { key: 'dev', name: '开发编程', desc: '代码编辑、终端模拟器、API调试、Git工具' },
  { key: 'graphics', name: '图形创作', desc: '图片查看、截图标注、3D建模、矢量设计' },
  { key: 'office', name: '办公协同', desc: '笔记文档、思维导图、个人生产力、PDF工具' },
  { key: 'reading', name: '阅读学习', desc: '电子书管理、RSS阅读器、文献管理' },
  { key: 'ops', name: '运维部署', desc: '容器管理、运维面板、网络监控、数据库管理' },
  { key: 'games', name: '休闲游戏', desc: '开源游戏引擎、游戏模拟器、游戏启动器' },
];

const CATEGORY_GRADIENTS = {
  system: 'linear-gradient(135deg, #475569, #334155)',
  network: 'linear-gradient(135deg, #0284c7, #0369a1)',
  media: 'linear-gradient(135deg, #ec4899, #be185d)',
  security: 'linear-gradient(135deg, #059669, #047857)',
  dev: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
  graphics: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
  office: 'linear-gradient(135deg, #d97706, #b45309)',
  reading: 'linear-gradient(135deg, #0d9488, #0f766e)',
  ops: 'linear-gradient(135deg, #4f46e5, #3730a3)',
  games: 'linear-gradient(135deg, #e11d48, #be123c)',
};

/**
 * 获取显式配置的 GitHub Token（仅读取 GITHUB_TOKEN 或 GH_TOKEN 环境变量）
 */
function resolveGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  return null;
}

/**
 * 解析命令行参数中的 GitHub 仓库
 */
function parseRepoInput(input) {
  if (!input) return null;
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/i, '') };
  }
  const parts = trimmed.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0].trim(), repo: parts[1].replace(/\.git$/i, '').trim() };
  }
  return null;
}

/**
 * 路径打分器：对单个仓库文件路径评分，优先选择应用官方高清图标/矢量Logo
 */
function scoreIconCandidate(filePath, size, repoName) {
  const lower = filePath.toLowerCase();
  const ext = path.extname(lower);
  if (ext !== '.png' && ext !== '.svg' && ext !== '.ico') return -100;

  // 排除无关或第三方依赖目录
  if (
    lower.includes('node_modules/') ||
    lower.includes('vendor/') ||
    lower.includes('tests/') ||
    lower.includes('test/') ||
    lower.includes('.github/') ||
    lower.includes('dist/') ||
    lower.includes('target/') ||
    lower.includes('ui-lightness') ||
    lower.includes('jquery')
  ) {
    return -100;
  }

  // 排除非 Logo 的营销或状态图片
  if (
    lower.includes('screenshot') ||
    lower.includes('preview') ||
    lower.includes('banner') ||
    lower.includes('badge') ||
    lower.includes('demo') ||
    lower.includes('diagram') ||
    lower.includes('architecture') ||
    lower.includes('cover')
  ) {
    return -50;
  }

  // 排除节日特殊主题图标（如 aprilfools, xmas）
  if (lower.includes('aprilfools') || lower.includes('xmas') || lower.includes('christmas')) {
    return -30;
  }

  // 排除 Git LFS 指针文本文件 (~130 字节)
  if (size && size < 300) {
    return -100;
  }

  let score = 0;
  const filename = path.basename(lower);
  const cleanRepo = (repoName || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. 文件名核心匹配
  if (['icon.png', 'app-icon.png', 'app_icon.png', 'logo.png', 'applogo.png'].includes(filename)) {
    score += 100;
  } else if (['icon.svg', 'logo.svg', 'app-icon.svg', 'app_icon.svg'].includes(filename)) {
    score += 95;
  } else if (cleanRepo && (filename === `${cleanRepo}.png` || filename === `${cleanRepo}.svg`)) {
    score += 90;
  } else if (['icon.ico', 'app.ico', 'logo.ico', '7ziplogo.ico'].includes(filename)) {
    score += 70;
  } else if (filename.includes('icon') || filename.includes('logo')) {
    score += 50;
  }

  // 2. 分辨率加权 (优先 512, 256, 1024, large 等高清图)
  if (lower.includes('512') || lower.includes('large') || lower.includes('hi-res') || lower.includes('hires') || lower.includes('1024')) {
    score += 40;
  } else if (lower.includes('256')) {
    score += 30;
  } else if (lower.includes('128')) {
    score += 20;
  } else if (lower.includes('64')) {
    score += 10;
  } else if (lower.includes('32')) {
    score += 5;
  } else if (lower.includes('16')) {
    score -= 20;
  }

  // 3. 语义目录加权
  if (lower.startsWith('res/') || lower.startsWith('assets/') || lower.startsWith('resources/') || lower.startsWith('media/') || lower.startsWith('public/')) {
    score += 25;
  }
  if (lower.includes('/app/') || lower.includes('/icon/') || lower.includes('/icons/') || lower.includes('src-tauri/icons')) {
    score += 20;
  }
  if (lower.includes('desktop') || lower.includes('packaging') || lower.includes('gtk/icons') || lower.includes('extra/logo')) {
    score += 15;
  }

  return score;
}

/**
 * 探测远程仓库中的高质量 Logo
 */
async function probeRepoLogo(owner, repo, headers, defaultBranch = 'HEAD') {
  // 1. 优先调用 GitHub Git Trees API 遍历全量仓库路径进行启发式智能推荐 (单次调用纵览全库且内置文件字节大小)
  try {
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
    const treeRes = await fetch(treeUrl, { headers, signal: AbortSignal.timeout(6000) });
    if (treeRes.ok) {
      const treeData = await treeRes.json();
      if (Array.isArray(treeData.tree)) {
        const scored = treeData.tree
          .filter((node) => node.type === 'blob' && typeof node.path === 'string')
          .map((node) => ({ path: node.path, score: scoreIconCandidate(node.path, node.size, repo), size: node.size }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);

        if (scored.length > 0) {
          const best = scored[0];
          return `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${best.path}`;
        }
      }
    }
  } catch (err) {
    // API 超时或受限时平滑降级至静态目录探测
  }

  // 2. 平滑降级：快速探测常见静态候选路径
  const candidatePaths = [
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/res/icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/assets/icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/assets/logo.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/assets/app-icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/src-tauri/icons/icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/buildResources/icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/public/icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/public/logo.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/public/app-icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/resources/icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/icon.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/logo.png`,
    `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/logo.svg`,
  ];

  for (const url of candidatePaths) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(2000) });
      if (res.status === 200) {
        const cType = res.headers.get('content-type') || '';
        const cLength = parseInt(res.headers.get('content-length') || '0', 10);
        if ((cType.startsWith('image/') || cType.includes('octet-stream') || cType.includes('svg')) && (cLength === 0 || cLength > 300)) {
          return url;
        }
      }
    } catch {
      // 忽略单个探测超时
    }
  }

  // 3. 终极兜底：回退为 GitHub 官方头像 CDN
  return `https://github.com/${owner}.png`;
}

/**
 * 根据 Release Asset 列表智能推断平台与 Windows / macOS / Linux 标识符
 */
function deducePlatformsAndIdentifiers(repoName, assets) {
  const assetNames = (assets || []).map((a) => (a.name || '').toLowerCase());
  const origAssetNames = (assets || []).map((a) => a.name || '');

  const platforms = new Set();
  const identifiers = {
    windows: [],
    linux: [],
    macos: [],
    android: [],
    ios: [],
  };

  let winExeGuess = `${repoName}.exe`;
  let macAppGuess = `${repoName}.app`;
  let linuxBinGuess = repoName.toLowerCase();

  // 1. 扫描 Windows 资产
  const hasWinAsset = assetNames.some((n) =>
    n.endsWith('.exe') || n.endsWith('.msi') || n.endsWith('.msix') || n.includes('win64') || n.includes('windows')
  );
  if (hasWinAsset || assetNames.length === 0) {
    platforms.add('windows');
    const foundExe = origAssetNames.find((n) => n.endsWith('.exe') && !n.includes('setup') && !n.includes('installer'));
    if (foundExe) {
      const cleanStem = foundExe.replace(/-[vV]?\d+.*\.exe$/i, '').replace(/\.exe$/i, '');
      winExeGuess = `${cleanStem}.exe`;
    }
    identifiers.windows.push(winExeGuess);
  }

  // 2. 扫描 macOS 资产
  const hasMacAsset = assetNames.some((n) =>
    n.endsWith('.dmg') || n.endsWith('.pkg') || n.includes('darwin') || n.includes('macos') || n.includes('mac')
  );
  if (hasMacAsset || assetNames.length === 0) {
    platforms.add('macos');
    identifiers.macos.push(macAppGuess);
  }

  // 3. 扫描 Linux 资产
  const hasLinuxAsset = assetNames.some((n) =>
    n.endsWith('.appimage') || n.endsWith('.deb') || n.endsWith('.rpm') || n.includes('linux')
  );
  if (hasLinuxAsset || assetNames.length === 0) {
    platforms.add('linux');
    identifiers.linux.push(linuxBinGuess);
  }

  // 4. 扫描 Android 资产
  const hasAndroidAsset = assetNames.some((n) => n.endsWith('.apk'));
  if (hasAndroidAsset) {
    platforms.add('android');
    identifiers.android.push(`org.${repoName.toLowerCase()}`);
  }

  // 5. 扫描 iOS 资产
  const hasIosAsset = assetNames.some((n) => n.endsWith('.ipa'));
  if (hasIosAsset) {
    platforms.add('ios');
    identifiers.ios.push(`org.${repoName.toLowerCase()}`);
  }

  // 若均未匹配到具体资产，默认赋予三大主流桌面端
  if (platforms.size === 0) {
    platforms.add('windows');
    platforms.add('macos');
    platforms.add('linux');
    identifiers.windows.push(winExeGuess);
    identifiers.macos.push(macAppGuess);
    identifiers.linux.push(linuxBinGuess);
  }

  return {
    platforms: Array.from(platforms),
    identifiers,
  };
}

/**
 * 自动推断最贴切的软件分类
 */
function guessCategory(desc, topics) {
  const text = `${desc || ''} ${(topics || []).join(' ')}`.toLowerCase();
  if (text.includes('remote') || text.includes('desktop') || text.includes('cleaner') || text.includes('launcher') || text.includes('file manager')) return 'system';
  if (text.includes('network') || text.includes('transfer') || text.includes('download') || text.includes('torrent') || text.includes('proxy') || text.includes('vpn')) return 'network';
  if (text.includes('player') || text.includes('video') || text.includes('audio') || text.includes('music') || text.includes('stream') || text.includes('record')) return 'media';
  if (text.includes('password') || text.includes('security') || text.includes('crypto') || text.includes('2fa') || text.includes('otp') || text.includes('authenticator')) return 'security';
  if (text.includes('editor') || text.includes('terminal') || text.includes('git') || text.includes('code') || text.includes('developer') || text.includes('api')) return 'dev';
  if (text.includes('image') || text.includes('paint') || text.includes('photo') || text.includes('screenshot') || text.includes('3d') || text.includes('svg')) return 'graphics';
  if (text.includes('note') || text.includes('markdown') || text.includes('pdf') || text.includes('office') || text.includes('todo') || text.includes('calendar')) return 'office';
  if (text.includes('book') || text.includes('reader') || text.includes('rss') || text.includes('epub') || text.includes('feed')) return 'reading';
  if (text.includes('docker') || text.includes('kubernetes') || text.includes('monitor') || text.includes('database') || text.includes('server')) return 'ops';
  if (text.includes('game') || text.includes('emulator') || text.includes('arcade')) return 'games';
  return 'dev';
}

/**
 * 保持标量数组单行排版格式化 JSON
 */
function formatCatalogJson(catalog) {
  const raw = JSON.stringify(catalog, null, 2);
  return raw.replace(/\[\s*\n([^\[\]\{\}]*?)\n\s*\]/g, (_match, inner) => {
    const items = inner.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    return `[${items}]`;
  }) + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const autoYes = args.includes('-y') || args.includes('--yes');
  const targetArg = args.find((a) => !a.startsWith('-'));

  console.log('✨ Z-Store 应用极速收录助手 (Add App Helper)\n');

  let rl = null;
  let repoTarget = parseRepoInput(targetArg);

  if (!repoTarget) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('👉 请输入 GitHub 仓库地址或 owner/repo (例如: localsend/localsend): ');
    repoTarget = parseRepoInput(answer);
    if (!repoTarget) {
      console.error('❌ 错误: 无效的 GitHub 仓库输入！');
      rl.close();
      process.exit(1);
    }
  }

  const { owner, repo } = repoTarget;
  console.log(`\n📡 正在从 GitHub API 检索 ${owner}/${repo} 的最新元数据...`);

  const token = resolveGitHubToken();
  const headers = {
    'User-Agent': 'ZStore-App-Adder/1.0.0',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
    console.log('🔑 已启用 GitHub Token 进行高速拉取 (5000次/小时)');
  } else {
    console.log('⚠️ 未检测到 Token，将使用公开匿名限额 (60次/小时)');
  }

  // 1. 抓取仓库主信息
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (repoRes.status === 404) {
    console.error(`❌ 找不到仓库: https://github.com/${owner}/${repo}`);
    if (rl) rl.close();
    process.exit(1);
  }
  if (!repoRes.ok) {
    console.error(`❌ GitHub API 请求失败: HTTP ${repoRes.status}`);
    if (rl) rl.close();
    process.exit(1);
  }
  const repoData = await repoRes.json();

  // 2. 抓取最新 Release 信息
  let latestRelease = null;
  try {
    const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, { headers });
    if (relRes.ok) {
      latestRelease = await relRes.json();
    }
  } catch {
    // 可选无 releases
  }

  // 3. 探测图标与推断平台
  console.log('🔍 正在自动探测高清矢量/PNG 图标并推断平台资产...');
  const detectedIcon = await probeRepoLogo(owner, repo, headers, repoData.default_branch || 'HEAD');
  const { platforms: deducedPlatforms, identifiers: deducedIdentifiers } = deducePlatformsAndIdentifiers(
    repoData.name,
    latestRelease?.assets
  );
  const guessedCategoryKey = guessCategory(repoData.description, repoData.topics);
  const defaultCategory = CATEGORIES.find((c) => c.key === guessedCategoryKey) || CATEGORIES[4];

  const defaultId = repoData.name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const defaultName = repoData.name;
  const defaultDesc = repoData.description || '开源跨平台应用';
  const defaultVersion = latestRelease?.tag_name || 'v0.1.0';
  const defaultLicense = repoData.license?.spdx_id || 'MIT';
  const defaultStars = repoData.stargazers_count ?? 0;
  const defaultForks = repoData.forks_count ?? 0;
  const defaultHomepage = repoData.homepage && repoData.homepage.startsWith('http')
    ? repoData.homepage
    : repoData.html_url;

  // 检查是否已存在
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const existingIndex = catalog.findIndex((item) => item.id === defaultId || (item.owner === owner && item.repo === repo));
  const existingItem = existingIndex >= 0 ? catalog[existingIndex] : null;

  let finalId = existingItem?.id || defaultId;
  let finalName = existingItem?.name || defaultName;
  let finalChineseName = existingItem?.chinese_name || '';
  let finalDesc = existingItem?.description || defaultDesc;
  let finalCategoryKey = existingItem?.category || defaultCategory.key;
  let finalIcon = (existingItem?.icon && !existingItem.icon.endsWith('.png')) ? existingItem.icon : detectedIcon;
  let finalPlatforms = existingItem?.platforms || deducedPlatforms;
  let finalIdentifiers = existingItem?.identifiers || deducedIdentifiers;
  let finalAliases = existingItem?.aliases || [];

  if (!autoYes) {
    if (!rl) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    console.log('\n──────── 🛠️ 请确认应用收录信息 (直接回车保持默认) ────────');
    
    const inId = await rl.question(`应用 ID [${finalId}]: `);
    if (inId.trim()) finalId = inId.trim().toLowerCase();

    const inName = await rl.question(`应用英文名称 [${finalName}]: `);
    if (inName.trim()) finalName = inName.trim();

    const inChinese = await rl.question(`应用中文显示名称 [${finalChineseName || '空'}]: `);
    if (inChinese.trim()) finalChineseName = inChinese.trim();

    console.log('\n可选分类列表:');
    CATEGORIES.forEach((c, idx) => {
      const marker = c.key === finalCategoryKey ? ' (当前/推荐)' : '';
      console.log(`  [${idx + 1}] ${c.key.padEnd(9)} - ${c.name} (${c.desc})${marker}`);
    });
    const currentCatIdx = CATEGORIES.findIndex((c) => c.key === finalCategoryKey) + 1;
    const inCat = await rl.question(`选择分类序号 [1-${CATEGORIES.length}, 默认: ${currentCatIdx}]: `);
    const catNum = parseInt(inCat.trim(), 10);
    if (!isNaN(catNum) && catNum >= 1 && catNum <= CATEGORIES.length) {
      finalCategoryKey = CATEGORIES[catNum - 1].key;
    }

    const inDesc = await rl.question(`中文简介 [${finalDesc}]: `);
    if (inDesc.trim()) finalDesc = inDesc.trim();

    const inIcon = await rl.question(`图标 URL [${finalIcon}]: `);
    if (inIcon.trim()) finalIcon = inIcon.trim();

    const inAliases = await rl.question(`搜索别名 (用逗号分隔，当前: ${finalAliases.join(', ') || '无'}): `);
    if (inAliases.trim()) {
      finalAliases = inAliases.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
  }

  if (rl) {
    rl.close();
  }

  const matchedCategory = CATEGORIES.find((c) => c.key === finalCategoryKey) || CATEGORIES[4];

  // 构建新条目对象
  const newEntry = {
    id: finalId,
    name: finalName,
    chinese_name: finalChineseName || undefined,
    owner,
    repo,
    icon: finalIcon,
    icon_bg: existingItem?.icon_bg || CATEGORY_GRADIENTS[finalCategoryKey] || 'linear-gradient(135deg, #2563eb, #1d4ed8)',
    description: finalDesc,
    category: finalCategoryKey,
    category_name: matchedCategory.name,
    aliases: finalAliases.length > 0 ? finalAliases : undefined,
    default_version: defaultVersion,
    license: defaultLicense,
    stars: defaultStars,
    forks: defaultForks,
    is_verified: true,
    publisher_fingerprint: existingItem?.publisher_fingerprint || undefined,
    homepage: defaultHomepage,
    platforms: finalPlatforms,
    identifiers: finalIdentifiers,
  };

  // 清理 undefined 属性
  Object.keys(newEntry).forEach((k) => newEntry[k] === undefined && delete newEntry[k]);

  if (existingIndex >= 0) {
    catalog[existingIndex] = { ...existingItem, ...newEntry };
    console.log(`\n🔄 已覆盖更新现有应用: ${finalId} (${finalName})`);
  } else {
    catalog.push(newEntry);
    console.log(`\n➕ 已成功追加新应用: ${finalId} (${finalName})`);
  }

  // 格式化写回 publish/z-store-catalog/catalog.json
  const formattedJson = formatCatalogJson(catalog);
  fs.writeFileSync(catalogPath, formattedJson, 'utf8');
  console.log(`💾 已写回清单仓库: ${path.relative(rootDir, catalogPath)}`);

  // 同步检测：若本地存在客户端根目录种子 catalog.json (../../catalog.json)，顺手一并同步！
  const clientCatalogPath = path.resolve(rootDir, '../../catalog.json');
  if (fs.existsSync(clientCatalogPath)) {
    fs.writeFileSync(clientCatalogPath, formattedJson, 'utf8');
    console.log(`🚀 已自动同步至客户端离线种子: ${path.relative(rootDir, clientCatalogPath)}`);
  }

  // 自动触发轻量数据合法性校验
  console.log('\n🔍 正在执行清单数据规范校验...');
  const validateScript = path.join(__dirname, 'validate-catalog.mjs');
  if (fs.existsSync(validateScript)) {
    try {
      execSync(`node "${validateScript}"`, { stdio: 'inherit' });
      console.log('\n🎉 收录流程全部完成！数据与格式 100% 合规。');
    } catch {
      console.error('\n⚠️ 校验脚本报异常，请排查。');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('\n❌ 运行时异常:', err);
  process.exit(1);
});
