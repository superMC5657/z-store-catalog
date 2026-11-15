import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCatalogPrs, parseArgs } from './sync-open-prs.mjs';

test('parseArgs 解析参数', () => {
  const args = parseArgs(['--repo', 'test/repo', '--dry-run']);
  assert.equal(args.repo, 'test/repo');
  assert.equal(args.dryRun, true);
});

test('filterCatalogPrs 过滤出 catalog/issue-* PR 并提取 issueNumber', () => {
  const prs = [
    { number: 1, headRefName: 'catalog/issue-123', title: 'feat: add a' },
    { number: 2, headRefName: 'feat/other', title: 'other pr' },
    { number: 3, headRefName: 'catalog/issue-456', title: 'feat: add b' },
    { number: 4, headRefName: 'chore/refresh-baseline', title: 'refresh' },
  ];
  const filtered = filterCatalogPrs(prs);
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].number, 1);
  assert.equal(filtered[0].issueNumber, '123');
  assert.equal(filtered[1].number, 3);
  assert.equal(filtered[1].issueNumber, '456');
});

test('filterCatalogPrs 处理空列表与异常对象', () => {
  assert.deepEqual(filterCatalogPrs([]), []);
  assert.deepEqual(filterCatalogPrs(null), []);
  assert.deepEqual(filterCatalogPrs([{ number: 5 }]), []);
});
