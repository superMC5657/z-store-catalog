#!/usr/bin/env node

/**
 * sync-open-prs.mjs
 *
 * 自动同步处于打开状态的 catalog/issue-* PR：
 * 当 main 分支推进（例如某个收录 PR 合并或每日 baseline refresh 合并）后，
 * 其他仍处于 open 状态的收录 PR 会因为 catalog.json 尾部追加产生文本冲突。
 * 本脚本检测所有落后于 main 的 catalog/issue-* PR，基于最新 main 重新执行
 * ingest-issue.mjs 追加写入、校验并强制推送到对应分支，同时写回 catalog-ingest 状态。
 *
 * 用法:
 *   node scripts/sync-open-prs.mjs
 *   node scripts/sync-open-prs.mjs --repo owner/repo
 *   node scripts/sync-open-prs.mjs --dry-run
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function parseArgs(argv) {
  const args = {
    repo: process.env.REPO || process.env.GITHUB_REPOSITORY || 'superMC5657/z-store-catalog',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--repo') {
      const val = argv[++i];
      if (!val) throw new Error('--repo 缺少取值');
      args.repo = val;
    } else if (flag === '--dry-run') {
      args.dryRun = true;
    } else if (flag === '--help' || flag === '-h') {
      console.log(
        [
          '用法: node scripts/sync-open-prs.mjs [选项]',
          '  --repo <owner/repo>   仓库名称（默认取 GITHUB_REPOSITORY）',
          '  --dry-run             仅检测待同步 PR，不执行写盘与远端推送',
        ].join('\n')
      );
      process.exit(0);
    }
  }
  return args;
}

export function filterCatalogPrs(prs) {
  return (prs || [])
    .map((pr) => {
      const match = (pr.headRefName || '').match(/^catalog\/issue-(\d+)$/);
      if (!match) return null;
      return {
        ...pr,
        issueNumber: match[1],
      };
    })
    .filter(Boolean);
}

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: rootDir,
    encoding: 'utf8',
    env: process.env,
    ...opts,
  });
}

function runInherit(cmd, opts = {}) {
  execSync(cmd, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
    ...opts,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`🔍 检查仓库 ${args.repo} 中待同步的 catalog/issue-* PR...`);

  // 1. 获取所有针对 main 的打开状态 PR
  let prsJson;
  try {
    prsJson = run(`gh pr list --repo "${args.repo}" --state open --base main --json number,headRefName,url,title,mergeStateStatus,mergeable`);
  } catch (err) {
    console.error(`❌ 获取 PR 列表失败: ${err.message}`);
    process.exit(1);
  }

  const allPrs = JSON.parse(prsJson || '[]');
  const catalogPrs = filterCatalogPrs(allPrs);

  if (catalogPrs.length === 0) {
    console.log('ℹ️ 没有处于打开状态的 catalog/issue-* PR，无需同步。');
    return;
  }

  console.log(`📋 找到 ${catalogPrs.length} 个打开状态的收录 PR: ${catalogPrs.map((p) => `#${p.number}`).join(', ')}`);

  // 2. 确保本地 origin/main 为最新
  try {
    run('git fetch origin main');
  } catch (err) {
    console.warn(`⚠️ 拉取 origin/main 失败: ${err.message}`);
  }

  let syncedCount = 0;

  for (const pr of catalogPrs) {
    const issueNumber = pr.issueNumber;

    // 检查是否落后于 origin/main 或存在冲突
    let isUpToDate = false;
    try {
      run(`git fetch origin "${pr.headRefName}"`);
      run(`git merge-base --is-ancestor origin/main "origin/${pr.headRefName}"`, { stdio: 'ignore' });
      isUpToDate = true;
    } catch {
      isUpToDate = false;
    }

    if (isUpToDate && pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus !== 'DIRTY') {
      console.log(`⏩ PR #${pr.number} (${pr.headRefName}) 已基于最新 main 且无冲突，跳过。`);
      continue;
    }

    console.log(`🔄 PR #${pr.number} (${pr.headRefName}, Issue #${issueNumber}) 基线落后或冲突，正在重新基于最新 main 重建...`);

    if (args.dryRun) {
      console.log(`🧪 [dry-run] 将同步 Issue #${issueNumber} 到分支 ${pr.headRefName}`);
      syncedCount++;
      continue;
    }

    try {
      // 切换到 clean 的 origin/main
      runInherit('git checkout -f origin/main');

      // 重新执行收录追加
      const tempTitleFile = path.join(os.tmpdir(), `pr-title-${issueNumber}.txt`);
      runInherit(`node scripts/ingest-issue.mjs --issue "${issueNumber}" --repo "${args.repo}" --write --pr-title "${tempTitleFile}"`);

      // 校验生成后的 catalog.json
      runInherit('node scripts/validate-catalog.mjs');

      // 检查是否有变动
      const diff = run('git status --porcelain catalog.json').trim();
      if (!diff) {
        console.log(`⚠️ PR #${pr.number} 重建后 catalog.json 无变动，跳过推送。`);
        runInherit('git checkout -f origin/main');
        continue;
      }

      // 获取提交标题
      let title = pr.title;
      if (fs.existsSync(tempTitleFile)) {
        const fileTitle = fs.readFileSync(tempTitleFile, 'utf8').trim();
        if (fileTitle) title = fileTitle;
      }

      // 提交并强制推送到 PR 分支
      run(`git config user.name "github-actions[bot]"`);
      run(`git config user.email "github-actions[bot]@users.noreply.github.com"`);
      run(`git checkout -B "${pr.headRefName}" origin/main`);
      run(`git add catalog.json`);

      const commitMsgFile = path.join(os.tmpdir(), `commit-msg-${issueNumber}.txt`);
      fs.writeFileSync(commitMsgFile, title, 'utf8');
      runInherit(`git commit -F "${commitMsgFile}"`);
      runInherit(`git push --force origin "HEAD:refs/heads/${pr.headRefName}"`);

      // 回写 catalog-ingest status
      const sha = run('git rev-parse HEAD').trim();
      run(
        `gh api -X POST "repos/${args.repo}/statuses/${sha}" -f state=success -f context=catalog-ingest -f description="catalog.json validated by sync"`
      );

      console.log(`✅ PR #${pr.number} (${pr.headRefName}) 已成功更新基线并推送！`);
      syncedCount++;
    } catch (err) {
      console.error(`❌ 同步 PR #${pr.number} 失败: ${err.message}`);
    } finally {
      // 恢复工作区到 origin/main
      try {
        run('git checkout -f origin/main');
      } catch {
        // ignore
      }
    }
  }

  console.log(`🏁 同步完成：共处理 ${syncedCount} 个 PR。`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`❌ 同步过程发生异常: ${err.message}`);
    process.exitCode = 1;
  });
}
