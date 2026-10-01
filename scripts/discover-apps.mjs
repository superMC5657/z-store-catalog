#!/usr/bin/env node

/**
 * discover-apps.mjs
 *
 * Z-Store 热门开源软件全自动挖掘工具（零依赖，Node >= 18 原生 ESM）。
 * 产出 scripts/seed/auto-YYYY-MM-DD.json，可直接被 scripts/batch-add.mjs
 * 的 loadSeeds() 通配读入（seedDir/*.json，无校验，字段缺省由 batch-add 组装）。
 *
 * 种子字段（精简，id 由 batch-add 按 repo.toLowerCase() 生成）：
 *   { repo, category, name, description, description_en, aliases, allow_no_assets:false }
 *
 * 数据源优先级（任一失败只跳过不崩）：
 *   P0 GitHub Search API（必须 Bearer Token，认证 search 30/min，间隔 >= 2s）
 *   P1 HN Algolia（免 Key，回查 GitHub 取元数据）
 *   P2 Flathub（trending/popular/recently-added/recently-updated + appstream，
 *      仅保留 is_free_license == true，提取 GitHub 坐标回查）
 *   P3 OSSInsight trends（past_24_hours，rows 为空直接 skip）
 *
 * 二进制过滤（每候选仅 1 次 core 配额）：
 *   GET /repos/{full}/releases?per_page=10（单请求多取几条做 stable 优先），
 *   取 assets 满足 /\.(exe|msi|msix|dmg|pkg|AppImage|deb|rpm|apk|zip|tar\.gz)$/i
 *   && size > 1MB && 不含 .sha256/.sig/.txt；跳过 draft，prerelease 仅在无
 *   stable 可用时采用；404 / 空直接丢弃。并发 2 worker，全局间隔 >= 1.2s。
 *   无 Token 直接报错退出（匿名 60/hr 不够用），dry-run 模式除外（警告+跳过）。
 *
 * 用法:
 *   node scripts/discover-apps.mjs                                   # 默认挖掘 100 个
 *   node scripts/discover-apps.mjs --limit=50 --days=30 --stars=1000
 *   node scripts/discover-apps.mjs --out=scripts/seed/custom.json
 *   node scripts/discover-apps.mjs --dry-run --limit=5               # 只打印不写盘
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const catalogPath = path.join(rootDir, 'catalog.json');
const seedDir = path.join(__dirname, 'seed');

// ────────────────────────────── 参数解析 ──────────────────────────────
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const LIMIT = Math.max(1, parseInt(getArg('limit', '100'), 10) || 100);
const OUT_ARG = getArg('out', null);
const DRY_RUN = args.includes('--dry-run');
const DAYS = Math.max(1, parseInt(getArg('days', '30'), 10) || 30);
const STARS_MIN = Math.max(0, parseInt(getArg('stars', '1000'), 10) || 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toISODate = (d) => d.toISOString().slice(0, 10);

// 全局节流门：保证任意两次 GitHub core 请求之间至少间隔 ms
let nextSlot = 0;
async function throttle(ms) {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + ms;
  if (wait > 0) await sleep(wait);
}

// ────────────────────────────── 分类（复用 add-app.mjs guessCategory 逻辑） ──────────────────────────────
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

// ────────────────────────────── GitHub 请求封装 ──────────────────────────────
function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  return null;
}

function ghHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'z-store-catalog',
    Authorization: `Bearer ${token}`,
  };
}

// 带限速退避的 GitHub GET（看 x-ratelimit-remaining/reset，触发则等待后重试一次）
async function ghGet(url, token, timeoutMs = 20000) {
  let res = await fetch(url, { headers: ghHeaders(token), signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
    let waitMs = 65000;
    if (remaining === '0' && reset) waitMs = Math.max(0, reset * 1000 - Date.now()) + 1500;
    console.log(`⏳ GitHub 限速 (HTTP ${res.status})，等待 ${Math.ceil(waitMs / 1000)}s 后重试…`);
    await sleep(Math.min(waitMs, 180000));
    res = await fetch(url, { headers: ghHeaders(token), signal: AbortSignal.timeout(timeoutMs) });
  }
  return res;
}

// ────────────────────────────── P0: GitHub Search（pushed 时间窗切片） ──────────────────────────────
function pushedRangeQuery(start, end, useRange) {
  const pushed = useRange ? `pushed:${start}..${end}` : `pushed:>${start}`;
  return `stars:>${STARS_MIN} ${pushed} archived:false fork:false`;
}

async function searchSlice(query, token) {
  await throttle(2100); // search 认证 30/min → 间隔 >= 2s
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100&page=1`;
  const res = await ghGet(url, token);
  if (!res.ok) {
    console.log(`[search] query 失败 HTTP ${res.status}，本片跳过`);
    return { total: 0, items: [] };
  }
  const data = await res.json().catch(() => ({}));
  return { total: data.total_count || 0, items: Array.isArray(data.items) ? data.items : [] };
}

// total_count >= 1000 时按 pushed 时间窗对半切片（CI 默认每片只取第 1 页，最多切 4 片）
async function searchGitHub(token) {
  const out = [];
  const now = new Date();
  const startDate = toISODate(new Date(now.getTime() - DAYS * 86400000));
  const endDate = toISODate(now);
  let windows = [{ start: startDate, end: endDate, ranged: false }];
  for (let depth = 0; depth < 2; depth += 1) {
    const next = [];
    let needSplit = false;
    for (const w of windows) {
      const { total, items } = await searchSlice(pushedRangeQuery(w.start, w.end, w.ranged), token).catch(() => ({ total: 0, items: [] }));
      if (total >= 1000 && w.end > w.start) {
        needSplit = true;
        const mid = new Date((new Date(w.start).getTime() + new Date(w.end).getTime()) / 2);
        const midStr = toISODate(mid);
        if (midStr > w.start && midStr < w.end) {
          next.push({ start: w.start, end: midStr, ranged: true }, { start: midStr, end: w.end, ranged: true });
          continue;
        }
      }
      out.push(...items);
      next.push(w);
    }
    windows = next;
    if (!needSplit) break;
  }
  return out;
}

// ────────────────────────────── P1: HN Algolia（免 Key） ──────────────────────────────
const GITHUB_URL_RE = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;

function extractRepoFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(GITHUB_URL_RE);
  if (!m) return null;
  const repo = m[2].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(m[1]) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return `${m[1]}/${repo}`;
}

async function fetchHN() {
  const urls = [
    'https://hn.algolia.com/api/v1/search?query=opensource&tags=story&hitsPerPage=50&page=0',
    `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=${encodeURIComponent('points>50')}&hitsPerPage=50&page=0`,
  ];
  const repos = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'z-store-catalog' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = await res.json().catch(() => ({}));
      for (const hit of data.hits || []) {
        const full = extractRepoFromUrl(hit.url);
        if (full) repos.push(full);
      }
    } catch {
      // 单源失败跳过不崩
    }
  }
  return [...new Set(repos)];
}

// ────────────────────────────── P2: Flathub ──────────────────────────────
const FLATHUB_COLLECTIONS = ['trending', 'popular', 'recently-added', 'recently-updated'];

async function fetchFlathub() {
  const out = []; // { flathubId, full }
  const seenId = new Set();
  for (const col of FLATHUB_COLLECTIONS) {
    try {
      const res = await fetch(`https://flathub.org/api/v2/collection/${col}`, {
        headers: { 'User-Agent': 'z-store-catalog' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => []);
      const list = Array.isArray(data) ? data : data.results || data.apps || data.hits || [];
      const ids = list
        .map((it) => (typeof it === 'string' ? it : it.app_id || it.id || it.appId))
        .filter(Boolean)
        .filter((id) => !seenId.has(id))
        .slice(0, 25);
      for (const id of ids) {
        seenId.add(id);
        try {
          const aRes = await fetch(`https://flathub.org/api/v2/appstream/${id}`, {
            headers: { 'User-Agent': 'z-store-catalog' },
            signal: AbortSignal.timeout(15000),
          });
          if (!aRes.ok) continue;
          const app = await aRes.json().catch(() => null);
          if (!app) continue;
          const free = app.is_free_license ?? app.metadata?.is_free_license;
          if (free === false) {
            console.log(`[flathub] ${id} skipped(closed_source)`);
            continue;
          }
          const full = extractRepoFromUrl(JSON.stringify(app.urls || {})) || extractRepoFromUrl(JSON.stringify(app));
          if (!full) {
            console.log(`[flathub] ${id} skipped(no_github_link)`);
            continue;
          }
          out.push({ flathubId: id, full });
        } catch {
          // 单应用失败跳过
        }
      }
    } catch {
      // 单集合失败跳过不崩
    }
  }
  return out;
}

// ────────────────────────────── P3: OSSInsight ──────────────────────────────
async function fetchOSSInsight() {
  try {
    const res = await fetch('https://api.ossinsight.io/v1/trends/repos/?period=past_24_hours', {
      headers: { 'User-Agent': 'z-store-catalog' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const rows = data?.data?.rows || data.rows || (Array.isArray(data.data) ? data.data : []);
    if (!rows || rows.length === 0) return [];
    return rows.map((r) => r.repo_name || r.repo).filter(Boolean);
  } catch {
    return [];
  }
}

// ────────────────────────────── 二进制过滤 ──────────────────────────────
const BINARY_RE = /\.(exe|msi|msix|dmg|pkg|AppImage|deb|rpm|apk|zip|tar\.gz)$/i;
const SIG_RE = /\.sha256|\.sig|\.txt$/i;
const ONE_MB = 1024 * 1024;

function releasesHaveBinary(releases) {
  const live = (releases || []).filter((r) => !r.draft);
  if (live.length === 0) return false;
  // stable 优先，无 stable 才用 prerelease
  const ordered = [...live.filter((r) => !r.prerelease), ...live.filter((r) => r.prerelease)];
  return ordered.some((rel) =>
    (rel.assets || []).some(
      (a) => BINARY_RE.test(a.name || '') && (a.size || 0) > ONE_MB && !SIG_RE.test(a.name || ''),
    ),
  );
}

async function checkBinary(full, token) {
  const [owner, repo] = full.split('/');
  await throttle(1200);
  const res = await ghGet(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`, token, 15000);
  if (res.status === 404) return 'no_release';
  if (!res.ok) return `release_http_${res.status}`;
  const data = await res.json().catch(() => []);
  const list = Array.isArray(data) ? data : [];
  if (list.length === 0) return 'no_release';
  return releasesHaveBinary(list) ? null : 'no_binary_assets';
}

async function fetchRepo(full, token) {
  const [owner, repo] = full.split('/');
  await throttle(1200);
  const res = await ghGet(`https://api.github.com/repos/${owner}/${repo}`, token, 15000);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ────────────────────────────── 主流程 ──────────────────────────────
async function main() {
  const token = resolveToken();
  if (!token) {
    if (DRY_RUN) {
      console.log('⚠️ 未检测到 GITHUB_TOKEN/GH_TOKEN，dry-run 模式下降级：跳过 GitHub 依赖数据源，仅演示流程。');
    } else {
      console.error('❌ 未检测到 GITHUB_TOKEN/GH_TOKEN，挖掘必须携带 Token（匿名 60/hr 不够）。');
      console.error('   提示: $env:GITHUB_TOKEN="<token>"; node scripts/discover-apps.mjs');
      process.exit(1);
    }
  }

  // 去重基线：catalog.json 已有（小写 owner/repo）
  let existing = new Set();
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    existing = new Set(catalog.map((a) => `${a.owner}/${a.repo}`.toLowerCase()));
  } catch {
    console.log('⚠️ catalog.json 读取失败，去重基线为空。');
  }
  const seen = new Set();
  const kept = [];
  const needMore = () => kept.length < LIMIT;

  const log = (tag, full, status, reason) =>
    console.log(`[${tag}] ${full} ${status}${reason ? `(${reason})` : ''}`);

  // 候选归一化：repo JSON → 种子条目（字段仅 batch-add 消费所需；新 schema 无 chinese_name）
  const toSeed = (data) => ({
    repo: data.full_name,
    category: guessCategory(data.description, data.topics),
    name: data.name,
    description: data.description || `${data.name} 开源应用`,
    description_en: data.description || `${data.name} 开源应用`,
    aliases: Array.isArray(data.topics) ? data.topics.slice(0, 5) : [],
    allow_no_assets: false,
  });

  // 通用判定：去重 → 归档/fork → 二进制过滤 → 收录
  const consider = async (tag, full, preloaded, tk) => {
    const key = full.toLowerCase();
    if (existing.has(key)) {
      log(tag, full, 'skipped', 'dup_catalog');
      return;
    }
    if (seen.has(key)) {
      log(tag, full, 'skipped', 'dup_seen');
      return;
    }
    seen.add(key);
    let data = preloaded;
    if (!data) {
      data = await fetchRepo(full, tk).catch(() => null);
      if (!data) {
        log(tag, full, 'skipped', 'repo_unavailable');
        return;
      }
    }
    if (data.archived) {
      log(tag, full, 'skipped', 'archived');
      return;
    }
    const reason = await checkBinary(data.full_name || full, tk).catch(() => 'check_error');
    if (reason) {
      log(tag, full, 'skipped', reason);
      return;
    }
    kept.push(toSeed(data));
    log(tag, full, 'kept', null);
  };

  // 2 worker 并发池（全局 throttle 保证请求间隔 >= 1.2s）
  const runPool = async (tasks) => {
    let i = 0;
    const workers = [0, 1].map(async () => {
      while (needMore()) {
        const idx = i++;
        if (idx >= tasks.length) return;
        await tasks[idx]();
      }
    });
    await Promise.all(workers);
  };

  // —— P0 GitHub Search（search 条目自带完整 repo JSON，免去回查） ——
  if (token && needMore()) {
    try {
      const items = await searchGitHub(token);
      console.log(`🔍 [search] 召回 ${items.length} 个候选（stars>${STARS_MIN}，近 ${DAYS} 天活跃）`);
      const tasks = items.map((item) => async () => consider('search', item.full_name, item, token));
      await runPool(tasks);
    } catch (err) {
      console.log(`[search] 数据源异常跳过：${err?.message || err}`);
    }
  } else if (!token) {
    console.log('[search] 无 Token，跳过 GitHub Search。');
  }

  // —— P1 HN ——
  if (token && needMore()) {
    try {
      const repos = await fetchHN();
      console.log(`📰 [hn] 召回 ${repos.length} 个 GitHub 坐标`);
      const tasks = repos.map((full) => async () => consider('hn', full, null, token));
      await runPool(tasks);
    } catch (err) {
      console.log(`[hn] 数据源异常跳过：${err?.message || err}`);
    }
  }

  // —— P2 Flathub ——
  if (token && needMore()) {
    try {
      const pairs = await fetchFlathub();
      console.log(`📦 [flathub] 召回 ${pairs.length} 个开源 GitHub 坐标`);
      const tasks = pairs.map(({ full }) => async () => consider('flathub', full, null, token));
      await runPool(tasks);
    } catch (err) {
      console.log(`[flathub] 数据源异常跳过：${err?.message || err}`);
    }
  }

  // —— P3 OSSInsight ——
  if (token && needMore()) {
    try {
      const repos = await fetchOSSInsight();
      if (repos.length === 0) {
        console.log('[ossinsight] rows 为空，直接 skip');
      } else {
        console.log(`📈 [ossinsight] 召回 ${repos.length} 个趋势仓库`);
        const tasks = repos.map((full) => async () => consider('ossinsight', full, null, token));
        await runPool(tasks);
      }
    } catch (err) {
      console.log(`[ossinsight] 数据源异常跳过：${err?.message || err}`);
    }
  }

  const seeds = kept.slice(0, LIMIT);
  console.log(`\n──────────────────────────────────────`);
  console.log(`📊 挖掘完成: 收录 ${seeds.length} 个（去重基线 catalog ${existing.size} 条）`);

  if (DRY_RUN) {
    console.log('💡 DRY-RUN 模式仅打印不写盘：');
    console.log(JSON.stringify(seeds, null, 2));
    return;
  }

  const dateStr = toISODate(new Date());
  const outPath = OUT_ARG
    ? path.resolve(rootDir, OUT_ARG)
    : path.join(seedDir, `auto-${dateStr}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(seeds, null, 2)}\n`, 'utf8');
  console.log(`💾 已写入 ${path.relative(rootDir, outPath)}，可被 batch-add loadSeeds 直接消费`);
  console.log(`   下一步: node scripts/batch-add.mjs --dry-run`);
}

main().catch((err) => {
  console.error('❌ 运行时异常:', err?.message || err);
  process.exit(1);
});
