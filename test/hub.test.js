import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  classifyPane,
  jumpToTarget,
  latestPiSessionForCwd,
  parseArgs,
  parsePiSessionText,
  parseTarget,
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

test('skips broken Pi session dirs without leaking path errors', async () => {
  const piRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-'));
  const cwd = path.join(os.tmpdir(), 'SECRET_CWD_SENTINEL');
  await writeFile(path.join(piRoot, piSessionDirNames(cwd)[0]), 'not a dir');

  const session = await latestPiSessionForCwd(cwd, piRoot);

  assert.equal(session, null);
});

test('finds latest Pi session for cwd', async () => {
  const piRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-'));
  const cwd = path.join(os.tmpdir(), 'pi-tmux-hub-cwd');
  const dir = path.join(piRoot, piSessionDirNames(cwd)[0]);
  await mkdir(dir);
  await writeFile(path.join(dir, 'session.jsonl'), [
    JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'session_info', name: 'E2E task' }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'assistant', stopReason: 'stop', content: 'PROMPT_SENTINEL' } }),
  ].join('\n'));

  const session = await latestPiSessionForCwd(cwd, piRoot);

  assert.equal(session.name, 'E2E task');
  assert.equal(session.lastStopReason, 'stop');
  assert.doesNotMatch(JSON.stringify(session), /PROMPT_SENTINEL/);
});

test('classifies Pi states from session metadata', () => {
  const pane = { command: 'node' };

  assert.equal(classifyPane(pane, null), 'tmux');
  assert.equal(classifyPane(pane, { lastStopReason: 'error' }), 'error');
  assert.equal(classifyPane(pane, { lastStopReason: 'toolUse' }), 'working');
  assert.equal(classifyPane(pane, { lastRole: 'user' }), 'working');
  assert.equal(classifyPane(pane, { lastStopReason: 'stop' }), 'waiting');
});

test('parses tmux jump targets', () => {
  assert.deepEqual(parseTarget('agents:1.2'), {
    session: 'agents',
    window: '1',
    pane: '2',
    windowTarget: 'agents:1',
  });
  assert.throws(() => parseTarget('agents'), /target must look like/);
});

test('jump switches window and pane inside tmux', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-jump-'));
  const fakeTmux = path.join(dir, 'tmux');
  const log = path.join(dir, 'calls.log');
  await writeFile(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\n`, { mode: 0o755 });

  const oldTmux = process.env.TMUX;
  process.env.TMUX = '/tmp/tmux-client';
  try {
    await jumpToTarget(fakeTmux, 'agents:1.2');
  } finally {
    if (oldTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = oldTmux;
  }

  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
    'select-window -t agents:1',
    'select-pane -t agents:1.2',
    'switch-client -t agents:1',
  ]);
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
      lastStopReason: 'stop',
    },
    state: 'waiting',
    target: 'work:0.0',
  });
  const table = renderTable([row]);

  assert.equal(row.directory, 'SECRET_REPO');
  assert.equal(row.last, 'stop');
  assert.equal('sessionFile' in row, false);
  assert.doesNotMatch(JSON.stringify(row) + table, /\/Users\/dev/);
});

test('argument parser keeps watch cheap and explicit', () => {
  assert.deepEqual(parseArgs(['--json', '--watch', '--interval', '2', '--pi-root=/tmp/pi', '--tmux', 'tmux']), {
    action: 'snapshot',
    fullPaths: false,
    help: false,
    interval: 2,
    json: true,
    selector: undefined,
    target: undefined,
    piRoot: '/tmp/pi',
    tmux: 'tmux',
    watch: true,
  });

  assert.deepEqual(parseArgs(['jump', 'agents:1.0']), {
    action: 'jump',
    fullPaths: false,
    help: false,
    interval: 5,
    json: false,
    selector: undefined,
    target: 'agents:1.0',
    piRoot: `${process.env.HOME}/.pi/agent/sessions`,
    tmux: 'tmux',
    watch: false,
  });

  assert.equal(parseArgs(['next', 'working']).selector, 'working');
  assert.throws(() => parseArgs(['--interval', '0']), /positive integer/);
  assert.throws(() => parseArgs(['jump']), /jump requires/);
});

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
