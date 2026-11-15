#!/usr/bin/env node

/**
 * split-catalog.mjs
 *
 * 一次性迁移工具：把当前单文件 catalog.json 拆分为 apps/<owner>/<repo>.json 独立文件。
 *
 * 用法:
 *   node scripts/split-catalog.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCatalogJson } from './lib/catalog-shared.mjs';
import { reorderCatalogFields } from './ingest-issue.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const catalogPath = path.join(rootDir, 'catalog.json');
const appsDir = path.join(rootDir, 'apps');

if (!fs.existsSync(catalogPath)) {
  console.error(`❌ 未找到 catalog.json: ${catalogPath}`);
  process.exit(1);
}

export function formatAppJson(item) {
  const reordered = reorderCatalogFields(item);
  return (
    formatCatalogJson([reordered])
      .replace(/^\[\s*\n/, '')
      .replace(/\n\s*\]\n?$/, '\n')
      .replace(/^  /gm, '')
  );
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  console.log(`📦 正在将 catalog.json 中的 ${catalog.length} 个应用拆分到 apps/ 目录...`);

  fs.mkdirSync(appsDir, { recursive: true });

  let count = 0;
  for (const item of catalog) {
    const parts = (item.id || '').toLowerCase().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      console.warn(`⚠️ 跳过非法 ID: ${item.id}`);
      continue;
    }
    const [owner, repo] = parts;
    const ownerDir = path.join(appsDir, owner);
    fs.mkdirSync(ownerDir, { recursive: true });

    const filePath = path.join(ownerDir, `${repo}.json`);
    fs.writeFileSync(filePath, formatAppJson(item), 'utf8');
    count++;
  }

  console.log(`✅ 拆分完成！成功生成 ${count} 个应用文件于 ${path.relative(rootDir, appsDir)}/`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main();
}
