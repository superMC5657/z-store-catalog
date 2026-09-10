#!/usr/bin/env node

/**
 * validate-catalog.mjs
 * 
 * 校验 catalog.json 数据规范与完整性：
 * 用于 PR 自动化检查，确保社区贡献的应用元数据符合 Z-Store 规范。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const catalogPath = path.join(rootDir, 'catalog.json');

if (!fs.existsSync(catalogPath)) {
  console.error(`❌ 错误: 未找到 ${catalogPath}`);
  process.exit(1);
}

let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
} catch (err) {
  console.error(`❌ JSON 语法错误:`, err.message);
  process.exit(1);
}

if (!Array.isArray(catalog)) {
  console.error(`❌ 数据格式错误: catalog.json 根节点必须是一个 Array`);
  process.exit(1);
}

const VALID_PLATFORMS = new Set(['windows', 'linux', 'macos', 'android', 'ios']);
const VALID_CATEGORIES = new Set([
  'system', 'network', 'media', 'security', 'dev', 'graphics', 'office', 'reading', 'ops', 'games'
]);

const seenIds = new Set();
let errorCount = 0;

function reportError(item, msg) {
  const identifier = item?.id || item?.name || '未知项';
  console.error(`  ❌ [${identifier}]: ${msg}`);
  errorCount++;
}

console.log(`🔍 开始校验 catalog.json，共包含 ${catalog.length} 款应用...`);

for (let i = 0; i < catalog.length; i++) {
  const item = catalog[i];

  if (!item || typeof item !== 'object') {
    reportError(item, `第 ${i + 1} 项不是合法的 JSON 对象`);
    continue;
  }

  // 1. 必填基础字段
  const requiredFields = ['id', 'name', 'category', 'description', 'owner', 'repo', 'icon', 'platforms', 'identifiers'];
  for (const field of requiredFields) {
    if (item[field] === undefined || item[field] === null || item[field] === '') {
      reportError(item, `缺少必填字段 '${field}'`);
    }
  }

  // 2. ID 唯一性与格式检查
  if (item.id) {
    if (seenIds.has(item.id)) {
      reportError(item, `应用 ID '${item.id}' 重复出现`);
    }
    seenIds.add(item.id);
    if (!/^[a-z0-9-_]+$/.test(item.id)) {
      reportError(item, `ID '${item.id}' 格式不合法 (仅允许小写字母、数字、连字符和下划线)`);
    }
  }

  // 3. Category 检查
  if (item.category && !VALID_CATEGORIES.has(item.category)) {
    console.warn(`  ⚠️ [${item.id}]: 分类 '${item.category}' 不属于标准分类集合 (${Array.from(VALID_CATEGORIES).join(', ')})`);
  }

  // 4. Platforms 检查
  if (Array.isArray(item.platforms)) {
    if (item.platforms.length === 0) {
      reportError(item, `'platforms' 列表不能为空`);
    }
    for (const p of item.platforms) {
      if (!VALID_PLATFORMS.has(p)) {
        reportError(item, `'platforms' 包含无效平台 '${p}' (仅支持: ${Array.from(VALID_PLATFORMS).join(', ')})`);
      }
    }
  } else {
    reportError(item, `'platforms' 必须是一个数组`);
  }

  // 5. Identifiers 检查
  if (item.identifiers && typeof item.identifiers === 'object' && !Array.isArray(item.identifiers)) {
    for (const [platform, ids] of Object.entries(item.identifiers)) {
      if (!VALID_PLATFORMS.has(platform)) {
        reportError(item, `'identifiers' 包含无效平台键 '${platform}'`);
      }
      if (!Array.isArray(ids)) {
        reportError(item, `'identifiers.${platform}' 必须是一个数组`);
      }
    }
  } else {
    reportError(item, `'identifiers' 必须是一个平台对象映射`);
  }

  // 6. Icon URL 检查
  if (item.icon && !/^https?:\/\//.test(item.icon)) {
    reportError(item, `'icon' 必须是以 http:// 或 https:// 开头的合法 URL`);
  }
}

console.log(`\n──────────────────────────────────────`);
if (errorCount > 0) {
  console.error(`❌ 校验失败: 共发现 ${errorCount} 处错误，请修正后再次提交。`);
  process.exit(1);
} else {
  console.log(`✅ 校验通过！全量 ${catalog.length} 款应用格式与标识符均符合规范。`);
  process.exit(0);
}
