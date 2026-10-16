#!/usr/bin/env node

/**
 * batch-add.mjs
 *
 * Z-Store 批量智能收录工具：
 * 读取 scripts/seed/<date>/*.json 日期档候选清单（--date=YYYY-MM-DD 指定，默认当天 UTC），
 * 逐个抓取 GitHub 元数据并批量写入 catalog.json。
 *
 * 单个应用的处理流程（复用 scripts/lib/catalog-shared.mjs 共享库）：
 * 1. 抓取仓库元数据（Stars/Forks/License/Homepage/默认分支/归档状态）；
 * 2. 抓取最新 Release（版本号 + Asset 列表），校验存在可安装二进制；
 * 3. 图标探测：种子 hint → 品牌库 Simple Icons → 翻全家 Git Trees → 失败记 icon_unavailable；
 * 4. 每个图标 URL 实时验证（HTTP 200 + image/* + ≥300 字节非 LFS 指针）；
 * 5. 平台与 identifiers 推断（种子 hints 优先，修正 exe 名猜测偏差）；
 * 6. 组装条目追加到 catalog.json（保持标量数组单行排版）并同步客户端离线种子；
 * 6. 组装条目追加到 catalog.json（保持标量数组单行排版）并同步客户端离线种子；
 * 7. 产出同日期档 scripts/seed/<date>/batch-report.json（每应用状态/图标来源/失败原因）
 *    与同目录 seed-excluded.json（淘汰审计快照，历史条目合并保留；二者均在 deny 名单，不计入输入）。
 *    旧顶层 scripts/batch-report.json 已废弃，启动时一次性迁移进当天日期档。
 *
 * 用法:
 *   node scripts/batch-add.mjs --dry-run                 # 仅核验当天日期档种子，不写入任何文件
 *   node scripts/batch-add.mjs --date=2026-10-01 --dry-run --limit=2  # 核验指定日期档前 2 个种子
 *   node scripts/batch-add.mjs --category=dev            # 只处理指定分类
 *   node scripts/batch-add.mjs --repo=owner/name         # 只处理指定仓库
 *   node scripts/batch-add.mjs                           # 正式批量收录（支持中断续跑）
 *   node scripts/batch-add.mjs --seed-dir=scripts/seed   # 高级覆盖：种子根目录（默认 scripts/seed）
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
  todayAddedAt,
} from './lib/catalog-shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const catalogPath = path.join(rootDir, 'catalog.json');
const defaultSeedDir = path.join(__dirname, 'seed');

const BINARY_EXTS = /\.(exe|msi|msix|appx|dmg|pkg|appimage|deb|rpm|apk|flatpak|snap|jar)$/i;

// ────────────────────────────── 参数解析 ──────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const dryRun = args.includes('--dry-run');
const onlyCategory = getArg('category', null);
const onlyRepo = getArg('repo', null);
const limitArg = getArg('limit', null);
const limit = limitArg ? Math.max(1, parseInt(limitArg, 10) || 1) : Infinity;

// UTC 日期（与 discover-apps.mjs toISODate 同逻辑）；非法 --date 直接报错退出
const toISODate = (d) => d.toISOString().slice(0, 10);
const dateArg = getArg('date', null);
let dateStr = toISODate(new Date());
if (dateArg !== null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg) || Number.isNaN(Date.parse(`${dateArg}T00:00:00Z`))) {
    console.error(`❌ 非法 --date="${dateArg}"，需为 YYYY-MM-DD（如 --date=2026-10-01）。`);
    process.exit(1);
  }
  dateStr = dateArg;
}
// --seed-dir 高级覆盖（默认 scripts/seed；相对路径按仓库根解析）
const seedDirArg = getArg('seed-dir', null);
const seedDir = seedDirArg ? path.resolve(rootDir, seedDirArg) : defaultSeedDir;
// 输入与报告同日期档：scripts/seed/YYYY-MM-DD/（同一天覆盖，换天新建；seed/ 整体被 .gitignore 忽略）。
// 旧顶层 scripts/batch-report.json / scripts/seed-excluded.json 已废弃，启动时一次性迁移进当天日期档。
const runDir = path.join(seedDir, dateStr);
const reportPath = path.join(runDir, 'batch-report.json');
const excludedPath = path.join(runDir, 'seed-excluded.json');
const legacyReportPath = path.join(__dirname, 'batch-report.json');
const legacyExcludedPath = path.join(__dirname, 'seed-excluded.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────── 种子加载与去重 ──────────────────────────────
function loadSeeds() {
  // 只读本日期档 scripts/seed/<date>/*.json 输入种子（isFile 显式过滤 + 不递归）；
  // deny 名单明确跳过本档运行产物：batch-report*.json（含 -legacy 后缀归档）与 seed-excluded.json
  // 绝不作为输入。discover 产出 auto.json 视为合法输入（同目录即同批，可直接被消费，无需复制）。
  const DENY_EXACT = new Set(['seed-excluded.json']);
  const isReportFile = (name) => /^batch-report.*\.json$/.test(name);
  const seeds = [];
  let files = [];
  try {
    files = fs.readdirSync(runDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name)
      .sort();
  } catch {
    return seeds; // 日期档不存在视为空输入，由 main 报错提示可用 --date
  }
  for (const file of files) {
    if (DENY_EXACT.has(file) || isReportFile(file)) continue;
    const arr = JSON.parse(fs.readFileSync(path.join(runDir, file), 'utf8'));
    if (!Array.isArray(arr)) continue;
    for (const item of arr) seeds.push(item);
  }
  return seeds;
}

// 兼容旧顶层报告：一次性移入当天日期档（重名则加 -legacy 后缀，绝不覆盖），打印废弃提示后旧路径废弃
function migrateLegacyFile(legacyPath, baseName) {
  if (!fs.existsSync(legacyPath)) return;
  let target = path.join(runDir, baseName);
  if (fs.existsSync(target)) target = path.join(runDir, baseName.replace(/\.json$/, '-legacy.json'));
  if (fs.existsSync(target)) target = path.join(runDir, baseName.replace(/\.json$/, `-legacy-${Date.now()}.json`));
  try {
    fs.renameSync(legacyPath, target);
    console.log(`📦 旧文件 ${path.relative(rootDir, legacyPath)} 已归档至 ${path.relative(rootDir, target)}（旧顶层路径废弃，报告统一写入 scripts/seed/YYYY-MM-DD/）`);
  } catch (err) {
    console.log(`⚠️ 旧文件迁移失败（保留原位）：${err?.message || err}`);
  }
}

// 由本轮 report 构造淘汰审计条目（兼容历史 seed-excluded.json 快照格式：种子字段 + excluded 块）
function buildExcludedEntries(queue, report) {
  const byRepo = new Map(queue.map((s) => [String(s.repo).toLowerCase(), s]));
  const out = [];
  for (const r of report.results || []) {
    if (r.status === 'ok') continue;
    const seed = byRepo.get(String(r.repo || '').toLowerCase()) || {};
    const entry = {
      repo: seed.repo || r.repo,
      id: r.id,
      category: r.category,
      name: seed.name,
      description: seed.description,
      description_en: seed.description_en,
      aliases: seed.aliases,
      icon_hint: seed.icon_hint ?? null,
      excluded: {
        status: r.status,
        reason: r.reason || '',
        stars: r.stars ?? null,
        checkedAt: report.generatedAt,
        note: r.status === 'no_binary_assets'
          ? 'GitHub Release 无可安装二进制资产；若为自有渠道分发可在 seed 条目中加 "allow_no_assets": true'
          : '本轮批量收录未通过，详见同目录 batch-report.json',
      },
    };
    if (seed.allow_no_assets) entry.allow_no_assets = true;
    Object.keys(entry).forEach((k) => entry[k] === undefined && delete entry[k]);
    out.push(entry);
  }
  return out;
}

// seed-excluded.json 合并写盘：保留历史条目（本轮成功的从审计中移除，本轮淘汰的覆盖），按 repo 排序
function writeExcludedMerged(queue, report) {
  const merged = new Map();
  try {
    const prev = JSON.parse(fs.readFileSync(excludedPath, 'utf8'));
    if (Array.isArray(prev)) for (const e of prev) if (e?.repo) merged.set(String(e.repo).toLowerCase(), e);
  } catch {
    // 首轮尚无文件，视为空
  }
  const okRepos = new Set(
    (report.results || [])
      .filter((r) => r.status === 'ok')
      .map((r) => String(r.repo || '').toLowerCase()),
  );
  for (const k of okRepos) merged.delete(k);
  for (const e of buildExcludedEntries(queue, report)) merged.set(String(e.repo).toLowerCase(), e);
  const list = [...merged.values()].sort((a, b) => String(a.repo).localeCompare(String(b.repo)));
  fs.writeFileSync(excludedPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

function main() {
  const token = resolveGitHubToken();
  if (!token && !dryRun) {
    console.error('❌ 未检测到 GITHUB_TOKEN/GH_TOKEN，批量收录必须携带 Token（5000次/小时）。');
    console.error('   提示: GH_TOKEN=$(gh auth token) node scripts/batch-add.mjs');
    process.exit(1);
  }
  const headers = {
    'User-Agent': 'ZStore-Batch-Adder/1.0.0',
    'Accept': 'application/vnd.github.v3+json',
    ...(token ? { 'Authorization': `token ${token}` } : {}),
  };

  const seeds = loadSeeds();
  if (seeds.length === 0) {
    console.error(`❌ 日期档 ${path.relative(rootDir, runDir)} 内无可用输入种子（batch-report*.json / seed-excluded.json 明确跳过不计）。`);
    console.error('   归档 inputs 在 --date=2026-10-01，例如：node scripts/batch-add.mjs --date=2026-10-01 --dry-run --limit=2');
    process.exit(1);
  }
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  // ADR-0010：id 即小写 owner/repo，与仓库坐标一一对应，按坐标去重即可
  const existingByRepo = new Set(catalog.map((a) => `${a.owner}/${a.repo}`.toLowerCase()));

  // 种子内部去重
  const seenRepo = new Set();
  const queue = [];
  for (const seed of seeds) {
    if (!seed.repo) continue;
    const repoKey = String(seed.repo).toLowerCase();
    if (onlyRepo && seed.repo.toLowerCase() !== onlyRepo.toLowerCase()) continue;
    if (onlyCategory && seed.category !== onlyCategory) continue;
    if (existingByRepo.has(repoKey)) continue; // 已收录，跳过
    if (seenRepo.has(repoKey)) continue;
    seenRepo.add(repoKey);
    queue.push(seed);
  }

  const categoryNames = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.name]));
  console.log(`✨ Z-Store 批量收录助手${dryRun ? '（DRY-RUN 核验模式）' : ''}\n`);
  console.log(`📦 种子候选 ${queue.length} 个（日期档 ${path.relative(rootDir, runDir)}）${dryRun ? '' : '（已收录仓库自动跳过）'}${limit !== Infinity ? `（--limit=${limitArg} 取前 ${Math.min(limit, queue.length)} 个）` : ''}\n`);

  const runList = queue.slice(0, limit);

  // 无 Token dry-run：仅列候选，不请求网络、不写盘
  if (dryRun && !token) {
    console.log('⚠️ 未检测到 GITHUB_TOKEN/GH_TOKEN，dry-run 降级为仅列候选（不请求网络、不写盘）。');
    for (const s of runList) console.log(` - ${s.repo} [${s.category}] ${s.name || ''}`);
    console.log(`\n💡 DRY-RUN 未写入任何文件（候选 ${runList.length} 个，日期档 ${path.relative(rootDir, runDir)}）。`);
    return;
  }

  // 非 dry-run 才确保日期档存在并一次性迁移旧顶层报告（dry-run 不写盘；迁移提示后旧路径废弃）
  if (!dryRun) {
    fs.mkdirSync(runDir, { recursive: true });
    migrateLegacyFile(legacyReportPath, 'batch-report.json');
    migrateLegacyFile(legacyExcludedPath, 'seed-excluded.json');
  }
  const report = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'batch',
    counts: { total: runList.length, ok: 0, failed: 0 },
    results: [],
  };

  let idx = 0;
  runQueue(runList, idx, catalog, headers, report, categoryNames, existingByRepo);
}

async function runQueue(queue, idx, catalog, headers, report, categoryNames, existingByRepo) {
  while (idx < queue.length) {
    const seed = queue[idx];
    idx += 1;
    const result = await processSeed(seed, headers, categoryNames);
    report.results.push(result);
    const isOk = result.status === 'ok';
    if (isOk) report.counts.ok += 1;
    else report.counts.failed += 1;

    const tag = isOk ? '✅' : '❌';
    console.log(`${tag} [${idx}/${queue.length}] ${seed.repo} → ${result.status}${result.reason ? ` (${result.reason})` : ''}`);

    // 非 dry-run 且成功时立即写盘（崩溃可续跑；dry-run 不写盘）
    if (!dryRun && isOk) {
      catalog.push(result.entry);
      const formatted = formatCatalogJson(catalog);
      fs.writeFileSync(catalogPath, formatted, 'utf8');
      const clientCatalogPath = path.resolve(rootDir, '../../catalog.json');
      if (fs.existsSync(clientCatalogPath)) fs.writeFileSync(clientCatalogPath, formatted, 'utf8');
      existingByRepo.add(`${result.entry.owner}/${result.entry.repo}`.toLowerCase());
    }

    // dry-run 不写盘：报告与淘汰审计仅非 dry-run 落盘
    if (!dryRun) {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
      writeExcludedMerged(queue, report);
    }
    await sleep(120);
  }

  // 空队列直接结束时也落盘，保证每次运行日期档内都有报告（dry-run 除外，不写盘）
  if (!dryRun) {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    writeExcludedMerged(queue, report);
  }

  console.log(`\n──────────────────────────────────────`);
  console.log(`📊 完成: 成功 ${report.counts.ok} / 失败 ${report.counts.failed}`);
  if (dryRun) console.log('💡 DRY-RUN 模式未写入任何文件（核验输出仅打印）。');
  else console.log(`💾 catalog.json 已更新，详细结果见 ${path.relative(rootDir, reportPath)}`);
}

async function processSeed(seed, headers, categoryNames) {
  const base = { repo: seed.repo, id: seed.repo.toLowerCase(), category: seed.category };
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

    // 3. 图标探测（种子 hint → 品牌库 Simple Icons → 翻全家 Git Trees → 失败记 icon_unavailable）
    const branch = repoData.default_branch || 'HEAD';
    const probed = await probeRepoLogo(realOwner, realRepo, headers, branch, seed.icon_hint);
    if (!probed) return { ...base, status: 'icon_unavailable', reason: '所有图标探测均失败', stars: repoData.stargazers_count };

    const iconUrl = probed.url;
    const iconSource = probed.source;
    const iconBytes = probed.size || 0;

    // 4. 平台与标识符推断
    const deduced = deducePlatformsAndIdentifiers(repoData.name, release?.assets);
    let platforms = deduced.platforms;
    const identifiers = deduced.identifiers;
    if (Array.isArray(seed.platforms_hint) && seed.platforms_hint.length > 0) platforms = seed.platforms_hint;
    if (seed.identifiers_hint) {
      for (const [p, ids] of Object.entries(seed.identifiers_hint)) identifiers[p] = ids;
    }
    if (seed.android_id && identifiers.android.length > 0) identifiers.android = [seed.android_id];

    // 5. 组装条目（新 schema：description 中文 + description_en 英文原文，不写 chinese_name；
    //    兼容旧种子一次性读取：历史 chinese_name 仅作 description 缺失时的回退，不再写出）
    const matchedCategory = CATEGORIES.find((c) => c.key === seed.category) || CATEGORIES[0];
    const entry = {
      id: seed.repo.toLowerCase(),
      name: seed.name || repoData.name,
      owner: realOwner,
      repo: realRepo,
      icon: iconUrl,
      icon_bg: CATEGORY_GRADIENTS[seed.category] || 'linear-gradient(135deg, #2563eb, #1d4ed8)',
      description: seed.description || seed.chinese_name || repoData.description || '开源跨平台应用',
      description_en: seed.description_en || repoData.description || undefined,
      category: seed.category,
      category_name: categoryNames[seed.category] || matchedCategory.name,
      aliases: Array.isArray(seed.aliases) ? seed.aliases : undefined,
      default_version: release?.tag_name || 'unknown',
      added_at: todayAddedAt(), // 收录日期（UTC, YYYY-MM-DD；已收录仓库会被跳过，仅新条目写入）
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
      status: 'ok',
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
