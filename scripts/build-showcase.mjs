#!/usr/bin/env node

/**
 * build-showcase.mjs
 *
 * 把 `showcase/<owner>/<repo>.json` 编译为根目录 `showcase.json`（客户端读取的自荐清单）。
 * 到期与已被精选收录（catalog.json 命中）的条目不进入产物；`--prune` 同时删除这些条目文件，
 * 并把下架日期写入 `showcase/history.json`，供再次自荐的冷却期判断。
 *
 * 用法:
 *   node scripts/build-showcase.mjs                 # 编译
 *   node scripts/build-showcase.mjs --prune         # 编译并清理到期 / 转正条目
 *   node scripts/build-showcase.mjs --remove o/r    # 下架单条（举报确认），记入 history
 *   node scripts/build-showcase.mjs --check         # 只校验产物是否最新（CI）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildShowcaseManifest,
  formatShowcaseJson,
  parseRepoCoord,
} from './lib/showcase-shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');

export const HISTORY_FILE = 'history.json';

export function parseArgs(argv) {
  const defaultCatalog = path.join(rootDir, 'catalog.json');
  const args = {
    dir: path.join(rootDir, 'showcase'),
    out: path.join(rootDir, 'showcase.json'),
    catalog: defaultCatalog,
    apps: path.join(rootDir, 'apps'),
    appsExplicit: false,
    today: new Date().toISOString().slice(0, 10),
    prune: false,
    check: false,
    remove: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${flag} 缺少取值`);
      return v;
    };
    if (flag === '--dir') args.dir = path.resolve(take());
    else if (flag === '--out') args.out = path.resolve(take());
    else if (flag === '--catalog') args.catalog = path.resolve(take());
    else if (flag === '--apps') {
      args.apps = path.resolve(take());
      args.appsExplicit = true;
    } else if (flag === '--today') args.today = take();
    else if (flag === '--remove') args.remove = take();
    else if (flag === '--prune') args.prune = true;
    else if (flag === '--check') args.check = true;
    else throw new Error(`未知参数: ${flag}`);
  }
  if (!args.appsExplicit && args.catalog !== defaultCatalog) args.apps = null;
  return args;
}

/** 条目文件路径：`<dir>/<owner>/<repo>.json`（只认两级，history.json 等根级文件不算条目）。 */
export function entryPath(dir, id) {
  const coord = parseRepoCoord(id);
  if (!coord) throw new Error(`非法应用标识: ${id}`);
  return path.join(dir, coord.owner, `${coord.repo}.json`);
}

export function collectEntryFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const owner of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    const ownerDir = path.join(dir, owner.name);
    for (const f of fs.readdirSync(ownerDir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.json')) files.push(path.join(ownerDir, f.name));
    }
  }
  return files.sort();
}

export function loadEntries(dir) {
  return collectEntryFiles(dir).map((file) => {
    try {
      return { file, entry: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      throw new Error(`${path.relative(rootDir, file)} 不是合法 JSON: ${err.message}`);
    }
  });
}

export function loadCatalogIds(catalogPath, appsDir = null) {
  const ids = new Set();
  if (catalogPath && fs.existsSync(catalogPath)) {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    for (const i of Array.isArray(catalog) ? catalog : []) {
      if (i?.id) ids.add(String(i.id).toLowerCase());
    }
  }
  if (appsDir && fs.existsSync(appsDir)) {
    for (const file of collectEntryFiles(appsDir)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw?.id) ids.add(String(raw.id).toLowerCase());
      } catch {
        // 个别损坏文件由 validate-catalog 处理
      }
    }
  }
  return ids;
}

export function loadHistory(dir) {
  const file = path.join(dir, HISTORY_FILE);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveHistory(dir, history) {
  const sorted = Object.fromEntries(Object.entries(history).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, HISTORY_FILE), formatShowcaseJson(sorted), 'utf8');
}

/** 删除条目文件（空 owner 目录一并删除）并记录下架日期；文件不存在时返回 false。 */
export function removeEntry(dir, id, today, history) {
  const coord = parseRepoCoord(id);
  if (!coord) throw new Error(`非法应用标识: ${id}`);
  const file = path.join(dir, coord.owner, `${coord.repo}.json`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  const ownerDir = path.dirname(file);
  if (fs.existsSync(ownerDir) && fs.readdirSync(ownerDir).length === 0) fs.rmdirSync(ownerDir);
  history[coord.id] = today;
  return true;
}

/** 编译（可选清理）：返回 `{ manifest, dropped, text }`。 */
export function runBuild(args) {
  const catalogIds = loadCatalogIds(args.catalog, args.apps ?? null);
  const history = loadHistory(args.dir);
  if (args.remove && removeEntry(args.dir, args.remove, args.today, history)) {
    saveHistory(args.dir, history);
  }
  const loaded = loadEntries(args.dir);
  const generatedAt = `${args.today}T00:00:00Z`;
  const { manifest, dropped } = buildShowcaseManifest(
    loaded.map((l) => l.entry),
    { today: args.today, catalogIds, generatedAt },
  );
  if (args.prune && dropped.length > 0) {
    for (const { entry } of dropped) removeEntry(args.dir, entry.id, args.today, history);
    saveHistory(args.dir, history);
  }
  return { manifest, dropped, text: formatShowcaseJson(manifest) };
}

/** 产物比较忽略 `generated_at`（只在条目变化时才需要重写）。 */
function sameEntries(a, b) {
  try {
    return JSON.stringify(JSON.parse(a).entries) === JSON.stringify(JSON.parse(b).entries);
  } catch {
    return false;
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { manifest, dropped, text } = runBuild(args);
  const current = fs.existsSync(args.out) ? fs.readFileSync(args.out, 'utf8') : '';
  if (args.check) {
    if (!sameEntries(current, text)) {
      console.error('❌ showcase.json 与 showcase/ 不一致，请运行 node scripts/build-showcase.mjs');
      process.exitCode = 1;
      return;
    }
    console.log(`✅ showcase.json 已是最新（${manifest.entries.length} 条）`);
    return;
  }
  if (sameEntries(current, text)) {
    console.log(`showcase.json 无变化（${manifest.entries.length} 条）`);
  } else {
    fs.writeFileSync(args.out, text, 'utf8');
    console.log(`✅ 已写入 showcase.json（${manifest.entries.length} 条）`);
  }
  for (const { entry, reason } of dropped) {
    console.log(`  ${args.prune ? '已下架' : '未纳入'} ${entry.id}（${reason === 'graduated' ? '已被精选收录' : '已到期'}）`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    main();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  }
}
