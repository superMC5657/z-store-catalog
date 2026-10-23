#!/usr/bin/env node

/**
 * validate-catalog.mjs
 *
 * 校验 catalog.json 数据规范与完整性：
 * 用于 PR 自动化检查，确保社区贡献的应用元数据符合 Z-Store 规范。
 * 规则同时供 ingest-issue.mjs 在写入前复用（唯一真源）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
// 默认校验仓库根 catalog.json；CI 评审 PR 时可用 CATALOG_PATH 指向 PR 版本。
const catalogPath = process.env.CATALOG_PATH
  ? path.resolve(process.env.CATALOG_PATH)
  : path.join(rootDir, 'catalog.json');

export const VALID_PLATFORMS = new Set(['windows', 'linux', 'macos', 'android', 'ios']);
export const VALID_CATEGORIES = new Set([
  'system', 'network', 'media', 'security', 'dev', 'graphics', 'office', 'reading', 'ops', 'games'
]);

// catalog.json 磁盘字段顺序（与 Rust CatalogItem 的序列化顺序对齐）。
// install_dirs / search_subdirs / publishers 为可选扩展字段，省略时不影响顺序。
export const FIELD_ORDER = [
  'id', 'name', 'owner', 'repo', 'icon', 'icon_bg',
  'description', 'description_en', 'category', 'category_name',
  'aliases', 'default_version', 'added_at', 'license',
  'stars', 'forks', 'is_verified', 'homepage',
  'install_dirs', 'search_subdirs', 'publishers',
  'platforms', 'identifiers',
];
const KNOWN_FIELDS = new Set(FIELD_ORDER);

/**
 * 校验整份 catalog（纯函数）。
 * 返回 { errors, warnings }，元素形如 { id, msg }，按条目顺序排列。
 */
export function validateCatalog(catalog) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(catalog)) {
    errors.push({ id: 'catalog', msg: 'catalog.json 根节点必须是一个 Array' });
    return { errors, warnings };
  }

  const seenIds = new Set();

  const reportError = (item, msg) =>
    errors.push({ id: item?.id || item?.name || '未知项', msg });

  for (let i = 0; i < catalog.length; i++) {
    const item = catalog[i];

    if (!item || typeof item !== 'object') {
      reportError(item, `第 ${i + 1} 项不是合法的 JSON 对象`);
      continue;
    }

    // 1. 必填基础字段（description 中文必填，description_en 英文必填）
    const requiredFields = ['id', 'name', 'category', 'description', 'description_en', 'owner', 'repo', 'icon', 'platforms', 'identifiers', 'added_at', 'aliases'];
    for (const field of requiredFields) {
      if (item[field] === undefined || item[field] === null || item[field] === '') {
        reportError(item, `缺少必填字段 '${field}'`);
      }
    }

    // 1a. 字段顺序必须符合固定 schema（JSON 对象键顺序在解析后保持写入顺序）
    const keys = Object.keys(item);
    const actualOrder = keys.filter((k) => KNOWN_FIELDS.has(k));
    const expectedOrder = FIELD_ORDER.filter((k) => actualOrder.includes(k));
    if (actualOrder.join(',') !== expectedOrder.join(',')) {
      const pos = actualOrder.findIndex((k, n) => k !== expectedOrder[n]);
      reportError(item, `字段顺序不符：第 ${pos + 1} 个字段应为 '${expectedOrder[pos]}'，实际为 '${actualOrder[pos]}'`);
    }
    const unknownFields = keys.filter((k) => !KNOWN_FIELDS.has(k));
    if (unknownFields.length > 0) {
      warnings.push({ id: item.id, msg: `包含未登记字段: ${unknownFields.join(', ')}（如为客户端扩展字段，请同步 FIELD_ORDER）` });
    }

    // 1b. description / description_en 必须为非空字符串（缺失已由必填校验覆盖，此处仅校验类型）
    for (const field of ['description', 'description_en']) {
      const v = item[field];
      if (v !== undefined && v !== null && v !== '' && (typeof v !== 'string' || !v.trim())) {
        reportError(item, `'${field}' 必须是非空字符串`);
      }
    }

    // 1c. added_at 必须为合法的 YYYY-MM-DD 日期（该应用被收录进 catalog.json 的日期，UTC）
    if (item.added_at !== undefined && item.added_at !== null && item.added_at !== '') {
      if (typeof item.added_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.added_at)) {
        reportError(item, `'added_at' 格式不合法 (应为 YYYY-MM-DD，如 2026-10-16)`);
      } else {
        const [y, m, d] = item.added_at.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
          reportError(item, `'added_at' '${item.added_at}' 不是合法的日历日期`);
        }
      }
    }

    // 1d. aliases 必须为数组且元素必须为非空字符串
    if (item.aliases !== undefined && item.aliases !== null) {
      if (!Array.isArray(item.aliases)) {
        reportError(item, `'aliases' 必须是一个数组`);
      } else {
        for (const alias of item.aliases) {
          if (typeof alias !== 'string' || !alias.trim()) {
            reportError(item, `'aliases' 包含无效别名 (必须是非空字符串)`);
          }
        }
      }
    }

    // 2. ID 检查（ADR-0010）：id 必须为小写 owner/repo 全局唯一标识
    if (item.id) {
      if (seenIds.has(item.id.toLowerCase())) {
        reportError(item, `应用 ID '${item.id}' 重复出现`);
      }
      seenIds.add(item.id.toLowerCase());
      if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(item.id)) {
        reportError(item, `ID '${item.id}' 格式不合法 (必须为小写 owner/repo)`);
      }
      if (item.owner && item.repo) {
        const canonical = `${item.owner}/${item.repo}`.toLowerCase();
        if (item.id !== canonical) {
          reportError(item, `ID '${item.id}' 与 owner/repo 不一致 (应为 '${canonical}')`);
        }
      }
    }

    // 3. Category 检查
    if (item.category && !VALID_CATEGORIES.has(item.category)) {
      warnings.push({ id: item.id, msg: `分类 '${item.category}' 不属于标准分类集合 (${Array.from(VALID_CATEGORIES).join(', ')})` });
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

  return { errors, warnings };
}

function main() {
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

  console.log(`🔍 开始校验 catalog.json，共包含 ${catalog.length} 款应用...`);

  const { errors, warnings } = validateCatalog(catalog);

  for (const w of warnings) {
    console.warn(`  ⚠️ [${w.id}]: ${w.msg}`);
  }
  for (const e of errors) {
    console.error(`  ❌ [${e.id}]: ${e.msg}`);
  }

  console.log(`\n──────────────────────────────────────`);
  if (errors.length > 0) {
    console.error(`❌ 校验失败: 共发现 ${errors.length} 处错误，请修正后再次提交。`);
    process.exit(1);
  } else {
    console.log(`✅ 校验通过！全量 ${catalog.length} 款应用格式与标识符均符合规范。`);
    process.exit(0);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main();
}
