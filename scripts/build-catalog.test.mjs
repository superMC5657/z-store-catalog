import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCatalogFromApps, collectAppFiles, parseArgs } from './build-catalog.mjs';

test('parseArgs 解析参数', () => {
  const args = parseArgs(['--apps', 'test/apps', '--out', 'test/catalog.json', '--check']);
  assert.equal(args.check, true);
  assert.match(args.appsDir, /test[\\\/]apps/);
  assert.match(args.catalogPath, /test[\\\/]catalog\.json/);
});

test('collectAppFiles 递归检索 json 文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cat-test-'));
  try {
    const sub = path.join(tmp, 'owner');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'repo1.json'), '{}');
    fs.writeFileSync(path.join(sub, 'repo2.json'), '{}');
    fs.writeFileSync(path.join(sub, 'readme.txt'), 'ignore');

    const files = collectAppFiles(tmp);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith('.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildCatalogFromApps 聚合并按 (added_at, id) 排序', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cat-test-'));
  try {
    const o1 = path.join(tmp, 'b-owner');
    const o2 = path.join(tmp, 'a-owner');
    fs.mkdirSync(o1, { recursive: true });
    fs.mkdirSync(o2, { recursive: true });

    fs.writeFileSync(
      path.join(o1, 'app.json'),
      JSON.stringify({ id: 'b-owner/app', name: 'B App', added_at: '2026-11-10' })
    );
    fs.writeFileSync(
      path.join(o2, 'app.json'),
      JSON.stringify({ id: 'a-owner/app', name: 'A App', added_at: '2026-11-10' })
    );
    fs.writeFileSync(
      path.join(o1, 'newer.json'),
      JSON.stringify({ id: 'b-owner/newer', name: 'Newer App', added_at: '2026-11-15' })
    );

    const items = buildCatalogFromApps(tmp);
    assert.equal(items.length, 3);
    // 同一天 2026-11-10 按 id 字典序
    assert.equal(items[0].id, 'a-owner/app');
    assert.equal(items[1].id, 'b-owner/app');
    // 新增日期排最后
    assert.equal(items[2].id, 'b-owner/newer');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
