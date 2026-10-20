import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, buildPrompt, lastAgentText, timeoutResult } from './review-pr.mjs';

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

test('prefers the last agent message containing VERDICT over a later completion message', () => {
  const activities = [
    { originator: 'agent', agentMessaged: { agentMessage: 'analysis...' } },
    { originator: 'agent', agentMessaged: { agentMessage: 'VERDICT: APPROVE\nREASON: verified' } },
    { originator: 'agent', agentMessaged: { agentMessage: 'I have finished the review.' } },
  ];
  assert.match(lastAgentText(activities), /VERDICT: APPROVE/);
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

test('finds VERDICT in progressUpdated when agent messages only say the review finished', () => {
  const activities = [
    {
      originator: 'agent',
      progressUpdated: {
        title: 'Reviewing PR #29',
        description: 'VERDICT: APPROVE\nREASON: catalog entry matches upstream',
      },
    },
    { originator: 'agent', agentMessaged: { agentMessage: 'I have finished the review.' } },
  ];
  const text = lastAgentText(activities);
  assert.match(text, /VERDICT: APPROVE/);
  const result = parseVerdict(text);
  assert.equal(result.verdict, 'APPROVE');
  assert.deepEqual(result.reasons, ['catalog entry matches upstream']);
});

test('still fails closed when no agent activity contains a verdict', () => {
  const activities = [
    { originator: 'agent', progressUpdated: { title: 'Reviewing', description: 'Looks fine to me.' } },
    { originator: 'agent', agentMessaged: { agentMessage: 'I have finished the review.' } },
  ];
  const result = parseVerdict(lastAgentText(activities));
  assert.equal(result.verdict, 'REJECT');
  assert.match(result.reasons[0], /未返回 VERDICT/);
});

test('timeout is PENDING, not a semantic rejection', () => {
  const base = { pr: 25, repo: 'o/r', headSha: 'abc123', files: ['catalog.json'], isCatalog: true };
  const result = timeoutResult(base, 1800, {
    session: 'sessions/123',
    sessionUrl: 'https://jules.example/sessions/123',
    state: 'IN_PROGRESS',
  });
  assert.equal(result.verdict, 'PENDING');
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /1800s/);
  assert.match(result.reasons[0], /超时/);
  assert.equal(result.state, 'IN_PROGRESS');
  assert.equal(result.session, 'sessions/123');
  assert.equal(result.sessionUrl, 'https://jules.example/sessions/123');
  assert.equal(result.message, 'session still running');
  assert.equal(result.fixture, false);
  assert.equal(result.pr, 25);
});
