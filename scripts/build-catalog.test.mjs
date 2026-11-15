import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCatalogFromApps, collectAppFiles, loadExistingCatalogMap, parseArgs } from './build-catalog.mjs';

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

test('buildCatalogFromApps 增量保留现有 catalog.json 的动态字段，同时以 apps/ 静态字段为准', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cat-inc-'));
  try {
    const ownerDir = path.join(tmp, 'apps', 'acme');
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.writeFileSync(
      path.join(ownerDir, 'tool.json'),
      JSON.stringify({
        id: 'acme/tool',
        name: 'Tool',
        description: '新修改的中文简介',
        description_en: 'Updated English desc',
        default_version: 'v1.0.0',
        added_at: '2026-10-01',
        stars: 100,
        forks: 10,
      })
    );
    fs.writeFileSync(
      path.join(ownerDir, 'newapp.json'),
      JSON.stringify({
        id: 'acme/newapp',
        name: 'NewApp',
        default_version: 'v0.1.0',
        added_at: '2026-11-16',
        stars: 50,
        forks: 5,
      })
    );

    const catalogFile = path.join(tmp, 'catalog.json');
    fs.writeFileSync(
      catalogFile,
      JSON.stringify([
        {
          id: 'acme/tool',
          name: 'Tool',
          description: '旧中文简介',
          description_en: 'Old English desc',
          default_version: 'v2.3.0',
          added_at: '2026-10-01',
          stars: 999,
          forks: 88,
        },
      ])
    );

    const existingMap = loadExistingCatalogMap(catalogFile);
    const items = buildCatalogFromApps(path.join(tmp, 'apps'), existingMap);
    assert.equal(items.length, 2);

    const tool = items.find((i) => i.id === 'acme/tool');
    assert.equal(tool.description, '新修改的中文简介');
    assert.equal(tool.description_en, 'Updated English desc');
    assert.equal(tool.stars, 999);
    assert.equal(tool.forks, 88);
    assert.equal(tool.default_version, 'v2.3.0');

    const newapp = items.find((i) => i.id === 'acme/newapp');
    assert.equal(newapp.stars, 50);
    assert.equal(newapp.forks, 5);
    assert.equal(newapp.default_version, 'v0.1.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
