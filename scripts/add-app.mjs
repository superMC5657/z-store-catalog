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
import {
  CATEGORIES,
  CATEGORY_GRADIENTS,
  resolveGitHubToken,
  probeRepoLogo,
  deducePlatformsAndIdentifiers,
  formatCatalogJson,
} from './lib/catalog-shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const catalogPath = path.join(rootDir, 'catalog.json');

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
  const detectedLogo = await probeRepoLogo(owner, repo, headers, repoData.default_branch || 'HEAD');
  const detectedIcon = detectedLogo.url;
  const { platforms: deducedPlatforms, identifiers: deducedIdentifiers } = deducePlatformsAndIdentifiers(
    repoData.name,
    latestRelease?.assets
  );
  const guessedCategoryKey = guessCategory(repoData.description, repoData.topics);
  const defaultCategory = CATEGORIES.find((c) => c.key === guessedCategoryKey) || CATEGORIES[4];

  // ADR-0010：id 即全局唯一坐标 owner/repo（小写），不再人工指定 slug
  const defaultId = `${owner}/${repo}`.toLowerCase();
  const defaultName = repoData.name;
  const defaultDesc = repoData.description || '开源跨平台应用';
  const defaultVersion = latestRelease?.tag_name || 'v0.1.0';
  const defaultLicense = repoData.license?.spdx_id || 'MIT';
  const defaultStars = repoData.stargazers_count ?? 0;
  const defaultForks = repoData.forks_count ?? 0;
  const defaultHomepage = repoData.homepage && repoData.homepage.startsWith('http')
    ? repoData.homepage
    : repoData.html_url;

  // 检查是否已存在（ADR-0010：按 owner/repo 坐标去重，大小写不敏感）
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const repoCoord = `${owner}/${repo}`.toLowerCase();
  const existingIndex = catalog.findIndex(
    (item) => `${item.owner}/${item.repo}`.toLowerCase() === repoCoord
  );
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
    console.log(`应用 ID (自动生成): ${finalId}`);

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
