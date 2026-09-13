/**
 * catalog-shared.mjs
 *
 * Z-Store 目录脚本共享库：
 * 供 add-app.mjs（单应用交互收录）与 batch-add.mjs（批量智能收录）复用，
 * 包含分类定义、图标探测评分器、平台标识符推断与 JSON 排版格式化。
 */

import path from 'node:path';

// 标准分类映射与中文名称
export const CATEGORIES = [
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

export const CATEGORY_GRADIENTS = {
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
export function resolveGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  return null;
}

/**
 * 路径打分器：对单个仓库文件路径评分，优先选择应用官方高清图标/矢量Logo
 */
export function scoreIconCandidate(filePath, size, repoName) {
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
 * 通过 jsDelivr 镜像实测图片字节（raw.githubusercontent 在部分网络不可达时用镜像验证）
 */
export async function verifyImageBytes(url, timeoutMs = 10000) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ZStore-Catalog/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return null;
    const type = res.headers.get('content-type') || '';
    const isImage = type.startsWith('image/') || type.includes('octet-stream') || type.includes('svg');
    if (!isImage) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 300) return null;
    return { bytes: buf.length, contentType: type };
  } catch {
    return null;
  }
}

/**
 * 生成 jsDelivr 镜像 URL（与 raw.githubusercontent 同源同文件）
 */
export function jsdelivrMirror(owner, repo, branch, filePath) {
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filePath.replace(/^\//, '')}`;
}

/**
 * 探测远程仓库中的高质量 Logo
 * 返回 { url, source, size? }，source ∈ trees | static | avatar
 */
export async function probeRepoLogo(owner, repo, headers, defaultBranch = 'HEAD') {
  // 1. 优先调用 GitHub Git Trees API 遍历全量仓库路径进行启发式智能推荐
  //    (单次调用纵览全库且内置文件字节大小，size ≥ 300 可直接排除 LFS 指针，无需二次请求验证)
  try {
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
    const treeRes = await fetch(treeUrl, { headers, signal: AbortSignal.timeout(12000) });
    if (treeRes.ok) {
      const treeData = await treeRes.json();
      if (Array.isArray(treeData.tree)) {
        const scored = treeData.tree
          .filter((node) => node.type === 'blob' && typeof node.path === 'string')
          .map((node) => ({ path: node.path, score: scoreIconCandidate(node.path, node.size, repo), size: node.size }))
          .filter((item) => item.score > 0 && (!item.size || item.size >= 300))
          .sort((a, b) => b.score - a.score || (b.size || 0) - (a.size || 0));

        if (scored.length > 0) {
          const best = scored[0];
          return { url: `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${best.path}`, source: 'trees', size: best.size };
        }
      }
    }
  } catch (err) {
    // API 超时或受限时平滑降级至静态目录探测
  }

  // 2. 平滑降级：探测常见静态候选路径（经 jsDelivr 镜像实测存在后返回 raw 权威 URL）
  const candidatePaths = [
    'res/icon.png',
    'assets/icon.png',
    'assets/logo.png',
    'assets/app-icon.png',
    'src-tauri/icons/icon.png',
    'buildResources/icon.png',
    'public/icon.png',
    'public/logo.png',
    'public/app-icon.png',
    'resources/icon.png',
    'icon.png',
    'logo.png',
    'logo.svg',
  ];

  for (const candidate of candidatePaths) {
    const verified = await verifyImageBytes(jsdelivrMirror(owner, repo, defaultBranch, candidate));
    if (verified) {
      return {
        url: `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${candidate}`,
        source: 'static',
        size: verified.bytes,
      };
    }
  }

  // 3. 终极兜底：GitHub 用户/组织头像 CDN（经 users API 获取，绕开 github.com 主站可达性限制）
  try {
    const userRes = await fetch(`https://api.github.com/users/${owner}`, { headers, signal: AbortSignal.timeout(8000) });
    if (userRes.ok) {
      const userData = await userRes.json();
      if (userData.avatar_url) {
        const avatar = `${userData.avatar_url}${userData.avatar_url.includes('?') ? '&' : '?'}s=200&v=4`;
        return { url: avatar, source: 'avatar', size: 0 };
      }
    }
  } catch {
    // 保持返回 null 由调用方处理
  }
  return null;
}

/**
 * 根据 Release Asset 列表智能推断平台与 Windows / macOS / Linux 标识符
 */
export function deducePlatformsAndIdentifiers(repoName, assets) {
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
 * 保持标量数组单行排版格式化 JSON
 */
export function formatCatalogJson(catalog) {
  const raw = JSON.stringify(catalog, null, 2);
  return raw.replace(/\[\s*\n([^\[\]\{\}]*?)\n\s*\]/g, (_match, inner) => {
    const items = inner.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    return `[${items}]`;
  }) + '\n';
}
