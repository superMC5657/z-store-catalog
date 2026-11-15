#!/usr/bin/env node

/**
 * build-catalog.mjs
 *
 * 聚合编译器：扫描 apps/<owner>/<repo>.json 所有独立应用清单，
 * 校验、按规范排序并输出统一的根目录 catalog.json。
 *
 * 用法:
 *   node scripts/build-catalog.mjs
 *   node scripts/build-catalog.mjs --check
 *   node scripts/build-catalog.mjs --out path/to/catalog.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCatalogJson } from './lib/catalog-shared.mjs';
import { reorderCatalogFields } from './ingest-issue.mjs';
import { validateCatalog } from './validate-catalog.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const defaultAppsDir = path.join(rootDir, 'apps');
const defaultCatalogPath = path.join(rootDir, 'catalog.json');

export function parseArgs(argv) {
  const args = {
    appsDir: defaultAppsDir,
    catalogPath: defaultCatalogPath,
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apps') {
      const val = argv[++i];
      if (!val) throw new Error('--apps 缺少取值');
      args.appsDir = path.resolve(val);
    } else if (flag === '--out') {
      const val = argv[++i];
      if (!val) throw new Error('--out 缺少取值');
      args.catalogPath = path.resolve(val);
    } else if (flag === '--check') {
      args.check = true;
    } else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法: node scripts/build-catalog.mjs [选项]',
          '  --apps <dir>     apps 目录路径（默认: apps/）',
          '  --out <path>     catalog.json 输出路径（默认: catalog.json）',
          '  --check          仅检查输出与现有 catalog.json 是否一致（CI 校验用）',
        ].join('\n')
      );
      process.exit(0);
    }
  }
  return args;
}

/**
 * 递归收集指定目录下所有的 .json 文件
 */
export function collectAppFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectAppFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * 读取并聚合所有独立应用清单
 */
export function buildCatalogFromApps(appsDir = defaultAppsDir) {
  const appFiles = collectAppFiles(appsDir);
  const items = [];
  const seenIds = new Set();

  for (const filePath of appFiles) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`解析应用文件失败 [${filePath}]: ${err.message}`);
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`应用文件内容必须是 JSON 对象 [${filePath}]`);
    }

    const reordered = reorderCatalogFields(raw);
    const id = (reordered.id || '').toLowerCase();
    if (seenIds.has(id)) {
      throw new Error(`发现重复应用 ID [${id}] 于文件: ${filePath}`);
    }
    seenIds.add(id);
    items.push(reordered);
  }

  // 排序规则：按收录日期 added_at 升序，同一天按 id 字典序升序
  items.sort((a, b) => {
    const d = (a.added_at || '').localeCompare(b.added_at || '');
    if (d !== 0) return d;
    return (a.id || '').localeCompare(b.id || '');
  });

  return items;
}

export function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`🔨 正在扫描 ${path.relative(rootDir, args.appsDir)}/ 编译 catalog.json...`);

  const items = buildCatalogFromApps(args.appsDir);
  console.log(`📦 已载入 ${items.length} 款独立应用。`);

  // 全量规范校验
  const { errors, warnings } = validateCatalog(items);
  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`⚠️ [${w.id}] ${w.msg}`);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(`❌ [${e.id}] ${e.msg}`);
    throw new Error(`编译失败: 存在 ${errors.length} 项格式校验错误`);
  }

  const formatted = formatCatalogJson(items);

  if (args.check) {
    if (!fs.existsSync(args.catalogPath)) {
      console.error(`❌ 未找到待比对的 catalog.json: ${args.catalogPath}`);
      process.exit(1);
    }
    const current = fs.readFileSync(args.catalogPath, 'utf8');
    if (current !== formatted) {
      console.error(`❌ catalog.json 与 apps/ 编译产物不一致！请运行 node scripts/build-catalog.mjs 更新。`);
      process.exit(1);
    }
    console.log(`✅ check 通过：catalog.json 与 apps/ 完全同步。`);
    return;
  }

  fs.writeFileSync(args.catalogPath, formatted, 'utf8');
  console.log(`✅ 编译成功！已写入 ${path.relative(rootDir, args.catalogPath)}（共 ${items.length} 款应用）`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  try {
    main();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  }
}
