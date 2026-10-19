#!/usr/bin/env node

/**
 * ingest-issue.mjs
 *
 * 把收录申请 Issue 正文里的 `### payload_json` 合并进 catalog.json：
 * 1. 支持单条对象与批量数组（客户端「批量收录申请」）；
 * 2. 按 owner/repo 去重，已收录条目跳过；
 * 3. 写入前用 validateCatalog 复用 PR 同款规则；
 * 4. 输出 PR 正文 / Issue 评论素材，供 issue-to-pr workflow 建 PR。
 *
 * 用法:
 *   node scripts/ingest-issue.mjs --issue 2 --repo owner/repo
 *   node scripts/ingest-issue.mjs --body-file issue.md --catalog /tmp/catalog.json --dry-run
 *   node scripts/ingest-issue.mjs --body-file issue.md --pr-body pr-body.md --pr-title pr-title.txt
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  CATEGORY_GRADIENTS,
  formatCatalogJson,
  resolveGitHubToken,
  todayAddedAt,
} from './lib/catalog-shared.mjs';
import { validateCatalog } from './validate-catalog.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PAYLOAD_HEADING = '### payload_json';
const FIELD_ORDER = [
  'id', 'name', 'owner', 'repo', 'icon', 'icon_bg',
  'description', 'description_en', 'category', 'category_name',
  'aliases', 'default_version', 'added_at', 'license',
  'stars', 'forks', 'is_verified', 'homepage', 'platforms', 'identifiers',
];
const IDENTIFIER_ORDER = ['windows', 'linux', 'macos', 'android', 'ios'];

function usage() {
  console.error(
    [
      '用法: node scripts/ingest-issue.mjs [选项]',
      '  --issue <number>        读取该 Issue 正文（需 GITHUB_TOKEN/GH_TOKEN 或公开仓库）',
      '  --repo <owner/repo>     Issue 所在仓库；默认取 GITHUB_REPOSITORY',
      '  --body-file <path>      直接读取本地 Issue 正文（与 --issue 二选一）',
      '  --catalog <path>        catalog.json 路径；默认仓库根目录',
      '  --pr-body <path>        写入 PR 正文（有新增条目时）',
      '  --pr-title <path>       写入 PR 标题（有新增条目时）',
      '  --failure-comment <path> 写入失败说明（Issue 评论用）',
      '  --nochange-comment <path> 写入无新增说明（Issue 评论用）',
      '  --dry-run               只解析与校验，不写 catalog.json',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const args = { catalog: path.join(rootDir, 'catalog.json'), dryRun: false };
  const valueFlags = new Set([
    '--issue', '--repo', '--body-file', '--catalog',
    '--pr-body', '--pr-title', '--failure-comment', '--nochange-comment',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (valueFlags.has(flag)) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`参数 ${flag} 缺少取值`);
      }
      args[flag.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
    } else if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${flag}`);
    }
  }

  if (!args.bodyFile && !args.issue) {
    throw new Error('必须提供 --issue 或 --body-file');
  }
  if (!args.repo) {
    args.repo = process.env.GITHUB_REPOSITORY || '';
  }
  if (!args.bodyFile && !args.repo) {
    throw new Error('读取远程 Issue 时必须提供 --repo 或 GITHUB_REPOSITORY');
  }
  return args;
}

async function loadIssue(args) {
  if (args.bodyFile) {
    return {
      number: args.issue ? Number(args.issue) : null,
      title: '',
      body: fs.readFileSync(args.bodyFile, 'utf8'),
      html_url: '',
      user: null,
    };
  }

  const token = resolveGitHubToken();
  const headers = {
    'User-Agent': 'ZStore-Issue-Ingest/1.0',
    Accept: 'application/vnd.github+json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `https://api.github.com/repos/${args.repo}/issues/${args.issue}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`读取 Issue 失败: HTTP ${res.status} (${url})`);
  }
  return res.json();
}

function extractPayload(body) {
  if (typeof body !== 'string' || !body.includes(PAYLOAD_HEADING)) {
    throw new Error(`Issue 正文缺少 '${PAYLOAD_HEADING}' 小节`);
  }
  const section = body.slice(body.indexOf(PAYLOAD_HEADING));
  const match = section.match(/```json\s*\r?\n([\s\S]*?)```/i);
  if (!match) {
    throw new Error('payload_json 小节缺少 ```json 代码块');
  }
  const text = match[1].trim();
  if (!text) {
    throw new Error('payload_json 代码块为空');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`payload_json 不是合法 JSON: ${err.message}`);
  }
}

function itemCoord(item) {
  if (item.id && typeof item.id === 'string') return item.id.trim().toLowerCase();
  if (item.owner && item.repo) return `${item.owner}/${item.repo}`.toLowerCase();
  return null;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function orderIdentifiers(identifiers) {
  if (!identifiers || typeof identifiers !== 'object' || Array.isArray(identifiers)) {
    return identifiers;
  }
  const ordered = {};
  for (const key of IDENTIFIER_ORDER) {
    if (identifiers[key] !== undefined) ordered[key] = identifiers[key];
  }
  for (const key of Object.keys(identifiers).sort()) {
    if (!(key in ordered)) ordered[key] = identifiers[key];
  }
  return ordered;
}

/**
 * 把客户端 payload 归一成 catalog.json 的磁盘形状：
 * 固定字段顺序、补齐 category_name/icon_bg/added_at、清理空可选值。
 */
function normalizeItem(raw, today) {
  const item = { ...raw };

  for (const field of ['id', 'name', 'owner', 'repo', 'icon', 'category', 'license', 'default_version', 'homepage', 'description', 'description_en']) {
    item[field] = trimString(item[field]);
  }

  if (!item.id && item.owner && item.repo) {
    item.id = `${item.owner}/${item.repo}`.toLowerCase();
  }
  if (typeof item.id === 'string') {
    item.id = item.id.trim().toLowerCase();
  }

  const category = CATEGORIES.find((c) => c.key === item.category);
  if (category && !item.category_name) item.category_name = category.name;
  if (category && !item.icon_bg) item.icon_bg = CATEGORY_GRADIENTS[item.category];

  // 收录申请一律由维护者经 PR 复核，合并后即视为已验证。
  item.is_verified = true;
  if (!item.added_at) item.added_at = today;

  if (Array.isArray(item.aliases)) {
    item.aliases = item.aliases
      .filter((alias) => typeof alias === 'string' && alias.trim())
      .map((alias) => alias.trim());
    if (item.aliases.length === 0) delete item.aliases;
  }

  if (item.homepage === '') delete item.homepage;
  if (typeof item.homepage === 'string' && item.homepage && !/^https?:\/\//.test(item.homepage)) {
    // 客户端偶发省略协议头：补全而不是让整条申请失败。
    item.homepage = `https://${item.homepage}`;
  }

  item.identifiers = orderIdentifiers(item.identifiers);

  for (const key of Object.keys(item)) {
    if (item[key] === undefined) delete item[key];
  }

  const ordered = {};
  for (const key of FIELD_ORDER) {
    if (item[key] !== undefined) ordered[key] = item[key];
  }
  // 保留未来新增字段，避免静默丢数据（按字母序附在末尾）。
  for (const key of Object.keys(item).sort()) {
    if (!(key in ordered)) ordered[key] = item[key];
  }
  return ordered;
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

function buildPrBody(issue, added, skipped) {
  const rows = added
    .map((item) => `| \`${escapeTableCell(item.id)}\` | ${escapeTableCell(item.name)} | \`${escapeTableCell(item.category)}\` |`)
    .join('\n');
  const skippedBlock = skipped.length
    ? `\n## 已跳过（已在清单中）\n\n${skipped.map((s) => `- \`${s.id}\`：${s.reason}`).join('\n')}\n`
    : '';

  return `## 自动收录 PR

${issueSourceLine(issue)}

本次新增 ${added.length} 项：

| ID | 名称 | 分类 |
| --- | --- | --- |
${rows}
${skippedBlock}
## 校验

- [x] 已解析 Issue 正文中的 \`payload_json\`
- [x] 已通过 \`scripts/validate-catalog.mjs\`（与 PR CI 同款规则）
- [ ] 维护者复核中文简介 / 图标 / 平台标识符

Closes ${issue.number ? `#${issue.number}` : '#'}

> 由 \`.github/workflows/issue-to-pr.yml\` 自动生成。
`;
}

function buildNoChangeComment(issue, skipped) {
  const lines = skipped.length
    ? skipped.map((s) => `- \`${s.id}\`：${s.reason}`).join('\n')
    : '- 未解析到可收录条目';
  return `## 未新增条目

${issueSourceLine(issue)}

以下条目未写入 \`catalog.json\`：

${lines}
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

function failWith(args, issue, errors) {
  for (const e of errors) {
    console.error(`  ❌ [${e.id}]: ${e.msg}`);
  }
  writeIfRequested(args.failureComment, buildFailureComment(issue, errors));
  process.exitCode = 1;
  return false;
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
  const issue = await loadIssue(args);

  const catalogPath = path.resolve(args.catalog);
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`未找到 catalog.json: ${catalogPath}`);
  }

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (err) {
    throw new Error(`catalog.json 不是合法 JSON: ${err.message}`);
  }
  if (!Array.isArray(catalog)) {
    throw new Error('catalog.json 根节点必须是数组');
  }

  const parsed = extractPayload(issue.body);
  const incoming = Array.isArray(parsed) ? parsed : [parsed];
  if (incoming.length === 0) {
    return failWith(args, issue, [{ id: 'payload_json', msg: '数组为空，没有可收录条目' }]);
  }

  const today = todayAddedAt();
  const known = new Set();
  for (const item of catalog) {
    const coord = itemCoord(item);
    if (coord) known.add(coord);
  }

  const added = [];
  const skipped = [];
  const shapeErrors = [];

  for (let i = 0; i < incoming.length; i++) {
    if (!incoming[i] || typeof incoming[i] !== 'object' || Array.isArray(incoming[i])) {
      shapeErrors.push({ id: `第 ${i + 1} 项`, msg: '必须是 JSON 对象' });
      continue;
    }

    const item = normalizeItem(incoming[i], today);
    const coord = itemCoord(item);
    if (!coord) {
      shapeErrors.push({ id: `第 ${i + 1} 项`, msg: "缺少 'id' 或 'owner'/'repo'" });
      continue;
    }
    if (known.has(coord)) {
      skipped.push({ id: coord, reason: '已在 catalog.json 中，未重复写入' });
      continue;
    }

    known.add(coord);
    added.push(item);
  }

  if (shapeErrors.length > 0) {
    return failWith(args, issue, shapeErrors);
  }

  if (added.length === 0) {
    writeIfRequested(args.nochangeComment, buildNoChangeComment(issue, skipped));
    console.log(`ℹ️ 没有新增条目（跳过 ${skipped.length} 项）。`);
    return;
  }

  const next = [...catalog, ...added];
  const { errors, warnings } = validateCatalog(next);
  for (const w of warnings) {
    console.warn(`  ⚠️ [${w.id}]: ${w.msg}`);
  }
  if (errors.length > 0) {
    return failWith(args, issue, errors);
  }

  if (!args.dryRun) {
    fs.writeFileSync(catalogPath, formatCatalogJson(next), 'utf8');
  }

  const ids = added.map((item) => item.id);
  const numberSuffix = issue.number ? ` (#${issue.number})` : '';
  const prTitle = added.length === 1
    ? `feat(catalog): 收录 ${ids[0]}${numberSuffix}`
    : `feat(catalog): 批量收录 ${added.length} 项${numberSuffix}`;

  writeIfRequested(args.prTitle, `${prTitle}\n`);
  writeIfRequested(args.prBody, buildPrBody(issue, added, skipped));

  console.log(`${args.dryRun ? '🧪 [dry-run] ' : '✅ '}新增 ${added.length} 项: ${ids.join(', ')}`);
  if (skipped.length > 0) {
    console.log(`↩️ 跳过 ${skipped.length} 项: ${skipped.map((s) => s.id).join(', ')}`);
  }
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
});
