import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { piSessionDirNames } from '../src/hub.js';

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
