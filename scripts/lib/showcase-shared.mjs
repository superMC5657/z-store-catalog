/**
 * showcase-shared.mjs
 *
 * 开发者自荐（showcase）的纯逻辑：Issue 表单解析、自荐语规则、条目生命周期与 showcase.json 组装。
 * 规则与客户端（z-store `src-tauri/src/github/showcase.rs`、`commands/catalog_showcase.rs`）同口径：
 * 客户端会对 showcase.json 做同样的严格校验，任一条目非法即整份拒绝。
 */

export const SHOWCASE_MANIFEST_VERSION = 1;
/** 每条自荐展示天数。 */
export const SHOWCASE_WINDOW_DAYS = 90;
/** 剩余天数不超过该值时可续期（每条只能续期一次）。 */
export const SHOWCASE_RENEW_WINDOW_DAYS = 14;
/** 同一提交人同时有效的自荐上限。 */
export const SHOWCASE_MAX_ACTIVE_PER_SUBMITTER = 2;
/** 下架后再次自荐的冷却天数（续期不受影响）。 */
export const SHOWCASE_COOLDOWN_DAYS = 180;
/** 仓库最近推送距今上限（天）。 */
export const SHOWCASE_MAX_INACTIVE_DAYS = 180;

export const PITCH_MAX = 80;
export const PITCH_EN_MAX = 160;
export const KEYWORDS_MAX = 3;
export const KEYWORD_MAX = 20;

/** 条目字段固定顺序（与客户端 `ShowcaseEntry` 一致）。 */
export const ENTRY_FIELD_ORDER = [
  'id', 'submitted_by', 'pitch', 'pitch_en', 'keywords',
  'submitted_at', 'expires_at', 'stars_at_submit', 'renewed', 'issue_url',
];

/**
 * OSI 认证协议（SPDX，大写比较）：与客户端 `[license_gate].allowed` 默认名单同值，
 * 另含 GitHub 常见的 `BSD-*` / `Unlicense` 等 SPDX 写法。
 */
export const OSI_SPDX = new Set([
  'MIT', 'ISC', 'APACHE-2.0', 'APACHE-1.1',
  'GPL-2.0', 'GPL-2.0-ONLY', 'GPL-2.0-OR-LATER', 'GPL-3.0', 'GPL-3.0-ONLY', 'GPL-3.0-OR-LATER',
  'LGPL-2.0', 'LGPL-2.0-ONLY', 'LGPL-2.0-OR-LATER', 'LGPL-2.1', 'LGPL-2.1-ONLY', 'LGPL-2.1-OR-LATER',
  'LGPL-3.0', 'LGPL-3.0-ONLY', 'LGPL-3.0-OR-LATER',
  'AGPL-3.0', 'AGPL-3.0-ONLY', 'AGPL-3.0-OR-LATER',
  'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'MPL-2.0', 'MPL-1.1', 'MPL-1.0', 'MS-PL', 'MS-RL',
  'UNLICENSE', 'ZLIB', 'ARTISTIC-2.0', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'OSL-3.0', 'AFL-3.0',
]);

export function isOsiLicense(spdx) {
  return typeof spdx === 'string' && OSI_SPDX.has(spdx.trim().toUpperCase());
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → UTC 天序号；非法返回 null。 */
export function ymdToDays(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Math.floor(Date.UTC(Number(m[1]), month - 1, day) / DAY_MS);
}

export function daysToYmd(days) {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(ymd, n) {
  const d = ymdToDays(ymd);
  if (d === null) throw new Error(`非法日期: ${ymd}`);
  return daysToYmd(d + n);
}

/** 规范 GitHub 坐标：接受 `owner/repo` 或 `https://github.com/owner/repo[.git][/...]`。 */
export function parseRepoCoord(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  let path = raw;
  const url = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(raw);
  if (url) path = url[1];
  else if (/^[a-z]+:\/\//i.test(raw) || raw.includes(':')) return null;
  const parts = path.replace(/[?#].*$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0].toLowerCase();
  const repo = parts[1].toLowerCase().replace(/\.git$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(owner)) return null;
  if (!/^[a-z0-9._-]{1,100}$/.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo, id: `${owner}/${repo}` };
}

/** Issue 表单字段标签 → 字段键（与 `.github/ISSUE_TEMPLATE/*.yml` 的 label 一致）。 */
export const SHOWCASE_FORM_LABELS = {
  '仓库地址 / Repository': 'repo',
  '中文自荐语 / Chinese pitch': 'pitch',
  '英文自荐语 / English pitch': 'pitch_en',
  '关键词 / Keywords': 'keywords',
};

export const REPORT_FORM_LABELS = {
  '被举报的条目 / Entry': 'entry',
  '原自荐 Issue / Original issue': 'issue',
  '举报理由 / Reason': 'reason',
  '补充说明 / Details': 'details',
};

/**
 * 解析 GitHub Issue 表单渲染出的正文（`### 标签` + 空行 + 值；未填为 `_No response_`）。
 * 只认 `labels` 中列出的标题，其余标题忽略。
 */
export function parseIssueForm(body, labels) {
  const out = {};
  if (typeof body !== 'string') return out;
  const sections = body.replace(/\r\n/g, '\n').split(/^### /m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf('\n');
    const heading = (nl === -1 ? section : section.slice(0, nl)).trim();
    const key = labels[heading];
    if (!key) continue;
    const value = (nl === -1 ? '' : section.slice(nl + 1)).trim();
    out[key] = value === '_No response_' ? '' : value;
  }
  return out;
}

export function parseKeywords(raw) {
  return String(raw ?? '')
    .split(/[,，\n]/)
    .map((k) => k.trim())
    .filter((k) => k !== '');
}

/** 链接 / 邮箱粗检，与客户端 `contains_link_or_contact` 同规则。 */
export function hasLinkOrContact(text) {
  const lower = String(text ?? '').toLowerCase();
  if (lower.includes('http://') || lower.includes('https://') || lower.includes('www.')) return true;
  return lower.split(/\s+/).some((w) => {
    const at = w.indexOf('@');
    return at > 0 && w.slice(at + 1).includes('.');
  });
}

/** 促销类词表：命中不直接拒绝（可能是正常描述），而是标记待人工复核。 */
const PROMO_WORDS = ['优惠', '折扣', '促销', '限时', '免费领', '优惠码', '￥', '¥', 'discount', 'coupon', 'promo code'];

export function promoWarnings({ pitch = '', pitch_en = '', keywords = [] }) {
  const lowerAll = [pitch, pitch_en, ...keywords].join(' ').toLowerCase();
  const hits = PROMO_WORDS.filter((w) => lowerAll.includes(w.toLowerCase()));
  return hits.length > 0 ? [`自荐语疑似含促销信息（${hits.join('、')}），请维护者复核`] : [];
}

/** 自荐语硬规则（与客户端同口径）：返回问题列表（空即通过）。 */
export function validatePitch({ pitch = '', pitch_en = '', keywords = [] }) {
  const errors = [];
  const p = String(pitch).trim();
  const pe = String(pitch_en).trim();
  if (!p && !pe) errors.push('请至少填写一种自荐语');
  if ([...p].length > PITCH_MAX) errors.push(`中文自荐语不能超过 ${PITCH_MAX} 字`);
  if ([...pe].length > PITCH_EN_MAX) errors.push(`英文自荐语不能超过 ${PITCH_EN_MAX} 个字符`);
  if (keywords.length > KEYWORDS_MAX) errors.push(`关键词最多 ${KEYWORDS_MAX} 个`);
  if (keywords.some((k) => [...k].length > KEYWORD_MAX)) errors.push(`单个关键词不能超过 ${KEYWORD_MAX} 字`);
  if ([p, pe, ...keywords].some(hasLinkOrContact)) errors.push('自荐语只描述应用本身，不能包含链接或联系方式');
  return errors;
}

/** 有效条目：到期日当天仍有效。 */
export function isActive(entry, todayYmd) {
  const exp = ymdToDays(entry?.expires_at);
  const today = ymdToDays(todayYmd);
  return exp !== null && today !== null && exp >= today;
}

/** 按固定字段顺序输出条目（缺省字段用默认值补齐）。 */
export function orderEntry(entry) {
  const defaults = { pitch: null, pitch_en: null, keywords: [], stars_at_submit: 0, renewed: false, issue_url: null };
  const out = {};
  for (const key of ENTRY_FIELD_ORDER) {
    const v = entry[key];
    out[key] = v === undefined || v === '' ? defaults[key] ?? v : v;
  }
  return out;
}

/**
 * 判定一次提交的去向：新建 / 续期 / 拒绝。
 * - 已在精选收录库：拒绝；
 * - 已有有效条目：剩余 ≤ 14 天且未续期 → 续期（到期日顺延 90 天），否则拒绝；
 * - 冷却期内（下架未满 180 天）：拒绝；
 * - 提交人有效条目已达上限：拒绝。
 */
export function decideSubmission({ id, submittedBy, today, catalogIds, existing, activeBySubmitter, history }) {
  if (catalogIds.has(id)) return { action: 'reject', reason: '该应用已在精选收录库中，无需自荐' };
  if (existing && isActive(existing, today)) {
    const left = ymdToDays(existing.expires_at) - ymdToDays(today);
    if (existing.renewed) return { action: 'reject', reason: '该自荐已续期过一次，到期后需等待冷却期再提交' };
    if (left > SHOWCASE_RENEW_WINDOW_DAYS) {
      return { action: 'reject', reason: `该应用正在自荐中，到期前 ${SHOWCASE_RENEW_WINDOW_DAYS} 天内可申请续期` };
    }
    return { action: 'renew' };
  }
  const removedAt = history?.[id];
  if (removedAt) {
    const since = ymdToDays(today) - ymdToDays(removedAt);
    if (since < SHOWCASE_COOLDOWN_DAYS) {
      return { action: 'reject', reason: `该应用自荐下架未满 ${SHOWCASE_COOLDOWN_DAYS} 天，暂不能再次自荐` };
    }
  }
  const active = activeBySubmitter.get(submittedBy.toLowerCase()) ?? 0;
  if (active >= SHOWCASE_MAX_ACTIVE_PER_SUBMITTER) {
    return { action: 'reject', reason: `每位开发者同时最多 ${SHOWCASE_MAX_ACTIVE_PER_SUBMITTER} 个有效自荐` };
  }
  return { action: 'create' };
}

/**
 * showcase.json 条目结构校验（客户端同口径）：返回错误列表，空即通过。
 */
export function validateEntry(entry) {
  const errors = [];
  const id = entry?.id;
  const coord = parseRepoCoord(id);
  if (!coord || coord.id !== id) errors.push(`非法应用标识: ${id}`);
  if (typeof entry?.submitted_by !== 'string' || !entry.submitted_by.trim()) errors.push(`缺少提交人: ${id}`);
  const sub = ymdToDays(entry?.submitted_at);
  const exp = ymdToDays(entry?.expires_at);
  if (sub === null) errors.push(`提交日期非法: ${id}`);
  if (exp === null) errors.push(`到期日期非法: ${id}`);
  if (sub !== null && exp !== null && exp <= sub) errors.push(`到期日期须晚于提交日期: ${id}`);
  const keywords = Array.isArray(entry?.keywords) ? entry.keywords : [];
  for (const e of validatePitch({ pitch: entry?.pitch ?? '', pitch_en: entry?.pitch_en ?? '', keywords })) {
    errors.push(`${e}: ${id}`);
  }
  for (const key of Object.keys(entry ?? {})) {
    if (!ENTRY_FIELD_ORDER.includes(key)) errors.push(`未知字段 ${key}: ${id}`);
  }
  return errors;
}

/**
 * 由各条目文件组装 showcase.json：剔除到期与已被精选收录的条目，按提交日期倒序、同日按 id。
 * 返回 `{ manifest, dropped }`，`dropped` 为被剔除条目及原因（供 prune 归档与日志）。
 */
export function buildShowcaseManifest(entries, { today, catalogIds, generatedAt }) {
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of entries) {
    const entry = orderEntry(raw);
    const errors = validateEntry(entry);
    if (errors.length > 0) throw new Error(errors.join('；'));
    if (seen.has(entry.id)) throw new Error(`重复的自荐条目: ${entry.id}`);
    seen.add(entry.id);
    if (catalogIds.has(entry.id)) dropped.push({ entry, reason: 'graduated' });
    else if (!isActive(entry, today)) dropped.push({ entry, reason: 'expired' });
    else kept.push(entry);
  }
  kept.sort((a, b) =>
    a.submitted_at === b.submitted_at ? a.id.localeCompare(b.id) : a.submitted_at < b.submitted_at ? 1 : -1,
  );
  return {
    manifest: { version: SHOWCASE_MANIFEST_VERSION, generated_at: generatedAt, entries: kept },
    dropped,
  };
}

export function formatShowcaseJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
