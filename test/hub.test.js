import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPane,
  parseArgs,
  parsePiSessionText,
  parseTmuxPanes,
  piSessionDirNames,
  publicRow,
  renderTable,
} from '../src/hub.js';

test('parses tmux pane rows', () => {
  const panes = parseTmuxPanes('work\t1\t0\t%3\tnode\t/Users/dev/repo\tpi\n');

  assert.deepEqual(panes, [{
    command: 'node',
    cwd: '/Users/dev/repo',
    pane: 0,
    paneId: '%3',
    session: 'work',
    target: 'work:1.0',
    title: 'pi',
    window: 1,
  }]);
});

test('builds likely Pi session directory names for cwd', () => {
  assert.deepEqual(piSessionDirNames('/Users/dev/repo'), [
    '---Users-dev-repo--',
    '--Users-dev-repo--',
  ]);
});

test('parses Pi session metadata without exposing message text', () => {
  const session = parsePiSessionText([
    JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/Users/dev/private-repo' }),
    JSON.stringify({ type: 'session_info', name: 'Fix parser' }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'user', content: 'PROMPT_SENTINEL' } }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'bash' }] } }),
    'not-json',
  ].join('\n'));

  assert.equal(session.id, 's1');
  assert.equal(session.name, 'Fix parser');
  assert.equal(session.cwd, '/Users/dev/private-repo');
  assert.equal(session.lastRole, 'assistant');
  assert.equal(session.lastStopReason, 'toolUse');
  assert.equal(session.lastToolName, 'bash');
  assert.equal(session.lastTimestamp.toISOString(), '2026-01-01T00:02:00.000Z');
  assert.equal(session.malformedLines, 1);
  assert.doesNotMatch(JSON.stringify(session), /PROMPT_SENTINEL/);
});

test('classifies Pi states from session metadata', () => {
  const pane = { command: 'node' };

  assert.equal(classifyPane(pane, null), 'tmux');
  assert.equal(classifyPane(pane, { lastStopReason: 'error' }), 'error');
  assert.equal(classifyPane(pane, { lastStopReason: 'toolUse' }), 'working');
  assert.equal(classifyPane(pane, { lastRole: 'user' }), 'queued');
  assert.equal(classifyPane(pane, { lastStopReason: 'stop' }), 'waiting');
});

test('default public rows and table hide full local paths', () => {
  const row = publicRow({
    adapter: 'pi',
    command: 'node',
    cwd: '/Users/dev/SECRET_REPO',
    cwdName: 'SECRET_REPO',
    pi: {
      file: '/Users/dev/.pi/agent/sessions/SECRET/session.jsonl',
      name: 'Task',
      lastTimestamp: new Date(),
    },
    state: 'waiting',
    target: 'work:0.0',
  });
  const table = renderTable([row]);

  assert.equal(row.directory, 'SECRET_REPO');
  assert.equal('sessionFile' in row, false);
  assert.doesNotMatch(JSON.stringify(row) + table, /\/Users\/dev/);
});

test('argument parser keeps watch cheap and explicit', () => {
  assert.deepEqual(parseArgs(['--json', '--watch', '--interval', '2', '--pi-root=/tmp/pi', '--tmux', 'tmux']), {
    fullPaths: false,
    help: false,
    interval: 2,
    json: true,
    piRoot: '/tmp/pi',
    tmux: 'tmux',
    watch: true,
  });

  assert.throws(() => parseArgs(['--interval', '0']), /positive integer/);
});
