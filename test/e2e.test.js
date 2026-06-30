import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { piSessionDirNames, writeRegistryEntry } from '../src/hub.js';

const exec = promisify(execFile);
const cli = path.resolve('bin/pi-tmux-hub.js');

async function hasTmux() {
  try {
    await exec('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

test('end-to-end: real tmux panes plus Pi JSONL adapter', async (t) => {
  if (!(await hasTmux())) {
    t.skip('tmux is not installed');
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-e2e-'));
  const socket = `pi-tmux-hub-${process.pid}-${Date.now()}`;
  const tmuxWrap = path.join(tmp, 'tmuxwrap');
  const piRoot = path.join(tmp, 'pi-sessions');
  const workDir = path.join(tmp, 'work-repo');
  const emptyDir = path.join(tmp, 'empty-repo');

  await mkdir(piRoot);
  await mkdir(workDir);
  await mkdir(emptyDir);
  await writeFile(tmuxWrap, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o755 });

  try {
    await exec('tmux', ['-L', socket, 'new-session', '-d', '-s', 'hubtest', '-c', workDir, 'sleep 60']);
    await exec('tmux', ['-L', socket, 'new-window', '-d', '-t', 'hubtest', '-n', 'empty', '-c', emptyDir, 'sleep 60']);

    const { stdout: panePaths } = await exec('tmux', ['-L', socket, 'list-panes', '-a', '-F', '#{pane_current_path}']);
    const actualWorkDir = panePaths.split('\n').find((line) => line.endsWith('work-repo'));
    assert.ok(actualWorkDir);

    const sessionDir = path.join(piRoot, piSessionDirNames(actualWorkDir)[0]);
    await mkdir(sessionDir);
    await writeFile(path.join(sessionDir, 'session.jsonl'), [
      JSON.stringify({ type: 'session', version: 3, id: 'session-e2e', timestamp: '2026-01-01T00:00:00.000Z', cwd: actualWorkDir }),
      JSON.stringify({ type: 'session_info', name: 'E2E task', timestamp: '2026-01-01T00:00:01.000Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'PROMPT_SENTINEL_DO_NOT_PRINT' } }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', stopReason: 'stop', content: 'CODE_SENTINEL_DO_NOT_PRINT' } }),
    ].join('\n'));

    const { stdout: text } = await exec(process.execPath, [cli, '--tmux', tmuxWrap, '--pi-root', piRoot]);
    assert.match(text, /waiting/);
    assert.match(text, /E2E task/);
    assert.match(text, /tmux/);
    assert.doesNotMatch(text, new RegExp(escapeRegExp(actualWorkDir)));
    assert.doesNotMatch(text, new RegExp(escapeRegExp(piRoot)));
    assert.doesNotMatch(text, /PROMPT_SENTINEL|CODE_SENTINEL/);

    const { stdout: json } = await exec(process.execPath, [cli, '--tmux', tmuxWrap, '--pi-root', piRoot, '--json']);
    const rows = JSON.parse(json);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.state === 'waiting' && row.name === 'E2E task'));
    assert.ok(rows.some((row) => row.state === 'tmux'));
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(escapeRegExp(actualWorkDir)));

    const { stdout: fullJson } = await exec(process.execPath, [cli, '--tmux', tmuxWrap, '--pi-root', piRoot, '--json', '--full-paths']);
    const fullRows = JSON.parse(fullJson);
    const piRow = fullRows.find((row) => row.name === 'E2E task');
    assert.ok(piRow.directory.includes(actualWorkDir));
    assert.ok(piRow.sessionFile.endsWith('session.jsonl'));
  } finally {
    await exec('tmux', ['-L', socket, 'kill-server']).catch(() => undefined);
    await rm(tmp, { force: true, recursive: true });
  }
});

test('end-to-end: registry disambiguates two Pi sessions in one cwd', async (t) => {
  if (!(await hasTmux())) {
    t.skip('tmux is not installed');
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-registry-e2e-'));
  const socket = `pi-tmux-hub-registry-${process.pid}-${Date.now()}`;
  const tmuxWrap = path.join(tmp, 'tmuxwrap');
  const piRoot = path.join(tmp, 'pi-sessions');
  const registryDir = path.join(tmp, 'registry');
  const workDir = path.join(tmp, 'work-repo');

  await mkdir(piRoot);
  await mkdir(workDir);
  await writeFile(tmuxWrap, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o755 });

  try {
    await exec('tmux', ['-L', socket, 'new-session', '-d', '-s', 'hubtest', '-c', workDir, 'sleep 60']);
    await exec('tmux', ['-L', socket, 'split-window', '-d', '-t', 'hubtest:0', '-c', workDir, 'sleep 60']);

    const { stdout: paneOutput } = await exec('tmux', ['-L', socket, 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_path}']);
    const panes = paneOutput.trim().split('\n').map((line) => {
      const [paneId, cwd] = line.split('\t');
      return { paneId, cwd };
    });
    assert.equal(panes.length, 2);
    const actualWorkDir = panes[0].cwd;
    assert.ok(actualWorkDir.endsWith('work-repo'));

    const sessionDir = path.join(piRoot, piSessionDirNames(actualWorkDir)[0]);
    await mkdir(sessionDir);
    const firstSession = path.join(sessionDir, 'first.jsonl');
    const secondSession = path.join(sessionDir, 'second.jsonl');
    await writeFile(firstSession, [
      JSON.stringify({ type: 'session', version: 3, id: 'session-first', timestamp: '2026-01-01T00:00:00.000Z', cwd: actualWorkDir }),
      JSON.stringify({ type: 'session_info', name: 'First registry task', timestamp: '2026-01-01T00:00:01.000Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', stopReason: 'stop', content: 'PROMPT_SENTINEL_DO_NOT_PRINT' } }),
    ].join('\n'));
    await writeFile(secondSession, [
      JSON.stringify({ type: 'session', version: 3, id: 'session-second', timestamp: '2026-01-01T00:00:00.000Z', cwd: actualWorkDir }),
      JSON.stringify({ type: 'session_info', name: 'Second registry task', timestamp: '2026-01-01T00:00:01.000Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', stopReason: 'stop', content: 'CODE_SENTINEL_DO_NOT_PRINT' } }),
    ].join('\n'));

    await writeRegistryEntry({ cwd: actualWorkDir, last: 'agent_start', paneId: panes[0].paneId, pid: process.pid, sessionFile: firstSession, state: 'working' }, registryDir);
    await writeRegistryEntry({ cwd: actualWorkDir, last: 'stop', paneId: panes[1].paneId, pid: process.pid, sessionFile: secondSession, state: 'waiting' }, registryDir);

    const { stdout: json } = await exec(process.execPath, [cli, '--tmux', tmuxWrap, '--pi-root', piRoot, '--registry-dir', registryDir, '--json']);
    const rows = JSON.parse(json);

    assert.ok(rows.some((row) => row.name === 'First registry task' && row.state === 'working'));
    assert.ok(rows.some((row) => row.name === 'Second registry task' && row.state === 'waiting'));
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(escapeRegExp(actualWorkDir)));
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(escapeRegExp(registryDir)));
    assert.doesNotMatch(JSON.stringify(rows), /PROMPT_SENTINEL|CODE_SENTINEL/);
  } finally {
    await exec('tmux', ['-L', socket, 'kill-server']).catch(() => undefined);
    await rm(tmp, { force: true, recursive: true });
  }
});

test('end-to-end: sidebar toggles a marked pane and restores focus', async (t) => {
  if (!(await hasTmux())) {
    t.skip('tmux is not installed');
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-sidebar-e2e-'));
  const socket = `pi-tmux-hub-sidebar-${process.pid}-${Date.now()}`;
  const tmuxWrap = path.join(tmp, 'tmuxwrap');
  const workDir = path.join(tmp, 'work-repo');

  await mkdir(workDir);
  await writeFile(tmuxWrap, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o755 });

  try {
    await exec('tmux', ['-L', socket, 'new-session', '-d', '-s', 'hubtest', '-c', workDir]);
    const { stdout: paneId } = await exec('tmux', ['-L', socket, 'display-message', '-p', '-t', 'hubtest:0.0', '#{pane_id}']);
    const originalPane = paneId.trim();
    const command = `${shellQuote(process.execPath)} ${shellQuote(cli)} sidebar --tmux ${shellQuote(tmuxWrap)} --interval 1`;

    await exec('tmux', ['-L', socket, 'send-keys', '-t', originalPane, command, 'C-m']);
    await waitFor(async () => {
      const rows = await paneRows(socket);
      return rows.length === 2 && rows.some((row) => row.role === 'sidebar') && rows.some((row) => row.paneId === originalPane && row.active === '1' && row.role !== 'sidebar');
    });

    await exec('tmux', ['-L', socket, 'send-keys', '-t', originalPane, command, 'C-m']);
    await waitFor(async () => {
      const rows = await paneRows(socket);
      return rows.length === 1 && rows[0].paneId === originalPane && rows[0].role !== 'sidebar';
    });
  } finally {
    await exec('tmux', ['-L', socket, 'kill-server']).catch(() => undefined);
    await rm(tmp, { force: true, recursive: true });
  }
});

test('end-to-end: tmux plugin source-file binds sidebar', async (t) => {
  if (!(await hasTmux())) {
    t.skip('tmux is not installed');
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-plugin-e2e-'));
  const socket = `pi-tmux-hub-plugin-${process.pid}-${Date.now()}`;

  try {
    await exec('tmux', ['-L', socket, 'new-session', '-d', '-s', 'hubtest', 'sleep 60']);
    await exec('tmux', ['-L', socket, 'source-file', path.resolve('pi-tmux-hub.tmux')]);
    await waitFor(async () => {
      const { stdout } = await exec('tmux', ['-L', socket, 'list-keys', '-T', 'prefix']);
      return stdout.includes('bind-key') && stdout.includes('sidebar');
    });
  } finally {
    await exec('tmux', ['-L', socket, 'kill-server']).catch(() => undefined);
    await rm(tmp, { force: true, recursive: true });
  }
});

test('end-to-end: spawn creates and close deletes a managed worktree window', async (t) => {
  if (!(await hasTmux())) {
    t.skip('tmux is not installed');
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-worktree-e2e-'));
  const socket = `pi-tmux-hub-worktree-${process.pid}-${Date.now()}`;
  const tmuxWrap = path.join(tmp, 'tmuxwrap');
  const repo = path.join(tmp, 'repo');

  await mkdir(repo);
  await writeFile(tmuxWrap, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o755 });
  await exec('git', ['-C', repo, 'init']);
  await writeFile(path.join(repo, 'README.md'), 'test\n');
  await exec('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'add', 'README.md']);
  await exec('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init']);

  try {
    await exec('tmux', ['-L', socket, 'new-session', '-d', '-s', 'hubtest', '-c', repo, 'sleep 60']);
    await exec(process.execPath, [cli, '--tmux', tmuxWrap, '--target', 'hubtest:0.0', 'spawn', 'Fix Parser', '--command', 'cd /; sleep 60']);

    const spawned = await waitFor(async () => {
      const rows = await worktreeRows(socket);
      return rows.find((row) => row.branch === 'agent/fix-parser');
    });
    assert.equal(spawned.name, 'fix-parser');
    assert.ok(spawned.worktree.endsWith('/.worktrees/fix-parser'));
    await exec('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/agent/fix-parser']);

    await writeFile(path.join(spawned.worktree, 'dirty.txt'), 'dirty\n');
    await assert.rejects(
      exec(process.execPath, [cli, '--tmux', tmuxWrap, '--target', spawned.paneId, 'close', '--delete-worktree']),
      (error) => {
        assert.match(error.stderr, /worktree has uncommitted changes/);
        assert.doesNotMatch(error.stderr, new RegExp(escapeRegExp(spawned.worktree)));
        return true;
      },
    );
    assert.ok((await worktreeRows(socket)).some((row) => row.branch === 'agent/fix-parser'));

    await exec('git', ['-C', spawned.worktree, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'add', 'dirty.txt']);
    await exec('git', ['-C', spawned.worktree, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'agent change']);
    await assert.rejects(
      exec(process.execPath, [cli, '--tmux', tmuxWrap, '--target', spawned.paneId, 'close', '--delete-worktree']),
      (error) => {
        assert.match(error.stderr, /branch has unmerged commits/);
        assert.doesNotMatch(error.stderr, new RegExp(escapeRegExp(spawned.worktree)));
        return true;
      },
    );
    assert.ok((await worktreeRows(socket)).some((row) => row.branch === 'agent/fix-parser'));

    await exec(process.execPath, [cli, '--tmux', tmuxWrap, '--target', spawned.paneId, 'close', '--delete-worktree', '--force']);
    await waitFor(async () => !(await worktreeRows(socket)).some((row) => row.branch === 'agent/fix-parser'));
    await assert.rejects(exec('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/agent/fix-parser']));
    const { stdout: worktrees } = await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
    assert.doesNotMatch(worktrees, /\.worktrees\/fix-parser/);
  } finally {
    await exec('tmux', ['-L', socket, 'kill-server']).catch(() => undefined);
    await rm(tmp, { force: true, recursive: true });
  }
});

test('end-to-end: close refuses unowned panes', async (t) => {
  if (!(await hasTmux())) {
    t.skip('tmux is not installed');
    return;
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'pi-tmux-hub-close-e2e-'));
  const socket = `pi-tmux-hub-close-${process.pid}-${Date.now()}`;
  const tmuxWrap = path.join(tmp, 'tmuxwrap');
  await writeFile(tmuxWrap, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o755 });

  try {
    await exec('tmux', ['-L', socket, 'new-session', '-d', '-s', 'hubtest', 'sleep 60']);
    await assert.rejects(
      exec(process.execPath, [cli, '--tmux', tmuxWrap, '--target', 'hubtest:0.0', 'close']),
      (error) => {
        assert.match(error.stderr, /close requires a pi-tmux-hub spawned pane/);
        return true;
      },
    );
    await exec('tmux', ['-L', socket, 'set-option', '-w', '-t', 'hubtest:0', '@pi_tmux_hub_spawned', '1']);
    await exec('tmux', ['-L', socket, 'set-option', '-w', '-t', 'hubtest:0', '@pi_tmux_hub_spawned_from', tmp]);
    await exec('tmux', ['-L', socket, 'set-option', '-w', '-t', 'hubtest:0', '@pi_tmux_hub_spawned_worktree', path.join(tmp, '.worktrees', 'fix-parser')]);
    await exec('tmux', ['-L', socket, 'set-option', '-w', '-t', 'hubtest:0', '@pi_tmux_hub_spawned_branch', 'agent/other']);
    await assert.rejects(
      exec(process.execPath, [cli, '--tmux', tmuxWrap, '--target', 'hubtest:0.0', 'close', '--delete-worktree', '--force']),
      (error) => {
        assert.match(error.stderr, /spawn markers do not match/);
        assert.doesNotMatch(error.stderr, new RegExp(escapeRegExp(tmp)));
        return true;
      },
    );

    const { stdout } = await exec('tmux', ['-L', socket, 'list-windows', '-F', '#{window_id}']);
    assert.equal(stdout.trim().split('\n').filter(Boolean).length, 1);
  } finally {
    await exec('tmux', ['-L', socket, 'kill-server']).catch(() => undefined);
    await rm(tmp, { force: true, recursive: true });
  }
});

test('missing tmux command fails without echoing the configured path', async () => {
  await assert.rejects(
    exec(process.execPath, [cli, '--tmux', '/SECRET/TMUX_SENTINEL']),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /tmux list-panes failed/);
      assert.doesNotMatch(error.stderr, /SECRET|TMUX_SENTINEL/);
      return true;
    },
  );
});

async function worktreeRows(socket) {
  const { stdout } = await exec('tmux', ['-L', socket, 'list-panes', '-a', '-F', '#{window_name}\t#{pane_id}\t#{@pi_tmux_hub_spawned_branch}\t#{@pi_tmux_hub_spawned_worktree}']);
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [name, paneId, branch, worktree] = line.split('\t');
    return { branch, name, paneId, worktree };
  });
}

async function paneRows(socket) {
  const { stdout } = await exec('tmux', ['-L', socket, 'list-panes', '-a', '-F', '#{pane_id}\t#{@pi_tmux_hub_role}\t#{pane_active}']);
  return stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [paneId, role, active] = line.split('\t');
    return { active, paneId, role };
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('condition timed out');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
