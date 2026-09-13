#!/usr/bin/env node

/**
 * batch-add.mjs
 *
 * Z-Store 批量智能收录工具：
 * 读取 scripts/seed/*.json 中的候选应用清单，逐个抓取 GitHub 元数据并批量写入 catalog.json。
 *
 * 单个应用的处理流程（复用 scripts/lib/catalog-shared.mjs 共享库）：
 * 1. 抓取仓库元数据（Stars/Forks/License/Homepage/默认分支/归档状态）；
 * 2. 抓取最新 Release（版本号 + Asset 列表），校验存在可安装二进制；
 * 3. 图标探测：种子 icon_hint 精确命中 → Git Trees 全库评分 → 静态路径 → 头像兜底；
 * 4. 每个图标 URL 实时验证（HTTP 200 + image/* + ≥300 字节非 LFS 指针）；
 * 5. 平台与 identifiers 推断（种子 hints 优先，修正 exe 名猜测偏差）；
 * 6. 组装条目追加到 catalog.json（保持标量数组单行排版）并同步客户端离线种子；
 * 7. 产出 scripts/batch-report.json（每应用状态/图标来源/失败原因）。
 *
 * 用法:
 *   node scripts/batch-add.mjs --dry-run                 # 仅核验种子，不写入
 *   node scripts/batch-add.mjs --category=dev            # 只处理指定分类
 *   node scripts/batch-add.mjs --repo=owner/name         # 只处理指定仓库
 *   node scripts/batch-add.mjs                           # 正式批量收录（支持中断续跑）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  CATEGORY_GRADIENTS,
  resolveGitHubToken,
  probeRepoLogo,
  deducePlatformsAndIdentifiers,
  formatCatalogJson,
  verifyImageBytes,
  jsdelivrMirror,
} from './lib/catalog-shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const catalogPath = path.join(rootDir, 'catalog.json');
const seedDir = path.join(__dirname, 'seed');
const reportPath = path.join(__dirname, 'batch-report.json');

const BINARY_EXTS = /\.(exe|msi|msix|appx|dmg|pkg|appimage|deb|rpm|apk|flatpak|snap|jar)$/i;

// ────────────────────────────── 参数解析 ──────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyCategory = args.find((a) => a.startsWith('--category='))?.split('=')[1] || null;
const onlyRepo = args.find((a) => a.startsWith('--repo='))?.split('=')[1] || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────── 种子加载与去重 ──────────────────────────────
function loadSeeds() {
  const seeds = [];
  const files = fs.readdirSync(seedDir).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(seedDir, file), 'utf8'));
    for (const item of arr) seeds.push(item);
  }
  return seeds;
}

function main() {
  const token = resolveGitHubToken();
  if (!token) {
    console.error('❌ 未检测到 GITHUB_TOKEN/GH_TOKEN，批量收录必须携带 Token（5000次/小时）。');
    console.error('   提示: GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs');
    process.exit(1);
  }
  const headers = {
    'User-Agent': 'ZStore-Batch-Adder/1.0.0',
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${token}`,
  };

  const seeds = loadSeeds();
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const existingByRepo = new Set(catalog.map((a) => `${a.owner}/${a.repo}`.toLowerCase()));
  const existingById = new Set(catalog.map((a) => a.id.toLowerCase()));

  // 种子内部去重
  const seenRepo = new Set();
  const seenId = new Set();
  const queue = [];
  for (const seed of seeds) {
    const repoKey = seed.repo.toLowerCase();
    if (onlyRepo && seed.repo.toLowerCase() !== onlyRepo.toLowerCase()) continue;
    if (onlyCategory && seed.category !== onlyCategory) continue;
    if (existingByRepo.has(repoKey)) continue; // 已收录，跳过
    if (seenRepo.has(repoKey) || seenId.has(seed.id.toLowerCase())) continue;
    if (existingById.has(seed.id.toLowerCase())) continue; // id 与现有冲突，跳过
    seenRepo.add(repoKey);
    seenId.add(seed.id.toLowerCase());
    queue.push(seed);
  }

  const categoryNames = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.name]));
  console.log(`✨ Z-Store 批量收录助手${dryRun ? '（DRY-RUN 核验模式）' : ''}\n`);
  console.log(`📦 种子候选 ${queue.length} 个${dryRun ? '' : '（已收录仓库自动跳过）'}\n`);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'batch',
    counts: { total: queue.length, ok: 0, ok_fallback_icon: 0, failed: 0 },
    results: [],
  };

  let idx = 0;
  runQueue(queue, idx, catalog, headers, report, categoryNames, existingByRepo, existingById);
}

async function runQueue(queue, idx, catalog, headers, report, categoryNames, existingByRepo, existingById) {
  while (idx < queue.length) {
    const seed = queue[idx];
    idx += 1;
    const result = await processSeed(seed, headers, categoryNames);
    report.results.push(result);
    const isOk = result.status === 'ok' || result.status === 'ok_fallback_icon';
    if (isOk) report.counts[result.status] += 1;
    else report.counts.failed += 1;

    const tag = result.status === 'ok' ? '✅' : result.status === 'ok_fallback_icon' ? '⚠️ ' : '❌';
    console.log(`${tag} [${idx}/${queue.length}] ${seed.repo} → ${result.status}${result.reason ? ` (${result.reason})` : ''}`);

    // 非 dry-run 且成功时立即写盘（崩溃可续跑）
    if (!dryRun && isOk) {
      catalog.push(result.entry);
      const formatted = formatCatalogJson(catalog);
      fs.writeFileSync(catalogPath, formatted, 'utf8');
      const clientCatalogPath = path.resolve(rootDir, '../../catalog.json');
      if (fs.existsSync(clientCatalogPath)) fs.writeFileSync(clientCatalogPath, formatted, 'utf8');
      existingByRepo.add(`${result.entry.owner}/${result.entry.repo}`.toLowerCase());
      existingById.add(result.entry.id.toLowerCase());
    }

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    await sleep(120);
  }

  console.log(`\n──────────────────────────────────────`);
  console.log(`📊 完成: 成功 ${report.counts.ok} / 兜底图标 ${report.counts.ok_fallback_icon} / 失败 ${report.counts.failed}`);
  if (dryRun) console.log('💡 DRY-RUN 模式未写入 catalog.json，详细结果见 scripts/batch-report.json');
  else console.log('💾 catalog.json 已更新，详细结果见 scripts/batch-report.json');
}

async function processSeed(seed, headers, categoryNames) {
  const base = { repo: seed.repo, id: seed.id, category: seed.category };
  const [owner, repoName] = seed.repo.split('/');

  try {
    // 1. 仓库元数据
    let repoRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, { headers, signal: AbortSignal.timeout(20000) });
    if (repoRes.status === 403 || repoRes.status === 429) {
      await sleep(65000);
      repoRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, { headers, signal: AbortSignal.timeout(20000) });
    }
    if (repoRes.status === 404) return { ...base, status: 'repo_not_found' };
    if (!repoRes.ok) return { ...base, status: 'error', reason: `repo HTTP ${repoRes.status}` };
    const repoData = await repoRes.json();
    if (repoData.archived && !seed.allow_archived) {
      return { ...base, status: 'archived', reason: '仓库已归档不再维护', stars: repoData.stargazers_count };
    }

    // 使用规范化后的 owner/repo（应对仓库改名/转移）
    const realOwner = repoData.owner.login;
    const realRepo = repoData.name;
    const realRepoKey = `${realOwner}/${realRepo}`;
    if (realRepoKey.toLowerCase() !== seed.repo.toLowerCase()) {
      return { ...base, status: 'repo_not_found', reason: `仓库已迁移至 ${realRepoKey}` };
    }

    // 2. 最新 Release（带资产筛选）：
    //    latest 不可用或无资产时回退扫描 release 列表，取最近一个带可安装资产的版本，
    //    兼容全部标记为 pre-release 的仓库与"最新版走自有渠道、历史版走 GH"的仓库。
    const hasBinAssets = (r) => (r?.assets || []).some((a) => !/^source code/i.test(a.name || ''));
    let release = null;
    const relRes = await fetch(`https://api.github.com/repos/${realOwner}/${realRepo}/releases/latest`, { headers, signal: AbortSignal.timeout(20000) });
    if (relRes.ok) {
      const latest = await relRes.json();
      if (hasBinAssets(latest)) release = latest;
    }
    if (!release) {
      const listRes = await fetch(`https://api.github.com/repos/${realOwner}/${realRepo}/releases?per_page=20`, { headers, signal: AbortSignal.timeout(20000) });
      if (listRes.ok) {
        const data = await listRes.json().catch(() => []);
        const list = Array.isArray(data) ? data : [];
        const live = list.filter((r) => !r.draft);
        release = live.find((r) => !r.prerelease && hasBinAssets(r))
          || live.find((r) => hasBinAssets(r))
          || live.find((r) => !r.prerelease)
          || live[0]
          || null;
      }
    }
    if (!release && seed.allow_no_assets) {
      // 无 Release 的特例应用：退化取最新 tag 作为版本号
      try {
        const tagRes = await fetch(`https://api.github.com/repos/${realOwner}/${realRepo}/tags?per_page=1`, { headers, signal: AbortSignal.timeout(15000) });
        if (tagRes.ok) {
          const tags = await tagRes.json();
          if (Array.isArray(tags) && tags.length > 0) release = { tag_name: tags[0].name, assets: [] };
        }
      } catch {
        // 保持 release 为 null
      }
    }
    if (!release && !seed.allow_no_assets) {
      return { ...base, status: 'no_binary_assets', reason: '无正式 Release', stars: repoData.stargazers_count };
    }
    const assets = (release?.assets || []).filter((a) => !/^source code/i.test(a.name || ''));
    if (assets.length === 0 && !seed.allow_no_assets) {
      return { ...base, status: 'no_binary_assets', reason: '最近 Release 均无可安装资产', stars: repoData.stargazers_count };
    }

    // 3. 图标探测 + 实时验证
    //    raw.githubusercontent.com 在部分网络不可达：size 校验走 Git Trees 元数据，
    //    内容校验走 jsDelivr 镜像；catalog 中始终保存 raw 权威 URL。
    const branch = repoData.default_branch || 'HEAD';
    let iconUrl = null;
    let iconSource = null;
    let iconBytes = 0;

    if (seed.icon_hint) {
      const candidate = seed.icon_hint.replace(/^\//, '');
      const verified = await verifyImageBytes(jsdelivrMirror(realOwner, realRepo, branch, candidate));
      if (verified) {
        iconUrl = `https://raw.githubusercontent.com/${realOwner}/${realRepo}/${branch}/${candidate}`;
        iconSource = 'hint';
        iconBytes = verified.bytes;
      }
    }
    if (!iconUrl) {
      // 探测两次（首次可能瞬时超时），仍失败才接受头像兜底
      for (let attempt = 0; attempt < 2 && !iconUrl; attempt += 1) {
        if (attempt > 0) await sleep(400);
        const probed = await probeRepoLogo(realOwner, realRepo, headers, branch);
        if (!probed || probed.source === 'avatar') continue;
        if (probed.source === 'trees' && (!probed.size || probed.size < 300)) continue;
        iconUrl = probed.url;
        iconSource = probed.source;
        iconBytes = probed.size || 0;
      }
    }
    if (!iconUrl) {
      // 终极兜底：GitHub 用户/组织头像 CDN（报告中标记，供人工修正）
      try {
        const userRes = await fetch(`https://api.github.com/users/${realOwner}`, { headers, signal: AbortSignal.timeout(8000) });
        if (userRes.ok) {
          const userData = await userRes.json();
          if (userData.avatar_url) {
            iconUrl = `${userData.avatar_url}${userData.avatar_url.includes('?') ? '&' : '?'}s=200&v=4`;
            iconSource = 'avatar';
            const verified = await verifyImageBytes(iconUrl);
            iconBytes = verified ? verified.bytes : 0;
          }
        }
      } catch {
        // 保持 iconUrl 为空
      }
    }
    if (!iconUrl) return { ...base, status: 'icon_unavailable', reason: '所有图标探测均失败', stars: repoData.stargazers_count };

    // 4. 平台与标识符推断
    const deduced = deducePlatformsAndIdentifiers(repoData.name, release?.assets);
    let platforms = deduced.platforms;
    const identifiers = deduced.identifiers;
    if (Array.isArray(seed.platforms_hint) && seed.platforms_hint.length > 0) platforms = seed.platforms_hint;
    if (seed.identifiers_hint) {
      for (const [p, ids] of Object.entries(seed.identifiers_hint)) identifiers[p] = ids;
    }
    if (seed.android_id && identifiers.android.length > 0) identifiers.android = [seed.android_id];

    // 5. 组装条目
    const matchedCategory = CATEGORIES.find((c) => c.key === seed.category) || CATEGORIES[0];
    const entry = {
      id: seed.id,
      name: seed.name || repoData.name,
      chinese_name: seed.chinese_name || undefined,
      owner: realOwner,
      repo: realRepo,
      icon: iconUrl,
      icon_bg: CATEGORY_GRADIENTS[seed.category] || 'linear-gradient(135deg, #2563eb, #1d4ed8)',
      description: seed.description || repoData.description || '开源跨平台应用',
      category: seed.category,
      category_name: categoryNames[seed.category] || matchedCategory.name,
      aliases: Array.isArray(seed.aliases) ? seed.aliases : undefined,
      default_version: release?.tag_name || 'unknown',
      license: repoData.license?.spdx_id || 'Unknown',
      stars: repoData.stargazers_count ?? 0,
      forks: repoData.forks_count ?? 0,
      is_verified: true,
      homepage: repoData.homepage && repoData.homepage.startsWith('http') ? repoData.homepage : repoData.html_url,
      platforms,
      identifiers,
    };
    Object.keys(entry).forEach((k) => entry[k] === undefined && delete entry[k]);

    return {
      ...base,
      status: iconSource === 'avatar' ? 'ok_fallback_icon' : 'ok',
      iconUrl,
      iconSource,
      iconBytes,
      version: release?.tag_name ?? 'unknown',
      license: entry.license,
      stars: entry.stars,
      platforms,
      identifiers,
      entry,
    };
  } catch (err) {
    return { ...base, status: 'error', reason: String(err?.message || err) };
  }
}

main();
