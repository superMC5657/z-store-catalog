#!/usr/bin/env node

/**
 * refresh-catalog.mjs
 * 
 * 自动保鲜收录清单脚本：
 * 批量调用 GitHub / Codeberg API，获取各收录应用的最新 Stars、Forks 与 Release Tag，
 * 并自动同步更新 catalog.json。
 * 
 * 用法:
 *   node scripts/refresh-catalog.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const catalogPath = path.join(rootDir, 'catalog.json');

if (!fs.existsSync(catalogPath)) {
  console.error(`❌ 未找到收录清单文件: ${catalogPath}`);
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
console.log(`📋 开始保鲜收录库，已载入 ${catalog.length} 款应用...`);

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const headers = {
  'User-Agent': 'ZStore-Catalog-Refresher/1.0.0',
  'Accept': 'application/vnd.github.v3+json',
};
if (token) {
  headers['Authorization'] = `token ${token}`;
  console.log('🔑 使用环境变量中的 GitHub Token 进行高速拉取 (5000次/小时)');
} else {
  console.log('⚠️ 未检测到 GITHUB_TOKEN，将使用公开匿名限额 (60次/小时)');
}

let updatedCount = 0;

for (let i = 0; i < catalog.length; i++) {
  const item = catalog[i];
  const { owner, repo, forge } = item;

  // 默认作为 GitHub 仓库处理
  if (!forge || forge === 'github') {
    try {
      // 1. 获取最新 Star / Fork / Description / License
      const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
      const repoRes = await fetch(repoUrl, { headers });

      if (repoRes.status === 200) {
        const repoData = await repoRes.json();
        const oldStars = item.stars;
        const newStars = repoData.stargazers_count ?? oldStars;
        const newForks = repoData.forks_count ?? item.forks;

        item.stars = newStars;
        item.forks = newForks;
        if (repoData.license?.spdx_id) {
          item.license = repoData.license.spdx_id;
        }

        // 2. 获取最新 Release Tag
        const releaseUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
        const relRes = await fetch(releaseUrl, { headers });
        if (relRes.status === 200) {
          const relData = await relRes.json();
          if (relData.tag_name) {
            item.default_version = relData.tag_name;
          }
        }

        console.log(`[${i + 1}/${catalog.length}] ✅ ${item.name} (${owner}/${repo}): ⭐ ${oldStars} ➔ ${item.stars}, 🏷️ ${item.default_version}`);
        updatedCount++;
      } else if (repoRes.status === 403) {
        console.warn(`[${i + 1}/${catalog.length}] ⚠️ 触发 GitHub 速率限制 (Rate Limit)，停止后续刷新。`);
        break;
      } else {
        console.warn(`[${i + 1}/${catalog.length}] ⚠️ 请求失败 (${owner}/${repo}): HTTP ${repoRes.status}`);
      }
    } catch (err) {
      console.error(`[${i + 1}/${catalog.length}] ❌ 网络错误 (${owner}/${repo}):`, err.message);
    }
  }

  // 避免高频突发请求
  await new Promise((r) => setTimeout(r, 200));
}

// 格式化写回 catalog.json
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
console.log(`\n🎉 保鲜完成！已成功保鲜 ${updatedCount}/${catalog.length} 款应用数据。`);
