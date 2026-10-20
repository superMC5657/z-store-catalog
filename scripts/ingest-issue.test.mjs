import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPayload, isReputable, itemCoord, normalizeItem } from './ingest-issue.mjs';

const FENCE = '```';

function bodyWith(payload) {
  return `## 收录申请\n\n### payload_json\n\n${FENCE}json\n${payload}\n${FENCE}\n`;
}

const FACTS = {
  repo: {
    name: 'VoiceStudio',
    description: 'Open-source voice cloning',
    html_url: 'https://github.com/debpalash/voicestudio',
    homepage: 'https://voicestudio.sh',
    stargazers_count: 1234,
    forks_count: 56,
    license: { spdx_id: 'AGPL-3.0' },
    topics: ['audio', 'voice'],
    default_branch: 'main',
    owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
  },
  release: {
    tag_name: 'v1.2.3',
    assets: [
      { name: 'VoiceStudio.exe' },
      { name: 'VoiceStudio.dmg' },
      { name: 'VoiceStudio.AppImage' },
    ],
  },
  deduced: {
    platforms: ['windows', 'macos', 'linux'],
    identifiers: {
      windows: ['VoiceStudio.exe'],
      linux: ['voicestudio'],
      macos: ['VoiceStudio.app'],
      android: [],
      ios: [],
    },
  },
};

test('extractPayload 解析单对象与批量数组', () => {
  assert.deepEqual(extractPayload(bodyWith('{"id":"a/b"}')), { id: 'a/b' });
  assert.deepEqual(extractPayload(bodyWith('[{"id":"a/b"},{"id":"c/d"}]')), [
    { id: 'a/b' },
    { id: 'c/d' },
  ]);
});

test('extractPayload 缺失小节 / 坏 JSON 明确报错', () => {
  assert.throws(() => extractPayload('## 无 payload'), /payload_json/);
  assert.throws(() => extractPayload(bodyWith('{ nope ')), /不是合法 JSON/);
});

test('itemCoord 优先用 id，其次 owner/repo', () => {
  assert.equal(itemCoord({ id: 'Owner/Repo' }), 'owner/repo');
  assert.equal(itemCoord({ owner: 'Owner', repo: 'Repo.git' }), 'owner/repo');
  assert.equal(itemCoord({ name: 'x' }), null);
});

test('normalizeItem 强制 canonical id 并补齐分类/日期/API 事实', () => {
  const warnings = [];
  const reasons = [];
  const item = normalizeItem(
    {
      id: 'WRONG/ID',
      name: 'VoiceStudio',
      owner: 'debpalash',
      repo: 'VoiceStudio',
      description: '本地声音克隆工具',
      description_en: 'Local voice cloning',
      category: 'media',
      license: 'MIT',
      icon: 'https://example.com/icon.png',
      stars: 1,
      forks: 1,
      install_dirs: ['C:/x'],
      publishers: ['x'],
    },
    '2026-10-21',
    FACTS,
    warnings,
    reasons
  );

  assert.equal(item.id, 'debpalash/voicestudio');
  assert.equal(item.category_name, '影音播放');
  assert.equal(item.added_at, '2026-10-21');
  assert.equal(item.is_verified, true);
  assert.equal(item.stars, 1234);
  assert.equal(item.forks, 56);
  assert.equal(item.license, 'AGPL-3.0');
  assert.equal(item.default_version, 'v1.2.3');
  assert.deepEqual(item.platforms, ['windows', 'macos', 'linux']);
  assert.deepEqual(Object.keys(item.identifiers), ['windows', 'linux', 'macos', 'android', 'ios']);
  assert.equal(item.identifiers.windows[0], 'VoiceStudio.exe');
  assert.equal('install_dirs' in item, false);
  assert.equal('publishers' in item, false);
  assert.ok(warnings.some((w) => w.includes('id')));
  assert.equal(reasons.length, 0);
});

test('normalizeItem 从 Release 资产推断缺失的 platforms/identifiers', () => {
  const item = normalizeItem(
    {
      owner: 'debpalash',
      repo: 'voicestudio',
      name: 'VoiceStudio',
      description: '本地声音克隆工具',
      description_en: 'Local voice cloning',
      category: 'media',
      icon: 'https://example.com/icon.png',
    },
    '2026-10-21',
    FACTS
  );
  assert.deepEqual(item.platforms, ['windows', 'macos', 'linux']);
  assert.equal(item.identifiers.linux[0], 'voicestudio');
});

test('normalizeItem 对非 OSI 协议 / fork / 无图标给出 needsReview 理由', () => {
  const reasons = [];
  const facts = {
    ...FACTS,
    repo: { ...FACTS.repo, license: { spdx_id: 'NOASSERTION' }, fork: true, homepage: '' },
  };
  const item = normalizeItem(
    {
      owner: 'debpalash',
      repo: 'voicestudio',
      name: 'VoiceStudio',
      description: '本地声音克隆工具',
      description_en: 'Local voice cloning',
      category: 'media',
      license: 'WTFPL',
    },
    '2026-10-21',
    facts,
    [],
    reasons
  );
  assert.equal(item.license, 'WTFPL');
  assert.ok(reasons.some((r) => r.includes('OSI')));
  assert.ok(reasons.some((r) => r.includes('图标')));
});

test('normalizeItem 字段顺序与 catalog.json 磁盘顺序一致', () => {
  const item = normalizeItem(
    {
      owner: 'debpalash',
      repo: 'voicestudio',
      name: 'VoiceStudio',
      description: '本地声音克隆工具',
      description_en: 'Local voice cloning',
      category: 'media',
      icon: 'https://example.com/icon.png',
      aliases: ['voice', 'voice', ''],
      homepage: 'voicestudio.sh',
    },
    '2026-10-21',
    FACTS
  );
  const expected = [
    'id', 'name', 'owner', 'repo', 'icon', 'icon_bg',
    'description', 'description_en', 'category', 'category_name',
    'aliases', 'default_version', 'added_at', 'license',
    'stars', 'forks', 'is_verified', 'homepage', 'platforms', 'identifiers',
  ];
  assert.deepEqual(Object.keys(item), expected);
  assert.deepEqual(item.aliases, ['voice']);
  assert.equal(item.homepage, 'https://voicestudio.sh');
});

test('isReputable 对外部作者的低星/归档/fork 仓库返回 false', () => {
  const now = new Date().toISOString();
  assert.equal(isReputable({ stars: 10, pushedAt: now, fork: false }), false);
  assert.equal(isReputable({ stars: 500, pushedAt: '2020-01-01T00:00:00Z', fork: false }), false);
  assert.equal(isReputable({ stars: 500, pushedAt: now, fork: true }), false);
  assert.equal(isReputable({ stars: 500, pushedAt: now, fork: false }), true);
  assert.equal(isReputable(null), false);
});

test('normalizeItem 缺 description 时拒绝', () => {
  assert.throws(
    () => normalizeItem({ owner: 'a', repo: 'b', name: 'x', category: 'dev' }, '2026-10-21', {}),
    /description/
  );
});
