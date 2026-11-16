#!/usr/bin/env node

/**
 * ingest-showcase.mjs
 *
 * 解析开发者自荐 Issue（`.github/ISSUE_TEMPLATE/showcase.yml` 表单），经 GitHub API 校验后
 * 写入 `showcase/<owner>/<repo>.json`（新建或续期）。校验：
 *   - 提交人身份：Issue 作者是仓库 owner、组织公开成员，或对仓库有 write 及以上权限；
 *     无法自动确认时不拒绝，标记 needsReview 交给维护者；
 *   - 仓库公开、非 fork、未归档 / 禁用，近 180 天有推送；
 *   - OSI 协议、最新 Release 至少一个受支持的构建资产；
 *   - 不在 catalog.json；有效条目续期规则、冷却期、每人有效条目上限；
 *   - 自荐语规则（与客户端同口径），促销词只标记复核。
 *
 * 用法:
 *   node scripts/ingest-showcase.mjs --issue 12 --repo owner/name --write --out result.json
 *   node scripts/ingest-showcase.mjs --body-file issue.md --author someone --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deducePlatformsAndIdentifiers, resolveGitHubToken, todayAddedAt } from './lib/catalog-shared.mjs';
import {
  SHOWCASE_FORM_LABELS,
  SHOWCASE_MAX_INACTIVE_DAYS,
  SHOWCASE_WINDOW_DAYS,
  addDays,
  decideSubmission,
  formatShowcaseJson,
  isActive,
  isOsiLicense,
  orderEntry,
  parseIssueForm,
  parseKeywords,
  parseRepoCoord,
  promoWarnings,
  validatePitch,
  ymdToDays,
} from './lib/showcase-shared.mjs';
import { entryPath, loadCatalogIds, loadEntries, loadHistory } from './build-showcase.mjs';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');
const MAX_BODY_BYTES = 16 * 1024;

export function parseArgs(argv) {
  const args = {
    dir: path.join(rootDir, 'showcase'),
    catalog: path.join(rootDir, 'catalog.json'),
    today: todayAddedAt(),
    write: false,
  };
  const valueFlags = new Set([
    '--issue', '--repo', '--body-file', '--author', '--out', '--comment',
    '--failure-comment', '--pr-title', '--pr-body', '--today', '--dir', '--catalog',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (valueFlags.has(flag)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${flag} 缺少取值`);
      args[flag.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
    } else if (flag === '--write') args.write = true;
    else if (flag === '--dry-run') args.write = false;
    else throw new Error(`未知参数: ${flag}`);
  }
  if (!args.bodyFile && !args.issue) throw new Error('必须提供 --issue 或 --body-file');
  if (!args.repo) args.repo = process.env.GITHUB_REPOSITORY || '';
  if (args.dir) args.dir = path.resolve(args.dir);
  if (args.catalog) args.catalog = path.resolve(args.catalog);
  return args;
}

function apiHeaders() {
  const headers = { 'User-Agent': 'ZStore-Showcase-Ingest/1.0', Accept: 'application/vnd.github+json' };
  const token = resolveGitHubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function apiFetch(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: apiHeaders(), signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`GitHub API ${res.status}: ${url}`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error(`GitHub API 请求失败: ${url}`);
}

async function loadIssue(args) {
  if (args.bodyFile) {
    return {
      number: args.issue ? Number(args.issue) : null,
      body: fs.readFileSync(args.bodyFile, 'utf8'),
      html_url: '',
      user: { login: args.author ?? '' },
    };
  }
  const { status, body } = await apiFetch(`https://api.github.com/repos/${args.repo}/issues/${args.issue}`);
  if (status !== 200 || !body) throw new Error(`读取 Issue 失败（HTTP ${status}）`);
  return body;
}

/** 客户端可安装 / 可下载的构建资产扩展名（与 z-store `ReleaseAsset` 口径一致）。 */
const INSTALLABLE_EXTENSIONS = [
  '.msi', '.exe', '.zip', '.tar.gz', '.tgz', '.tar.xz', '.tar', '.deb', '.rpm',
  '.appimage', '.dmg', '.pkg', '.apk', '.ipa', '.7z', '.tar.bz2',
];

export function installableAssets(release) {
  return (release?.assets ?? []).filter((a) => {
    const name = String(a?.name ?? '').toLowerCase();
    return INSTALLABLE_EXTENSIONS.some((ext) => name.endsWith(ext));
  });
}

/**
 * 仓库事实 → 硬性问题与提示（纯函数）。
 * `repo` 为 GitHub repos API 响应，`release` 为 latest release（可为 null）。
 */
export function evaluateRepo({ repo, release, today }) {
  const errors = [];
  if (!repo) return { errors: ['仓库不存在或不可访问'], platforms: [] };
  if (repo.private) errors.push('仓库不是公开仓库');
  if (repo.fork) errors.push('不接受 fork 仓库自荐');
  if (repo.archived) errors.push('仓库已归档');
  if (repo.disabled) errors.push('仓库已禁用');
  const spdx = repo.license?.spdx_id ?? '';
  if (!isOsiLicense(spdx)) errors.push(`协议 ${spdx || '未声明'} 不在 OSI 认证名单内`);
  const pushed = ymdToDays(String(repo.pushed_at ?? '').slice(0, 10));
  if (pushed === null || ymdToDays(today) - pushed > SHOWCASE_MAX_INACTIVE_DAYS) {
    errors.push(`仓库近 ${SHOWCASE_MAX_INACTIVE_DAYS} 天没有推送`);
  }
  const assets = installableAssets(release);
  if (assets.length === 0) {
    errors.push('最新 Release 没有受支持的可安装构建包');
    return { errors, platforms: [] };
  }
  const platforms = deducePlatformsAndIdentifiers(repo.name ?? '', assets).platforms ?? [];
  return { errors, platforms };
}

/** 提交人身份：owner / 组织公开成员 / write 以上权限；无法确认返回 'unknown'。 */
async function checkIdentity(coord, repo, login) {
  const user = String(login ?? '').toLowerCase();
  if (!user) return 'unknown';
  if (user === coord.owner) return 'owner';
  if (repo?.owner?.type === 'Organization') {
    const { status } = await apiFetch(`https://api.github.com/orgs/${coord.owner}/public_members/${user}`);
    if (status === 204) return 'org-member';
  }
  const { status, body } = await apiFetch(
    `https://api.github.com/repos/${coord.id}/collaborators/${user}/permission`,
  );
  if (status === 200) {
    return ['admin', 'maintain', 'write'].includes(body?.permission) ? 'collaborator' : 'denied';
  }
  return 'unknown';
}

function activeBySubmitter(entries, today) {
  const map = new Map();
  for (const { entry } of entries) {
    if (!isActive(entry, today)) continue;
    const key = String(entry.submitted_by).toLowerCase();
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function write(file, text) {
  if (file) fs.writeFileSync(file, text, 'utf8');
}

function finish(args, result, comment) {
  write(args.out, `${JSON.stringify(result, null, 2)}\n`);
  if (result.ok) write(args.comment, comment);
  else write(args.failureComment, comment);
  if (!result.ok) process.exitCode = 1;
  return result;
}

function bullet(lines) {
  return lines.map((l) => `- ${l}`).join('\n');
}

export async function run(args) {
  let issue;
  try {
    issue = await loadIssue(args);
  } catch (err) {
    return finish(args, { ok: false, action: 'error', errors: [err.message] }, `## 自荐处理失败\n\n${err.message}\n`);
  }
  if (Buffer.byteLength(issue.body ?? '', 'utf8') > MAX_BODY_BYTES) {
    return finish(args, { ok: false, action: 'error', errors: ['Issue 正文过长'] }, '## 自荐处理失败\n\nIssue 正文过长。\n');
  }
  const form = parseIssueForm(issue.body, SHOWCASE_FORM_LABELS);
  const coord = parseRepoCoord(form.repo);
  const keywords = parseKeywords(form.keywords);
  const pitch = { pitch: form.pitch ?? '', pitch_en: form.pitch_en ?? '', keywords };
  const errors = [];
  if (!coord) errors.push('仓库地址无法识别（目前只接受 github.com 上的仓库）');
  errors.push(...validatePitch(pitch));
  if (errors.length > 0) {
    return finish(
      args,
      { ok: false, action: 'reject', id: coord?.id ?? null, errors },
      `## 自荐未通过校验\n\n${bullet(errors)}\n\n修改 Issue 正文后会自动重新校验。\n`,
    );
  }

  const login = issue.user?.login ?? '';
  const repoRes = await apiFetch(`https://api.github.com/repos/${coord.id}`);
  const repo = repoRes.status === 200 ? repoRes.body : null;
  const releaseRes = repo ? await apiFetch(`https://api.github.com/repos/${coord.id}/releases/latest`) : null;
  const release = releaseRes?.status === 200 ? releaseRes.body : null;
  const facts = evaluateRepo({ repo, release, today: args.today });
  errors.push(...facts.errors);

  const identity = repo ? await checkIdentity(coord, repo, login) : 'unknown';
  if (identity === 'denied') errors.push(`@${login} 不是该仓库的所有者或协作者`);

  const entries = loadEntries(args.dir);
  const existing = entries.find((e) => e.entry.id === coord.id)?.entry ?? null;
  const decision = decideSubmission({
    id: coord.id,
    submittedBy: login,
    today: args.today,
    catalogIds: loadCatalogIds(args.catalog),
    existing,
    activeBySubmitter: activeBySubmitter(entries, args.today),
    history: loadHistory(args.dir),
  });
  if (decision.action === 'reject') errors.push(decision.reason);

  if (errors.length > 0) {
    return finish(
      args,
      { ok: false, action: 'reject', id: coord.id, errors },
      `## 自荐未通过校验：\`${coord.id}\`\n\n${bullet(errors)}\n`,
    );
  }

  const warnings = [...promoWarnings(pitch)];
  if (identity === 'unknown') warnings.push(`无法自动确认 @${login} 对仓库的权限，请维护者核对`);
  const needsReview = warnings.length > 0;

  const entry =
    decision.action === 'renew'
      ? orderEntry({
          ...existing,
          pitch: pitch.pitch.trim() || null,
          pitch_en: pitch.pitch_en.trim() || null,
          keywords,
          expires_at: addDays(existing.expires_at, SHOWCASE_WINDOW_DAYS),
          renewed: true,
        })
      : orderEntry({
          id: coord.id,
          submitted_by: login,
          pitch: pitch.pitch.trim() || null,
          pitch_en: pitch.pitch_en.trim() || null,
          keywords,
          submitted_at: args.today,
          expires_at: addDays(args.today, SHOWCASE_WINDOW_DAYS),
          stars_at_submit: Number(repo.stargazers_count) || 0,
          renewed: false,
          issue_url: issue.html_url || null,
        });

  if (args.write) {
    const file = entryPath(args.dir, coord.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatShowcaseJson(entry), 'utf8');
  }

  const verb = decision.action === 'renew' ? '续期' : '自荐';
  write(args.prTitle, `feat(showcase): ${verb} ${coord.id}`);
  write(
    args.prBody,
    [
      `由 #${issue.number ?? '?'} 自动生成（${verb}）。`,
      '',
      '| 字段 | 值 |',
      '| --- | --- |',
      `| 应用 | \`${coord.id}\` |`,
      `| 提交人 | @${login}（${identity}） |`,
      `| 平台 | ${facts.platforms.join(', ')} |`,
      `| 展示期 | ${entry.submitted_at} → ${entry.expires_at} |`,
      '',
      warnings.length > 0 ? `### 需要复核\n\n${bullet(warnings)}` : '自动校验全部通过。',
      '',
      issue.number ? `Closes #${issue.number}` : '',
    ].join('\n'),
  );
  return finish(
    args,
    { ok: true, action: decision.action, id: coord.id, needsReview, warnings, entry },
    `## 自荐校验通过：\`${coord.id}\`\n\n${verb}后展示至 ${entry.expires_at}。${
      warnings.length > 0 ? `\n\n需要维护者复核：\n\n${bullet(warnings)}` : ''
    }\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  }
  if (args) {
    run(args).then(
      (result) => console.log(JSON.stringify({ ok: result.ok, action: result.action, id: result.id })),
      (err) => {
        console.error(`❌ ${err.message}`);
        process.exitCode = 1;
      },
    );
  }
}
