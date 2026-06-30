import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import piTmuxHubSensor from '../extensions/pi-tmux-hub-sensor.js';
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
  readRegistry,
  registerCurrentPane,
  renderTable,
  snapshot,
  writeRegistryEntry,
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

test('registry maps two Pi sessions in the same cwd to distinct panes', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-registry-'));
  const cwd = path.join(tmp, 'repo');
  const piRoot = path.join(tmp, 'pi-sessions');
  const registryDir = path.join(tmp, 'registry');
  const tmux = path.join(tmp, 'tmux');
  const sessionDir = path.join(piRoot, piSessionDirNames(cwd)[0]);
  await mkdir(cwd);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(tmux, `#!/bin/sh\nprintf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' work 0 0 %1 node ${shellQuote(cwd)} pi\nprintf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' work 0 1 %2 node ${shellQuote(cwd)} pi\n`, { mode: 0o755 });

  const firstSession = path.join(sessionDir, 'first.jsonl');
  const secondSession = path.join(sessionDir, 'second.jsonl');
  await writeFile(firstSession, [
    JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'session_info', name: 'First task' }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', stopReason: 'stop', content: 'PROMPT_SENTINEL' } }),
  ].join('\n'));
  await writeFile(secondSession, [
    JSON.stringify({ type: 'session', id: 's2', timestamp: '2026-01-01T00:00:00.000Z', cwd }),
    JSON.stringify({ type: 'session_info', name: 'Second task' }),
    JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', stopReason: 'stop', content: 'CODE_SENTINEL' } }),
  ].join('\n'));

  await writeRegistryEntry({ cwd, paneId: '%1', pid: process.pid, sessionFile: firstSession, state: 'working', last: 'agent_start' }, registryDir);
  await writeRegistryEntry({ cwd, paneId: '%2', pid: process.pid, sessionFile: secondSession, state: 'waiting', last: 'stop' }, registryDir);

  const rows = await snapshot({ piRoot, registryDir, tmux });

  assert.equal(rows.find((row) => row.paneId === '%1').pi.name, 'First task');
  assert.equal(rows.find((row) => row.paneId === '%1').state, 'working');
  assert.equal(rows.find((row) => row.paneId === '%2').pi.name, 'Second task');
  assert.equal(rows.find((row) => row.paneId === '%2').state, 'waiting');
  assert.doesNotMatch(JSON.stringify(rows.map((row) => publicRow(row))), /PROMPT_SENTINEL|CODE_SENTINEL/);
});

test('register command writes privacy-safe pane registry', async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-register-'));

  await registerCurrentPane({ cwd: '/SECRET_CWD_SENTINEL', last: 'tool_call', lastToolName: 'bash', paneId: '%7', pid: process.pid, registryDir, state: 'working' });
  const [entry] = await readRegistry(registryDir);

  assert.equal(entry.paneId, '%7');
  assert.equal(entry.state, 'working');
  assert.equal(entry.lastToolName, 'bash');
  assert.equal(JSON.stringify(entry).includes('PROMPT_SENTINEL'), false);
});

test('register errors do not leak registry paths', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-SECRET_REGISTRY-'));
  const blocker = path.join(tmp, 'SECRET_REGISTRY_SENTINEL');
  await writeFile(blocker, 'not a dir');

  await assert.rejects(
    registerCurrentPane({ paneId: '%8', registryDir: path.join(blocker, 'child'), state: 'working' }),
    (error) => {
      assert.match(error.message, /registry write failed/);
      assert.doesNotMatch(error.message, /SECRET_REGISTRY_SENTINEL/);
      return true;
    },
  );
});

test('Pi sensor writes live state without prompt content', async () => {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-sensor-'));
  const oldPane = process.env.TMUX_PANE;
  const oldRegistry = process.env.PI_TMUX_HUB_REGISTRY_DIR;
  process.env.TMUX_PANE = '%9';
  process.env.PI_TMUX_HUB_REGISTRY_DIR = registryDir;
  const handlers = new Map();
  const ctx = {
    cwd: '/SECRET_SENSOR_CWD',
    sessionManager: { getSessionFile: () => '/SECRET_SENSOR_SESSION/session.jsonl' },
  };

  try {
    piTmuxHubSensor({ on: (event, handler) => handlers.set(event, handler) });
    await handlers.get('agent_start')({}, ctx);
    assert.equal((await readRegistry(registryDir))[0].state, 'working');

    await handlers.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'error', content: 'PROMPT_SENTINEL' }] }, ctx);
    const [entry] = await readRegistry(registryDir);
    assert.equal(entry.state, 'error');
    assert.equal(entry.last, 'error');
    assert.doesNotMatch(JSON.stringify(entry), /PROMPT_SENTINEL/);
  } finally {
    if (oldPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = oldPane;
    if (oldRegistry === undefined) delete process.env.PI_TMUX_HUB_REGISTRY_DIR;
    else process.env.PI_TMUX_HUB_REGISTRY_DIR = oldRegistry;
  }
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
  const watch = parseArgs(['--json', '--watch', '--interval', '2', '--pi-root=/tmp/pi', '--tmux', 'tmux']);
  assert.equal(watch.action, 'snapshot');
  assert.equal(watch.json, true);
  assert.equal(watch.watch, true);
  assert.equal(watch.interval, 2);
  assert.equal(watch.piRoot, '/tmp/pi');

  const jump = parseArgs(['jump', 'agents:1.0']);
  assert.equal(jump.action, 'jump');
  assert.equal(jump.target, 'agents:1.0');
  assert.equal(jump.piRoot, `${process.env.HOME}/.pi/agent/sessions`);

  const register = parseArgs(['register', '--pane-id', '%1', '--state', 'waiting', '--registry-dir=/tmp/registry']);
  assert.equal(register.action, 'register');
  assert.equal(register.paneId, '%1');
  assert.equal(register.state, 'waiting');
  assert.equal(register.registryDir, '/tmp/registry');

  assert.equal(parseArgs(['next', 'working']).selector, 'working');
  assert.throws(() => parseArgs(['--interval', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--state', 'bad']), /unknown registry state/);
  assert.throws(() => parseArgs(['jump']), /jump requires/);
});

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
