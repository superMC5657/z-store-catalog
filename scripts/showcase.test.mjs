import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REPORT_FORM_LABELS,
  SHOWCASE_FORM_LABELS,
  addDays,
  buildShowcaseManifest,
  decideSubmission,
  hasLinkOrContact,
  isOsiLicense,
  parseIssueForm,
  parseKeywords,
  parseRepoCoord,
  promoWarnings,
  validateEntry,
  validatePitch,
  ymdToDays,
} from './lib/showcase-shared.mjs';
import { entryPath, loadCatalogIds, loadHistory, runBuild } from './build-showcase.mjs';
import { evaluateRepo, installableAssets } from './ingest-showcase.mjs';

const TODAY = '2026-11-16';

function entry(id, over = {}) {
  return {
    id,
    submitted_by: id.split('/')[0],
    pitch: '一句话',
    pitch_en: null,
    keywords: [],
    submitted_at: '2026-11-01',
    expires_at: '2027-01-30',
    stars_at_submit: 10,
    renewed: false,
    issue_url: null,
    ...over,
  };
}

test('parseRepoCoord 只接受 GitHub 坐标并归一小写', () => {
  assert.deepEqual(parseRepoCoord('https://github.com/Owner/Repo.git'), { owner: 'owner', repo: 'repo', id: 'owner/repo' });
  assert.equal(parseRepoCoord('Owner/Repo')?.id, 'owner/repo');
  assert.equal(parseRepoCoord('https://github.com/o/r/releases?x=1')?.id, 'o/r');
  assert.equal(parseRepoCoord('https://gitlab.com/o/r'), null);
  assert.equal(parseRepoCoord('codeberg:o/r'), null);
  assert.equal(parseRepoCoord('only-owner'), null);
});

test('parseIssueForm 读取表单正文，_No response_ 视为空', () => {
  const body = [
    '### 仓库地址 / Repository',
    '',
    'https://github.com/o/r',
    '',
    '### 中文自荐语 / Chinese pitch',
    '',
    '一句话介绍',
    '',
    '### 英文自荐语 / English pitch',
    '',
    '_No response_',
    '',
    '### 关键词 / Keywords',
    '',
    'a，b, c',
    '',
    '### 无关标题',
    '',
    'ignored',
  ].join('\r\n');
  const form = parseIssueForm(body, SHOWCASE_FORM_LABELS);
  assert.deepEqual(form, { repo: 'https://github.com/o/r', pitch: '一句话介绍', pitch_en: '', keywords: 'a，b, c' });
  assert.deepEqual(parseKeywords(form.keywords), ['a', 'b', 'c']);
  const report = parseIssueForm('### 被举报的条目 / Entry\n\no/r\n\n### 举报理由 / Reason\n\n恶意软件', REPORT_FORM_LABELS);
  assert.deepEqual(report, { entry: 'o/r', reason: '恶意软件' });
});

test('自荐语规则与客户端同口径，促销词只给复核提示', () => {
  assert.deepEqual(validatePitch({ pitch: '中', keywords: [] }), []);
  assert.equal(validatePitch({ pitch: ' ', pitch_en: '', keywords: [] }).length, 1);
  assert.equal(validatePitch({ pitch: '字'.repeat(81), keywords: [] }).length, 1);
  assert.equal(validatePitch({ pitch_en: 'a'.repeat(161), keywords: [] }).length, 1);
  assert.equal(validatePitch({ pitch: 'p', keywords: ['a', 'b', 'c', 'd'] }).length, 1);
  assert.ok(hasLinkOrContact('见 www.x.io'));
  assert.ok(hasLinkOrContact('me@example.com'));
  assert.ok(!hasLinkOrContact('支持 @提及'));
  assert.equal(validatePitch({ pitch: '价格对比工具', keywords: [] }).length, 0);
  assert.equal(promoWarnings({ pitch: '限时优惠码', keywords: [] }).length, 1);
  assert.equal(promoWarnings({ pitch: '价格对比工具', keywords: [] }).length, 0);
});

test('isOsiLicense 按 SPDX 大小写无关比较', () => {
  assert.ok(isOsiLicense('MIT'));
  assert.ok(isOsiLicense('bsd-3-clause'));
  assert.ok(!isOsiLicense('NOASSERTION'));
  assert.ok(!isOsiLicense(''));
});

test('decideSubmission：新建 / 续期 / 各类拒绝', () => {
  const base = { id: 'o/r', submittedBy: 'o', today: TODAY, catalogIds: new Set(), existing: null, activeBySubmitter: new Map(), history: {} };
  assert.equal(decideSubmission(base).action, 'create');
  assert.equal(decideSubmission({ ...base, catalogIds: new Set(['o/r']) }).action, 'reject');
  assert.equal(decideSubmission({ ...base, existing: entry('o/r', { expires_at: '2027-01-30' }) }).action, 'reject');
  assert.equal(decideSubmission({ ...base, existing: entry('o/r', { expires_at: '2026-11-25' }) }).action, 'renew');
  assert.equal(decideSubmission({ ...base, existing: entry('o/r', { expires_at: '2026-11-25', renewed: true }) }).action, 'reject');
  // 已过期但尚未被每日 --prune 清理的旧条目文件：仍受 180 天冷却期约束
  assert.equal(decideSubmission({ ...base, existing: entry('o/r', { expires_at: '2026-11-01' }) }).action, 'reject');
  assert.equal(decideSubmission({ ...base, existing: entry('o/r', { expires_at: '2026-01-01' }) }).action, 'create');
  assert.equal(decideSubmission({ ...base, history: { 'o/r': '2026-10-01' } }).action, 'reject');
  assert.equal(decideSubmission({ ...base, history: { 'o/r': '2026-01-01' } }).action, 'create');
  assert.equal(decideSubmission({ ...base, activeBySubmitter: new Map([['o', 2]]) }).action, 'reject');
});

test('ymdToDays 拒绝 2 月 31 日等无效日历日期', () => {
  assert.equal(ymdToDays('2026-02-31'), null);
  assert.equal(ymdToDays('2026-04-31'), null);
  assert.ok(Number.isInteger(ymdToDays('2024-02-29')));
  assert.equal(ymdToDays('2025-02-29'), null);
});

test('validateEntry 拦截客户端会整份拒绝的条目', () => {
  assert.deepEqual(validateEntry(entry('o/r')), []);
  assert.ok(validateEntry(entry('O/R')).length > 0);
  assert.ok(validateEntry(entry('o/r', { expires_at: '2026-11-01' })).length > 0);
  assert.ok(validateEntry(entry('o/r', { pitch: null, pitch_en: '' })).length > 0);
  assert.ok(validateEntry({ ...entry('o/r'), extra: 1 }).length > 0);
  assert.ok(validateEntry(entry('o/r', { keywords: 'bad' })).length > 0);
  assert.ok(validateEntry(entry('o/r', { renewed: 'no' })).length > 0);
  assert.ok(validateEntry(entry('o/r', { stars_at_submit: -1 })).length > 0);
});

test('buildShowcaseManifest 剔除到期 / 转正并按提交日期倒序', () => {
  const { manifest, dropped } = buildShowcaseManifest(
    [
      entry('o/old', { submitted_at: '2026-10-01' }),
      entry('o/new', { submitted_at: '2026-11-10' }),
      entry('o/gone', { expires_at: '2026-11-15' }),
      entry('o/edge', { expires_at: TODAY }),
      entry('o/grad'),
    ],
    { today: TODAY, catalogIds: new Set(['o/grad']), generatedAt: `${TODAY}T00:00:00Z` },
  );
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.entries.map((e) => e.id), ['o/new', 'o/edge', 'o/old']);
  assert.deepEqual(dropped.map((d) => [d.entry.id, d.reason]), [['o/gone', 'expired'], ['o/grad', 'graduated']]);
  assert.throws(() => buildShowcaseManifest([entry('o/a'), entry('o/a')], { today: TODAY, catalogIds: new Set() }));
});

test('runBuild --prune 删除到期条目并记入 history；--remove 下架单条', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-test-'));
  try {
    const dir = path.join(tmp, 'showcase');
    const write = (e) => {
      const file = entryPath(dir, e.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(e));
    };
    write(entry('o/keep'));
    write(entry('p/expired', { submitted_at: '2026-08-01', expires_at: '2026-11-01' }));
    write(entry('q/report'));
    const catalog = path.join(tmp, 'catalog.json');
    fs.writeFileSync(catalog, '[]');
    const args = { dir, catalog, today: TODAY, prune: true, remove: 'q/report', out: path.join(tmp, 'showcase.json') };
    const { manifest } = runBuild(args);
    assert.deepEqual(manifest.entries.map((e) => e.id), ['o/keep']);
    assert.ok(!fs.existsSync(path.join(dir, 'p')));
    assert.ok(!fs.existsSync(path.join(dir, 'q')));
    const history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
    assert.deepEqual(history, { 'p/expired': TODAY, 'q/report': TODAY });

    // 对不存在的条目执行 --remove 不应写入 history.json。
    runBuild({ dir, catalog, today: TODAY, prune: false, remove: 'ghost/missing', out: path.join(tmp, 'showcase.json') });
    assert.deepEqual(loadHistory(dir), { 'p/expired': TODAY, 'q/report': TODAY });

    // loadCatalogIds 同时合并 catalog.json 与 apps/（覆盖当日刚合入尚未编译的新条目）。
    const appsDir = path.join(tmp, 'apps');
    fs.mkdirSync(path.join(appsDir, 'newowner'), { recursive: true });
    fs.writeFileSync(path.join(appsDir, 'newowner', 'app.json'), JSON.stringify({ id: 'NewOwner/App' }));
    assert.ok(loadCatalogIds(catalog, appsDir).has('newowner/app'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('evaluateRepo 检查公开、协议、活跃度与可安装资产', () => {
  const repo = { name: 'r', private: false, fork: false, archived: false, license: { spdx_id: 'MIT' }, pushed_at: '2026-11-01T00:00:00Z' };
  const release = { assets: [{ name: 'r-setup.exe' }, { name: 'r.dmg' }] };
  const ok = evaluateRepo({ repo, release, today: TODAY });
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.platforms.includes('windows'));
  assert.equal(evaluateRepo({ repo: { ...repo, fork: true }, release, today: TODAY }).errors.length, 1);
  assert.equal(evaluateRepo({ repo: { ...repo, license: null }, release, today: TODAY }).errors.length, 1);
  assert.equal(evaluateRepo({ repo: { ...repo, pushed_at: '2025-01-01T00:00:00Z' }, release, today: TODAY }).errors.length, 1);
  assert.equal(evaluateRepo({ repo, release: { assets: [{ name: 'checksums.txt' }] }, today: TODAY }).errors.length, 1);
  assert.equal(evaluateRepo({ repo, release: null, today: TODAY }).errors.length, 1);
  assert.equal(installableAssets({ assets: [{ name: 'App.AppImage' }, { name: 'src.txt' }] }).length, 1);
});

test('addDays 跨月跨年', () => {
  assert.equal(addDays('2026-11-16', 90), '2027-02-14');
  assert.throws(() => addDays('bad', 1));
});

test('仓库内 showcase.json 与 showcase/ 一致', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const current = JSON.parse(fs.readFileSync(path.join(root, 'showcase.json'), 'utf8'));
  assert.equal(current.version, 1);
  for (const e of current.entries) assert.deepEqual(validateEntry(e), []);
});
