import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import piTmuxHubSensor from '../extensions/pi-tmux-hub-sensor.js';
import {
  classifyPane,
  hubSelectionIndex,
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
  renderHub,
  renderTable,
  snapshot,
  toggleSidebar,
  writeRegistryEntry,
} from '../src/hub.js';
import { parseSpawnMarkers, slugify, worktreePathFor } from '../src/worktree.js';

const exec = promisify(execFile);

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

test('worktree helpers keep names and markers boring', () => {
  assert.equal(slugify('Fix Parser!!'), 'fix-parser');
  assert.equal(slugify('../SECRET'), 'secret');
  assert.equal(worktreePathFor('/repo', 'fix-parser'), '/repo/.worktrees/fix-parser');
  assert.deepEqual(parseSpawnMarkers('1\n/repo\n/repo/.worktrees/fix-parser\nagent/fix-parser\n@42\n'), {
    branch: 'agent/fix-parser',
    fromRepo: '/repo',
    spawned: true,
    windowId: '@42',
    worktreePath: '/repo/.worktrees/fix-parser',
  });
});

test('package includes tmux plugin entrypoint', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const plugin = await readFile('pi-tmux-hub.tmux', 'utf8');

  assert.ok(packageJson.files.includes('pi-tmux-hub.tmux'));
  assert.match(plugin, /@pi_tmux_hub_key/);
  assert.match(plugin, /sidebar/);
});

test('tmux plugin registers sidebar binding without requiring real tmux', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-plugin-'));
  const fakeTmux = path.join(dir, 'tmux');
  const log = path.join(dir, 'tmux.log');
  await writeFile(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\nif [ "$1" = display-message ]; then printf 'h\\n'; fi\n`, { mode: 0o755 });

  await exec('bash', ['pi-tmux-hub.tmux'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  const calls = await readFile(log, 'utf8');

  assert.match(calls, /set -g @pi_tmux_hub_key h/);
  assert.match(calls, /bind h run-shell .*sidebar/);
  assert.doesNotMatch(calls, /@pi_tmux_hub_cmd/);
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

test('sidebar opens a marked tmux pane and restores focus', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-sidebar-'));
  const fakeTmux = path.join(dir, 'tmux');
  const log = path.join(dir, 'calls.log');
  await writeFile(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\nif [ "$1" = display-message ]; then printf '%s\\t%s\\t%s\\n' '@1' '%1' '/tmp/repo'; exit 0; fi\nif [ "$1" = list-panes ]; then printf '%s\\t%s\\n' '%1' ''; exit 0; fi\nif [ "$1" = split-window ]; then printf '%s\\n' '%9'; exit 0; fi\n`, { mode: 0o755 });

  const result = await toggleSidebar({ interval: 2, piRoot: '/tmp/pi', registryDir: '/tmp/registry', tmux: fakeTmux });
  const calls = (await readFile(log, 'utf8')).trim().split('\n');

  assert.deepEqual(result, { action: 'opened', paneId: '%9' });
  assert.ok(calls.some((line) => line.startsWith('split-window -h -l 35% -t @1 -c /tmp/repo -P -F #{pane_id} ')));
  assert.ok(calls.some((line) => line.includes("'hub'")));
  assert.ok(calls.includes('set-option -p -t %9 @pi_tmux_hub_role sidebar'));
  assert.ok(calls.includes('select-pane -t %1'));
});

test('sidebar toggles off an existing sidebar pane', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-sidebar-'));
  const fakeTmux = path.join(dir, 'tmux');
  const log = path.join(dir, 'calls.log');
  await writeFile(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\nif [ "$1" = display-message ]; then printf '%s\\t%s\\t%s\\n' '@1' '%1' '/tmp/repo'; exit 0; fi\nif [ "$1" = list-panes ]; then printf '%s\\t%s\\n' '%9' 'sidebar'; exit 0; fi\n`, { mode: 0o755 });

  const result = await toggleSidebar({ tmux: fakeTmux });
  const calls = (await readFile(log, 'utf8')).trim().split('\n');

  assert.deepEqual(result, { action: 'closed', paneId: '%9' });
  assert.ok(calls.includes('kill-pane -t %9'));
  assert.equal(calls.some((line) => line.startsWith('split-window ')), false);
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

test('interactive hub renders selection without leaking paths', () => {
  const hub = renderHub([
    {
      adapter: 'pi',
      command: 'node',
      cwd: '/Users/dev/SECRET_HUB_REPO',
      cwdName: 'SECRET_HUB_REPO',
      pi: {
        file: '/Users/dev/.pi/agent/sessions/SECRET/session.jsonl',
        name: 'Hub task',
        registryUpdatedAt: new Date(),
        registryState: 'working',
      },
      state: 'working',
      target: 'work:0.0',
    },
  ], 0);

  assert.match(hub, /›\s+working\s+work:0\.0/);
  assert.match(hub, /enter jump/);
  assert.doesNotMatch(hub, /\/Users\/dev/);
  assert.equal(hubSelectionIndex(-1, 3), 2);
  assert.equal(hubSelectionIndex(3, 3), 0);
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

  const hub = parseArgs(['hub', '--interval', '1']);
  assert.equal(hub.action, 'hub');
  assert.equal(hub.interval, 1);
  assert.equal(parseArgs(['sidebar']).action, 'sidebar');

  const spawn = parseArgs(['spawn', 'fix', 'parser', '--command', 'sleep 60', '--target', 'work:0.0']);
  assert.equal(spawn.action, 'spawn');
  assert.equal(spawn.name, 'fix parser');
  assert.equal(spawn.command, 'sleep 60');
  assert.equal(spawn.target, 'work:0.0');

  const close = parseArgs(['close', 'work:0.0', '--delete-worktree', '--force']);
  assert.equal(close.action, 'close');
  assert.equal(close.target, 'work:0.0');
  assert.equal(close.deleteWorktree, true);
  assert.equal(close.force, true);

  assert.equal(parseArgs(['next', 'working']).selector, 'working');
  assert.throws(() => parseArgs(['hub', '--json']), /interactive/);
  assert.throws(() => parseArgs(['sidebar', '--json']), /interactive/);
  assert.throws(() => parseArgs(['--interval', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--state', 'bad']), /unknown registry state/);
  assert.throws(() => parseArgs(['spawn']), /spawn requires/);
  assert.throws(() => parseArgs(['jump']), /jump requires/);
});

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
