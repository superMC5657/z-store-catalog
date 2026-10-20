#!/usr/bin/env node

/**
 * ingest-issue.mjs
 *
 * 把收录申请 Issue 正文里的 `### payload_json` 合并进 catalog.json。
 *
 * 设计原则：
 * 1. 确定性优先：schema/格式化/去重由脚本完成，不依赖 LLM；
 * 2. payload 只当数据：动态字段（stars/forks/license/version）以 GitHub API 为准；
 * 3. 缺字段自动补齐：platforms/identifiers 从最新 Release 资产推断，icon 自动探测；
 * 4. 不静默降级：补不齐或质量存疑时写进 needsReview/reasons，交给 workflow 决定是否自动合并；
 * 5. 默认 dry-run，必须显式 --write 才落盘。
 *
 * 用法:
 *   node scripts/ingest-issue.mjs --issue 5 --repo owner/repo --write
 *   node scripts/ingest-issue.mjs --body-file issue.md --no-enrich
 *   node scripts/ingest-issue.mjs --issue 5 --repo owner/repo --dry-run --out result.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  CATEGORY_GRADIENTS,
  deducePlatformsAndIdentifiers,
  formatCatalogJson,
  guessCategory,
  probeRepoLogo,
  resolveGitHubToken,
  todayAddedAt,
} from './lib/catalog-shared.mjs';
import { validateCatalog } from './validate-catalog.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PAYLOAD_HEADING = '### payload_json';
const MAX_ENTRIES = 50;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DESCRIPTION = 500;
const MAX_ALIASES = 20;

const IDENTIFIER_ORDER = ['windows', 'linux', 'macos', 'android', 'ios'];
const VALID_PLATFORMS = new Set(IDENTIFIER_ORDER);
const OSI_LICENSES = new Set([
  'MIT', 'Apache-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0',
  'AGPL-3.0', 'MPL-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'Unlicense', 'Zlib', 'BSL-1.0', 'EPL-2.0', 'CC0-1.0', 'MS-PL',
]);

// 与 catalog.json 磁盘顺序一致，保证自动写入不产生无意义 diff。
const FIELD_ORDER = [
  'id', 'name', 'owner', 'repo', 'icon', 'icon_bg',
  'description', 'description_en', 'category', 'category_name',
  'aliases', 'default_version', 'added_at', 'license',
  'stars', 'forks', 'is_verified', 'homepage', 'platforms', 'identifiers',
];

const STRING_FIELDS = [
  'id', 'name', 'owner', 'repo', 'icon', 'description', 'description_en',
  'category', 'license', 'default_version', 'homepage',
];

function usage() {
  console.error(
    [
      '用法: node scripts/ingest-issue.mjs [选项]',
      '  --issue <number>          读取该 Issue 正文（需 GITHUB_TOKEN/GH_TOKEN 或公开仓库）',
      '  --repo <owner/repo>       Issue 所在仓库；默认取 GITHUB_REPOSITORY',
      '  --body-file <path>        直接读取本地 Issue 正文（与 --issue 二选一）',
      '  --catalog <path>          catalog.json 路径；默认仓库根目录',
      '  --out <path>              写入机器可读结果 JSON',
      '  --pr-body <path>          写入 PR 正文',
      '  --pr-title <path>         写入 PR 标题',
      '  --comment <path>          写入 Issue 评论素材（成功/重复）',
      '  --failure-comment <path>  写入失败说明（Issue 评论用）',
      '  --write                   实际写入 catalog.json（默认 dry-run）',
      '  --update                  允许更新已收录条目（否则按重复处理）',
      '  --no-enrich               不调用 GitHub API / 不探测图标（离线测试用）',
      '  --dry-run                 只解析与校验，不写 catalog.json（默认行为）',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = {
    catalog: path.join(rootDir, 'catalog.json'),
    write: false,
    update: false,
    enrich: true,
  };
  const valueFlags = new Set([
    '--issue', '--repo', '--body-file', '--catalog', '--out',
    '--pr-body', '--pr-title', '--comment', '--failure-comment',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (valueFlags.has(flag)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${flag} 缺少取值`);
      args[flag.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
    } else if (flag === '--write') {
      args.write = true;
    } else if (flag === '--dry-run') {
      args.write = false;
    } else if (flag === '--update') {
      args.update = true;
    } else if (flag === '--no-enrich') {
      args.enrich = false;
    } else if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${flag}`);
    }
  }

  if (!args.bodyFile && !args.issue) throw new Error('必须提供 --issue 或 --body-file');
  if (!args.repo) args.repo = process.env.GITHUB_REPOSITORY || '';
  if (!args.bodyFile && !args.repo) {
    throw new Error('读取远程 Issue 时必须提供 --repo 或 GITHUB_REPOSITORY');
  }
  if (!args.bodyFile && !/^\d+$/.test(String(args.issue))) {
    throw new Error(`--issue 必须是数字: ${args.issue}`);
  }
  return args;
}

function apiHeaders() {
  const headers = {
    'User-Agent': 'ZStore-Issue-Ingest/1.0',
    Accept: 'application/vnd.github+json',
  };
  const token = resolveGitHubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(url, headers, { allow404 = false } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (res.status === 404 && allow404) return null;
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`GitHub API ${res.status}: ${url}`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError || new Error(`GitHub API 请求失败: ${url}`);
}

async function loadIssue(args) {
  if (args.bodyFile) {
    const body = fs.readFileSync(args.bodyFile, 'utf8');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new Error(`Issue 正文超过 ${MAX_BODY_BYTES} 字节上限`);
    }
    return {
      number: args.issue ? Number(args.issue) : null,
      title: '',
      body,
      html_url: '',
      user: null,
      author_association: null,
      labels: [],
    };
  }

  const url = `https://api.github.com/repos/${args.repo}/issues/${args.issue}`;
  const issue = await apiGet(url, apiHeaders());
  if (!issue || typeof issue.body !== 'string') {
    throw new Error(`读取 Issue 失败: ${url}`);
  }
  if (Buffer.byteLength(issue.body, 'utf8') > MAX_BODY_BYTES) {
    throw new Error(`Issue 正文超过 ${MAX_BODY_BYTES} 字节上限`);
  }
  return issue;
}

/**
 * 从 Issue 正文中提取 `### payload_json` 后的第一个 ```json 代码块。
 * 支持单对象与批量数组。
 */
export function extractPayload(body) {
  if (typeof body !== 'string' || !body.includes(PAYLOAD_HEADING)) {
    throw new Error(`Issue 正文缺少 '${PAYLOAD_HEADING}' 小节`);
  }
  const section = body.slice(body.indexOf(PAYLOAD_HEADING));
  const match = section.match(/```json\s*\r?\n([\s\S]*?)```/i);
  if (!match) throw new Error('payload_json 小节缺少 ```json 代码块');
  const text = match[1].trim();
  if (!text) throw new Error('payload_json 代码块为空');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`payload_json 不是合法 JSON: ${err.message}`);
  }
}

export function itemCoord(item) {
  // 显式 owner/repo 优先于 id：id 是派生字段，不能让 payload 用 id 冒充另一个仓库。
  if (item && typeof item.owner === 'string' && typeof item.repo === 'string') {
    const owner = item.owner.trim().toLowerCase();
    const repo = item.repo.trim().toLowerCase().replace(/\.git$/i, '');
    if (owner && repo) return `${owner}/${repo}`;
  }
  if (item && typeof item.id === 'string') {
    const id = item.id.trim().toLowerCase();
    if (/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(id)) return id;
  }
  return null;
}

function orderedIdentifiers(identifiers) {
  const ordered = {};
  for (const key of IDENTIFIER_ORDER) ordered[key] = identifiers[key] || [];
  return ordered;
}

function normalizeHomepage(value, fallback) {
  let homepage = typeof value === 'string' ? value.trim() : '';
  if (!homepage) homepage = typeof fallback === 'string' ? fallback.trim() : '';
  if (!homepage) return undefined;
  if (!/^https?:\/\//i.test(homepage)) homepage = `https://${homepage}`;
  try {
    const url = new URL(homepage);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    return homepage;
  } catch {
    return typeof fallback === 'string' && /^https?:\/\//i.test(fallback) ? fallback : undefined;
  }
}

/**
 * 纯归一化：把客户端 payload 变成 catalog.json 的磁盘形状。
 * facts 可来自 GitHub API（repo/release/deduced），也可为空（离线测试）。
 * warnings/reasons 由调用方传入并累积，便于 workflow 决策。
 */
export function normalizeItem(raw, today = todayAddedAt(), facts = {}, warnings = [], reasons = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('payload 条目必须是 JSON 对象');
  }
  const repo = facts.repo || {};
  const release = facts.release || null;
  const deduced = facts.deduced || null;

  const coord = itemCoord(raw);
  if (!coord) throw new Error("缺少 'id' 或 'owner'/'repo'");

  const [coordOwner, coordRepo] = coord.split('/');
  // 只有 owner/repo 同时存在时才视为显式坐标；否则统一以 coord 为准，避免只改一半造成坐标错位。
  const hasExplicitCoord = typeof raw.owner === 'string' && raw.owner.trim()
    && typeof raw.repo === 'string' && raw.repo.trim();
  const owner = hasExplicitCoord ? raw.owner.trim() : coordOwner;
  const repoName = hasExplicitCoord ? raw.repo.trim().replace(/\.git$/i, '') : coordRepo;

  const item = { ...raw };
  for (const field of STRING_FIELDS) {
    if (typeof item[field] === 'string') item[field] = item[field].trim();
  }

  item.owner = owner;
  item.repo = repoName;
  item.id = `${owner}/${repoName}`.toLowerCase();
  if (raw.id && String(raw.id).trim().toLowerCase() !== item.id) {
    warnings.push(`payload id '${raw.id}' 与 owner/repo 不一致，已规范为 '${item.id}'`);
  }

  item.name = item.name || repo.name || '';
  if (typeof item.name !== 'string' || !item.name.trim()) {
    throw new Error('缺少 name，且无法从上游仓库补齐');
  }
  item.name = item.name.trim();

  item.description = item.description
    || repo.description
    || (typeof raw.description_en === 'string' ? raw.description_en.trim() : '')
    || '';
  if (typeof item.description !== 'string' || !item.description.trim()) {
    throw new Error('缺少 description，且无法从上游仓库补齐');
  }
  item.description = item.description.trim();
  if (item.description.length > MAX_DESCRIPTION) {
    reasons.push(`description 超过 ${MAX_DESCRIPTION} 字符（${item.description.length}）`);
  }
  if (item.description.length < 4) reasons.push('description 过短，建议人工补充');
  if (/<\/?[a-z][^>]*>/i.test(item.description)) reasons.push('description 含 HTML 标签');

  item.description_en = item.description_en || repo.description || item.description;
  if (typeof item.description_en !== 'string' || !item.description_en.trim()) {
    throw new Error('缺少 description_en，且无法从上游仓库补齐');
  }
  item.description_en = item.description_en.trim();

  const category = CATEGORIES.find((c) => c.key === item.category);
  if (!category) {
    const guessed = guessCategory(repo.description || item.description, repo.topics);
    warnings.push(`category '${item.category || '(空)'}' 不合法，已推断为 '${guessed}'`);
    item.category = guessed;
  }
  const matched = CATEGORIES.find((c) => c.key === item.category)
    || CATEGORIES.find((c) => c.key === 'dev');
  item.category_name = matched.name;
  item.icon_bg = item.icon_bg || CATEGORY_GRADIENTS[item.category];

  if (Array.isArray(item.aliases)) {
    item.aliases = [...new Set(
      item.aliases
        .filter((alias) => typeof alias === 'string' && alias.trim())
        .map((alias) => alias.trim())
    )].slice(0, MAX_ALIASES);
    if (item.aliases.length === 0) delete item.aliases;
  } else {
    delete item.aliases;
  }

  const apiVersion = release && typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!item.default_version || item.default_version === 'latest') {
    item.default_version = apiVersion || item.default_version || 'latest';
  }
  if (item.default_version === 'latest') warnings.push('default_version 仍为 latest，等待 refresh 脚本刷新');

  item.added_at = today;
  item.is_verified = true;

  const apiLicense = repo.license && typeof repo.license.spdx_id === 'string'
    ? repo.license.spdx_id.trim()
    : '';
  const payloadLicense = typeof raw.license === 'string' ? raw.license.trim() : '';
  item.license = apiLicense && !['NOASSERTION', 'Unknown'].includes(apiLicense)
    ? apiLicense
    : (payloadLicense || 'Unknown');
  if (!OSI_LICENSES.has(item.license)) {
    reasons.push(`license '${item.license}' 不在 OSI 白名单，需人工确认`);
  }

  item.stars = Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : (Number(item.stars) || 0);
  item.forks = Number.isFinite(repo.forks_count) ? repo.forks_count : (Number(item.forks) || 0);

  const homepage = normalizeHomepage(raw.homepage, repo.homepage || repo.html_url);
  if (homepage) item.homepage = homepage;
  else delete item.homepage;

  const rawPlatforms = Array.isArray(raw.platforms)
    ? raw.platforms.filter((p) => {
      if (VALID_PLATFORMS.has(p)) return true;
      warnings.push(`忽略无效平台 '${p}'`);
      return false;
    })
    : [];
  const platforms = rawPlatforms.length > 0
    ? [...new Set(rawPlatforms)]
    : (deduced && deduced.platforms ? deduced.platforms : []);
  if (platforms.length === 0) throw new Error('无法推断 platforms（payload 为空且上游无 Release 资产）');
  item.platforms = platforms;

  const rawIdentifiers = raw.identifiers && typeof raw.identifiers === 'object' && !Array.isArray(raw.identifiers)
    ? raw.identifiers
    : {};
  const identifiers = {};
  for (const platform of IDENTIFIER_ORDER) {
    const fromPayload = Array.isArray(rawIdentifiers[platform])
      ? rawIdentifiers[platform].filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      : [];
    const fromDeduced = deduced && deduced.identifiers && Array.isArray(deduced.identifiers[platform])
      ? deduced.identifiers[platform]
      : [];
    identifiers[platform] = platforms.includes(platform)
      ? (fromPayload.length > 0 ? fromPayload : fromDeduced)
      : [];
    if (platforms.includes(platform) && identifiers[platform].length === 0) {
      reasons.push(`平台 '${platform}' 缺少可用标识符`);
    }
  }
  item.identifiers = orderedIdentifiers(identifiers);

  if (!item.icon) reasons.push('缺少可用图标');

  // 白名单输出，丢弃 install_dirs/search_subdirs/publishers 等客户端预填字段。
  const ordered = {};
  for (const key of FIELD_ORDER) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') ordered[key] = item[key];
  }
  return ordered;
}

async function fetchRepoFacts(owner, repoName, headers) {
  const repo = await apiGet(`https://api.github.com/repos/${owner}/${repoName}`, headers);
  if (!repo) throw new Error(`仓库不存在: ${owner}/${repoName}`);
  if (repo.archived) throw new Error(`仓库已归档: ${owner}/${repoName}`);
  if (repo.private) throw new Error(`仓库不是公开仓库: ${owner}/${repoName}`);
  if (repo.disabled) throw new Error(`仓库已禁用: ${owner}/${repoName}`);

  const release = await apiGet(
    `https://api.github.com/repos/${owner}/${repoName}/releases/latest`,
    headers,
    { allow404: true }
  );
  const deduced = deducePlatformsAndIdentifiers(repo.name || repoName, release?.assets || []);
  return { repo, release, deduced };
}

/**
 * 把 raw.githubusercontent / jsDelivr 的 URL 还原成 owner/repo/ref/path，
 * 优先用 GitHub Contents API 验证存在性与字节数，避免依赖 raw 域名可达性。
 */
function parseGitHubIconUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'raw.githubusercontent.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      // owner/repo/branch/path；branch 含 / 时无法可靠拆分，交给 fetch 兜底。
      if (parts.length >= 4 && !parts[3].includes('%2F')) {
        return { owner: parts[0], repo: parts[1], ref: parts[2], path: parts.slice(3).join('/') };
      }
    }
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.startsWith('/gh/')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 4) {
        const owner = parts[1];
        const [repo, ref] = parts[2].split('@');
        if (owner && repo && ref) {
          return { owner, repo, ref, path: parts.slice(3).join('/') };
        }
      }
    }
  } catch {
    // 非法 URL 交给上层处理
  }
  return null;
}

/**
 * 三态图标检查：ok=true 可用；ok=false 明确不可用；ok=null 当前网络验证不了。
 * GitHub 托管的图标走 Contents API，避免本地/runner 对 raw 域名的网络差异。
 */
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))) return true;
  return false;
}

async function inspectImage(url, headers) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: '非法 URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: '不是 https URL' };
  if (isPrivateHost(parsed.hostname)) return { ok: false, reason: '拒绝内网/本机地址' };

  const ghUrl = parseGitHubIconUrl(url);
  if (ghUrl) {
    const encodedPath = ghUrl.path.split('/').map(encodeURIComponent).join('/');
    try {
      const contents = await apiGet(
        `https://api.github.com/repos/${ghUrl.owner}/${ghUrl.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ghUrl.ref)}`,
        headers,
        { allow404: true }
      );
      if (contents) {
        if (contents.type !== 'file') return { ok: false, reason: `不是文件（${contents.type}）` };
        if (typeof contents.size === 'number' && contents.size < 300) {
          return { ok: false, reason: `文件过小（${contents.size} B）` };
        }
        if (!/\.(png|jpe?g|webp|gif|svg|ico)$/i.test(ghUrl.path)) {
          return { ok: false, reason: '不是图片扩展名' };
        }
        return { ok: true, bytes: contents.size || 0 };
      }
      // 404 可能只是 branch 名含 / 导致解析错误，继续用 fetch 兜底。
    } catch (err) {
      return { ok: null, reason: err.message };
    }
  }

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ZStore-Catalog/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    const isImage = type.startsWith('image/') || type.includes('octet-stream') || type.includes('svg');
    if (!isImage) return { ok: false, reason: `content-type ${type || '(空)'}` };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 300) return { ok: false, reason: `文件过小（${bytes.length} B）` };
    return { ok: true, bytes: bytes.length };
  } catch (err) {
    return { ok: null, reason: err.message };
  }
}

async function prepareItem(raw, ctx) {
  const coord = itemCoord(raw);
  if (!coord) throw new Error("缺少 'id' 或 'owner'/'repo'");
  const [owner, repoName] = coord.split('/');
  const warnings = [];
  const reasons = [];

  let facts = {};
  if (ctx.enrich) {
    facts = await fetchRepoFacts(owner, repoName, ctx.headers);
    if (facts.repo.fork) reasons.push('仓库是 fork，需人工确认是否为维护中的主仓库');
    if (!facts.release) {
      reasons.push('仓库没有最新 Release，需人工确认可下载性');
    } else if (!Array.isArray(facts.release.assets) || facts.release.assets.length === 0) {
      reasons.push('最新 Release 没有二进制资产，需人工确认可下载性');
    }
  }

  let icon = typeof raw.icon === 'string' ? raw.icon.trim() : '';
  if (icon && !/^https?:\/\//i.test(icon)) {
    warnings.push(`icon 不是 http(s) URL，已尝试自动探测: ${icon}`);
    icon = '';
  }
  if (icon && ctx.enrich) {
    const checked = await inspectImage(icon, ctx.headers);
    if (checked.ok === false) {
      warnings.push(`icon 不可用（${checked.reason}），已尝试自动探测: ${icon}`);
      icon = '';
    } else if (checked.ok === null) {
      warnings.push(`icon 当前网络无法验证（${checked.reason}），保留原 URL`);
    }
  }
  if (!icon && ctx.enrich) {
    const probed = await probeRepoLogo(owner, repoName, ctx.headers, facts.repo.default_branch || 'HEAD');
    if (probed) {
      const checked = await inspectImage(probed.url, ctx.headers);
      if (checked.ok === false) {
        warnings.push(`自动探测的 icon 不可用（${checked.reason}）: ${probed.url}`);
        reasons.push('未能确认应用图标，需人工补充');
      } else {
        icon = probed.url;
        warnings.push(`icon 自动探测（${probed.source}）`);
      }
    }
    if (!icon && facts.repo.owner && facts.repo.owner.avatar_url) {
      icon = facts.repo.owner.avatar_url;
      reasons.push('未探测到应用图标，暂用仓库头像');
    }
  }

  const item = normalizeItem({ ...raw, icon }, ctx.today, facts, warnings, reasons);
  const repoMeta = ctx.enrich
    ? {
      stars: facts.repo.stargazers_count,
      pushedAt: facts.repo.pushed_at,
      fork: Boolean(facts.repo.fork),
    }
    : null;
  return { item, warnings, reasons, repoMeta };
}

const REPUTATION_MIN_STARS = 50;
const REPUTATION_MAX_AGE_DAYS = 548; // 约 18 个月

export function isReputable(meta) {
  if (!meta) return false;
  if (meta.fork) return false;
  if (!Number.isFinite(meta.stars) || meta.stars < REPUTATION_MIN_STARS) return false;
  if (meta.pushedAt) {
    const ageDays = (Date.now() - new Date(meta.pushedAt).getTime()) / 86400000;
    if (!Number.isFinite(ageDays) || ageDays > REPUTATION_MAX_AGE_DAYS) return false;
  }
  return true;
}

function escapeTableCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function issueSourceLine(issue) {
  const number = issue.number ? `#${issue.number}` : '（本地预演）';
  const title = issue.title ? ` ${issue.title}` : '';
  const author = issue.user?.login ? ` @${issue.user.login}` : '';
  return `- 来源: ${number}${title}${author}`;
}

function buildPrBody(issue, { added, updated, skipped, warnings, reasons }) {
  const all = [...added, ...updated.map((u) => u.item)];
  const rows = all
    .map((item) => `| \`${escapeTableCell(item.id)}\` | ${escapeTableCell(item.name)} | \`${escapeTableCell(item.category)}\` | ${escapeTableCell(item.platforms.join(', '))} |`)
    .join('\n');

  const autoBlock = warnings.length
    ? `\n### 自动补全\n\n${[...new Set(warnings)].map((w) => `- ${w}`).join('\n')}\n`
    : '';
  const reviewBlock = reasons.length
    ? `\n### 需要人工确认\n\n${[...new Set(reasons)].map((r) => `- ${r}`).join('\n')}\n`
    : '';
  const skippedBlock = skipped.length
    ? `\n### 已跳过（已在清单中）\n\n${skipped.map((s) => `- \`${s.id}\`：${s.reason}`).join('\n')}\n`
    : '';
  const closing = issue.number ? `Closes #${issue.number}` : '';

  return `## 自动收录 PR

${issueSourceLine(issue)}

本次处理 ${all.length} 项：

| ID | 名称 | 分类 | 平台 |
| --- | --- | --- | --- |
${rows}
${autoBlock}
${reviewBlock}
${skippedBlock}
## 校验

- [x] 已解析 Issue 正文中的 \`payload_json\`
- [x] 已通过 \`scripts/validate-catalog.mjs\`（与 PR CI 同款规则）
- [x] 动态字段（stars / forks / license / default_version）以 GitHub API 为准
- [x] 缺失的 platforms / identifiers / icon 已尝试自动补齐

${closing}

> 由 \`.github/workflows/issue-to-pr.yml\` 自动生成。
`;
}

function buildSuccessComment(issue, result) {
  const lines = result.ids.map((id) => `- \`${id}\``).join('\n');
  const review = result.needsReview && result.reasons.length
    ? `\n需要人工确认：\n\n${[...new Set(result.reasons)].map((r) => `- ${r}`).join('\n')}\n`
    : '';
  return `## 收录处理结果

${issueSourceLine(issue)}

本次处理 ${result.ids.length} 项：

${lines}
${review}`;
}

function buildDuplicateComment(issue, skipped) {
  const lines = skipped.map((s) => `- \`${s.id}\`：${s.reason}`).join('\n');
  return `## 已收录，无需重复提交

${issueSourceLine(issue)}

以下条目已经在 \`catalog.json\` 中：

${lines}

> 如需更新既有条目，请给 Issue 打 \`update\` 标签后重新运行。
`;
}

function buildFailureComment(issue, errors) {
  const lines = errors.map((e) => `- \`${e.id}\`：${e.msg}`).join('\n');
  return `## 自动收录未通过

${issueSourceLine(issue)}

\`payload_json\` 未通过校验，未创建 PR。请修正后重新提交 Issue：

${lines}

> 校验规则见 \`scripts/validate-catalog.mjs\`。
`;
}

function writeIfRequested(filePath, content) {
  if (filePath) fs.writeFileSync(filePath, content, 'utf8');
}

function writeResult(args, result) {
  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function failWith(args, issue, errors) {
  for (const e of errors) console.error(`  ❌ [${e.id}]: ${e.msg}`);
  const result = {
    ok: false,
    action: 'error',
    issue: issue?.number || null,
    ids: [],
    needsReview: true,
    reasons: errors.map((e) => e.msg),
    warnings: [],
    skipped: [],
    errors,
  };
  writeResult(args, result);
  writeIfRequested(args.failureComment, buildFailureComment(issue || {}, errors));
  process.exitCode = 1;
  return result;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    usage();
    process.exitCode = 1;
    return;
  }

  let issue;
  try {
    issue = await loadIssue(args);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const catalogPath = path.resolve(args.catalog);
  if (!fs.existsSync(catalogPath)) {
    console.error(`❌ 未找到 catalog.json: ${catalogPath}`);
    process.exitCode = 1;
    return;
  }

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    return failWith(args, issue, [{ id: 'catalog.json', msg: `JSON 解析失败: ${err.message}` }]);
  }
  if (!Array.isArray(catalog)) {
    return failWith(args, issue, [{ id: 'catalog.json', msg: '根节点必须是数组' }]);
  }

  let parsed;
  try {
    parsed = extractPayload(issue.body);
  } catch (err) {
    return failWith(args, issue, [{ id: 'payload_json', msg: err.message }]);
  }

  const incoming = Array.isArray(parsed) ? parsed : [parsed];
  if (incoming.length === 0) {
    return failWith(args, issue, [{ id: 'payload_json', msg: '数组为空，没有可收录条目' }]);
  }
  if (incoming.length > MAX_ENTRIES) {
    return failWith(args, issue, [{ id: 'payload_json', msg: `条目数 ${incoming.length} 超过上限 ${MAX_ENTRIES}` }]);
  }

  const today = todayAddedAt();
  const headers = apiHeaders();
  const known = new Map();
  for (const item of catalog) {
    const coord = itemCoord(item);
    if (coord) known.set(coord, item);
  }

  const added = [];
  const updated = [];
  const skipped = [];
  const errors = [];
  const warnings = [];
  const reasons = [];
  const repoMetas = [];
  const seen = new Set();

  for (let i = 0; i < incoming.length; i++) {
    const raw = incoming[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ id: `第 ${i + 1} 项`, msg: '必须是 JSON 对象' });
      continue;
    }
    const coord = itemCoord(raw) || `第 ${i + 1} 项`;
    if (seen.has(coord)) {
      errors.push({ id: coord, msg: '同一 Issue 内重复出现' });
      continue;
    }
    seen.add(coord);

    try {
      const prepared = await prepareItem(raw, { enrich: args.enrich, headers, today });
      warnings.push(...prepared.warnings);
      reasons.push(...prepared.reasons);

      const existing = known.get(coord);
      if (existing) {
        if (!args.update) {
          skipped.push({ id: coord, reason: '已在 catalog.json 中，未重复写入' });
          continue;
        }
        updated.push({ item: prepared.item, existing });
      } else {
        added.push(prepared.item);
      }
      repoMetas.push(prepared.repoMeta);
    } catch (err) {
      errors.push({ id: coord, msg: err.message });
    }
  }

  if (errors.length > 0) return failWith(args, issue, errors);

  const result = {
    ok: true,
    action: 'noop',
    issue: issue.number || null,
    author: issue.user?.login || null,
    authorAssociation: issue.author_association || null,
    ids: [],
    needsReview: [...new Set(reasons)].length > 0,
    reputationOk: repoMetas.length > 0 && repoMetas.every(isReputable),
    reasons: [...new Set(reasons)],
    warnings: [...new Set(warnings)],
    skipped,
    added: [],
    updated: [],
  };

  if (added.length === 0 && updated.length === 0) {
    result.action = skipped.length > 0 ? 'duplicate' : 'noop';
    writeResult(args, result);
    writeIfRequested(args.comment, buildDuplicateComment(issue, skipped));
    console.log(`ℹ️ 没有新增条目（跳过 ${skipped.length} 项）。`);
    return;
  }

  const next = catalog.map((entry) => {
    const change = updated.find((u) => itemCoord(entry) === itemCoord(u.item));
    if (!change) return entry;
    return {
      ...change.existing,
      ...change.item,
      added_at: change.existing.added_at || change.item.added_at,
    };
  });
  for (const item of added) next.push(item);

  const { errors: schemaErrors, warnings: schemaWarnings } = validateCatalog(next);
  warnings.push(...schemaWarnings.map((w) => `[${w.id}] ${w.msg}`));
  if (schemaErrors.length > 0) {
    return failWith(args, issue, schemaErrors.map((e) => ({ id: e.id, msg: e.msg })));
  }

  result.action = updated.length > 0 && added.length === 0 ? 'update' : 'add';
  result.ids = [...added.map((item) => item.id), ...updated.map((u) => u.item.id)];
  result.added = added.map((item) => item.id);
  result.updated = updated.map((u) => u.item.id);
  result.needsReview = result.reasons.length > 0;
  result.warnings = [...new Set(warnings)];

  if (args.write) {
    fs.writeFileSync(catalogPath, formatCatalogJson(next), 'utf8');
  }

  const suffix = issue.number ? ` (#${issue.number})` : '';
  let prTitle;
  if (added.length === 0) {
    prTitle = `feat(catalog): 更新 ${result.ids.join(', ')}${suffix}`;
  } else if (added.length === 1) {
    prTitle = `feat(catalog): 收录 ${result.ids[0]}${suffix}`;
  } else {
    prTitle = `feat(catalog): 批量收录 ${added.length} 项${suffix}`;
  }

  writeResult(args, result);
  writeIfRequested(args.prTitle, `${prTitle}\n`);
  writeIfRequested(args.prBody, buildPrBody(issue, { added, updated, skipped, warnings: result.warnings, reasons: result.reasons }));
  writeIfRequested(args.comment, buildSuccessComment(issue, result));

  console.log(`${args.write ? '✅' : '🧪 [dry-run]'} ${result.action} ${result.ids.length} 项: ${result.ids.join(', ')}`);
  if (result.warnings.length) console.log(`⚠️ 自动补全: ${result.warnings.join(' | ')}`);
  if (result.needsReview) console.log(`👀 需要人工确认: ${result.reasons.join(' | ')}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  });
}
