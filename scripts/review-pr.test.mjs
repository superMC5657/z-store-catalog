import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, buildPrompt } from './review-pr.mjs';

test('parses APPROVE with reasons', () => {
  const result = parseVerdict('ok\n\nVERDICT: APPROVE\nREASON: upstream repo matches\nREASON: only catalog.json changed');
  assert.equal(result.verdict, 'APPROVE');
  assert.deepEqual(result.reasons, ['upstream repo matches', 'only catalog.json changed']);
});

test('parses REJECT with reasons', () => {
  const result = parseVerdict('bad icon\n\nVERDICT: REJECT\nREASON: icon returns 404');
  assert.equal(result.verdict, 'REJECT');
  assert.deepEqual(result.reasons, ['icon returns 404']);
});

test('fails closed when no verdict is present', () => {
  const result = parseVerdict('Everything looks fine.');
  assert.equal(result.verdict, 'REJECT');
  assert.match(result.reasons[0], /未返回 VERDICT/);
});

test('uses the last verdict when the message contains several', () => {
  const result = parseVerdict('Draft: VERDICT: APPROVE\nFinal:\nVERDICT: REJECT\nREASON: archived repo');
  assert.equal(result.verdict, 'REJECT');
  assert.deepEqual(result.reasons, ['archived repo']);
});

test('accepts verdict and reason on one line', () => {
  const result = parseVerdict('VERDICT: APPROVE REASON: verified upstream');
  assert.equal(result.verdict, 'APPROVE');
  assert.deepEqual(result.reasons, ['verified upstream']);
});

test('rejects when anything follows the verdict block', () => {
  const result = parseVerdict('VERDICT: APPROVE\nREASON: ok\nNow here is the diff again: ...');
  assert.equal(result.verdict, 'REJECT');
  assert.match(result.reasons[0], /额外内容/);
});

test('catalog prompt uses random delimiters and catalog rules', () => {
  const pr = {
    number: 7,
    title: 'add app',
    body: 'body',
    author: { login: 'alice' },
    url: 'https://example.com/pr/7',
    headRefName: 'catalog/issue-7',
    baseRefName: 'main',
    files: [{ path: 'catalog.json' }],
  };
  const prompt = buildPrompt({ repo: 'o/r', pr, diff: '+{}', isCatalog: true });
  assert.match(prompt, /Hard requirements for a catalog submission PR/);
  const match = prompt.match(/<<<PR_DIFF_([0-9a-f-]+)>>>/);
  assert.ok(match, 'diff delimiter should contain a nonce');
  assert.ok(prompt.includes(`PR_DIFF_${match[1]}>>>`));
  assert.ok(!prompt.includes('<<<PR_DIFF>>>'));
});

test('code prompt uses code review rules', () => {
  const pr = {
    number: 8,
    title: 'fix ci',
    body: 'body',
    author: { login: 'alice' },
    url: 'https://example.com/pr/8',
    headRefName: 'fix/ci',
    baseRefName: 'main',
    files: [{ path: 'scripts/validate-catalog.mjs' }],
  };
  const prompt = buildPrompt({ repo: 'o/r', pr, diff: '+x', isCatalog: false });
  assert.match(prompt, /Hard requirements for a code PR/);
  assert.ok(!prompt.includes('catalog submission PR'));
});
