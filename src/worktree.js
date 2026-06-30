import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const DEFAULT_BRANCH_PREFIX = 'agent/';
const DEFAULT_WORKTREE_DIR = '.worktrees';
const SPAWNED_OPTION = '@pi_tmux_hub_spawned';
const SPAWNED_FROM_OPTION = '@pi_tmux_hub_spawned_from';
const SPAWNED_WORKTREE_OPTION = '@pi_tmux_hub_spawned_worktree';
const SPAWNED_BRANCH_OPTION = '@pi_tmux_hub_spawned_branch';
const MARKER_FORMAT = [
  `#{${SPAWNED_OPTION}}`,
  `#{${SPAWNED_FROM_OPTION}}`,
  `#{${SPAWNED_WORKTREE_OPTION}}`,
  `#{${SPAWNED_BRANCH_OPTION}}`,
  '#{window_id}',
].join('\n');

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function worktreePathFor(repoRoot, slug) {
  return path.join(repoRoot, DEFAULT_WORKTREE_DIR, slug);
}

export function parseSpawnMarkers(raw) {
  const [spawned, fromRepo = '', worktreePath = '', branch = '', windowId = ''] = String(raw || '').split(/\r?\n/);
  return { spawned: spawned === '1', fromRepo, worktreePath, branch, windowId };
}

export async function spawnWorktree(options = {}) {
  try {
    return await spawnWorktreeUnsafe(options);
  } catch (error) {
    if (error?.safe) throw error;
    throw new Error('spawn failed');
  }
}

async function spawnWorktreeUnsafe(options) {
  const tmux = options.tmux || 'tmux';
  const git = options.git || 'git';
  const name = options.name || '';
  const current = options.target ? await currentPane(tmux, options.target) : await currentPane(tmux);
  const repoRoot = await gitRoot(git, current.cwd);
  const slug = await uniqueSlug(git, repoRoot, name);
  const branch = `${DEFAULT_BRANCH_PREFIX}${slug}`;
  const worktreePath = worktreePathFor(repoRoot, slug);

  await gitExec(git, ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath]);
  let createdWindow;
  try {
    const created = parseCreatedWindow(await tmuxOutput(tmux, ['new-window', '-d', '-P', '-F', '#{pane_id}\t#{window_id}', '-t', `${current.session}:`, '-n', slug, '-c', worktreePath]));
    createdWindow = created.windowId;
    for (const [key, value] of [
      [SPAWNED_OPTION, '1'],
      [SPAWNED_FROM_OPTION, repoRoot],
      [SPAWNED_WORKTREE_OPTION, worktreePath],
      [SPAWNED_BRANCH_OPTION, branch],
    ]) await tmuxExec(tmux, ['set-option', '-w', '-t', created.windowId, key, value]);
    await tmuxExec(tmux, ['send-keys', '-t', created.paneId, options.command || 'pi', 'C-m']);
    return { branch, paneId: created.paneId, slug, windowId: created.windowId, worktreePath };
  } catch (error) {
    await rollbackSpawn({ branch, git, repoRoot, tmux, windowId: createdWindow, worktreePath });
    throw error;
  }
}

async function uniqueSlug(git, repoRoot, name) {
  const base = slugify(name);
  if (!base) throw safeError('spawn requires a name');
  for (let index = 1; index <= 100; index += 1) {
    const slug = index === 1 ? base : `${base}-${index}`;
    const branch = `${DEFAULT_BRANCH_PREFIX}${slug}`;
    if (!(await branchExists(git, repoRoot, branch)) && !(await exists(worktreePathFor(repoRoot, slug)))) return slug;
  }
  throw safeError('no free worktree name found');
}

export async function closeWorktree(options = {}) {
  try {
    return await closeWorktreeUnsafe(options);
  } catch (error) {
    if (error?.safe) throw error;
    throw new Error('close failed');
  }
}

async function closeWorktreeUnsafe(options) {
  const tmux = options.tmux || 'tmux';
  const git = options.git || 'git';
  const markers = parseSpawnMarkers(await tmuxOutput(tmux, ['display-message', '-p', ...(options.target ? ['-t', options.target] : []), MARKER_FORMAT]));
  if (!markers.spawned || !markers.windowId) throw safeError('close requires a pi-tmux-hub spawned pane');

  if (options.deleteWorktree) {
    validateDeleteMarkers(markers);
    const worktreeExists = await exists(markers.worktreePath);
    const branchPresent = await branchExists(git, markers.fromRepo, markers.branch);
    if (worktreeExists && !options.force && !(await worktreeClean(git, markers.worktreePath))) throw safeError('worktree has uncommitted changes');
    if (branchPresent && !options.force && !(await branchMerged(git, markers.fromRepo, markers.branch))) throw safeError('branch has unmerged commits');
    if (worktreeExists) await gitExec(git, ['-C', markers.fromRepo, 'worktree', 'remove', ...(options.force ? ['--force'] : []), markers.worktreePath]);
    if (branchPresent) await gitExec(git, ['-C', markers.fromRepo, 'branch', options.force ? '-D' : '-d', markers.branch]);
  }

  await tmuxExec(tmux, ['kill-window', '-t', markers.windowId]);
  return { deleted: Boolean(options.deleteWorktree), windowId: markers.windowId };
}

function validateDeleteMarkers(markers) {
  if (!markers.fromRepo || !markers.worktreePath || !markers.branch) throw safeError('spawn markers are incomplete');
  if (!markers.branch.startsWith(DEFAULT_BRANCH_PREFIX)) throw safeError('spawned branch is not managed by pi-tmux-hub');
  const root = path.resolve(markers.fromRepo, DEFAULT_WORKTREE_DIR);
  const worktree = path.resolve(markers.worktreePath);
  if (!worktree.startsWith(`${root}${path.sep}`)) throw safeError('spawned worktree is outside the managed directory');
  if (markers.branch !== `${DEFAULT_BRANCH_PREFIX}${path.basename(worktree)}`) throw safeError('spawn markers do not match');
}

async function currentPane(tmux, target) {
  const out = await tmuxOutput(tmux, ['display-message', '-p', ...(target ? ['-t', target] : []), '#{session_name}\t#{pane_current_path}']);
  const [session, cwd] = out.trimEnd().split('\t');
  if (!session || !cwd) throw new Error('missing tmux pane');
  return { cwd, session };
}

async function gitRoot(git, cwd) {
  try {
    return (await gitOutput(git, ['-C', cwd, 'rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw safeError('spawn requires a git repository');
  }
}

function parseCreatedWindow(stdout) {
  const [paneId, windowId] = stdout.trimEnd().split('\t');
  if (!paneId || !windowId) throw new Error('missing tmux window');
  return { paneId, windowId };
}

async function rollbackSpawn({ branch, git, repoRoot, tmux, windowId, worktreePath }) {
  if (windowId) await tmuxExec(tmux, ['kill-window', '-t', windowId]).catch(() => undefined);
  await gitExec(git, ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
  await gitExec(git, ['-C', repoRoot, 'branch', '-D', branch]).catch(() => undefined);
}

async function branchExists(git, repoRoot, branch) {
  try {
    await exec(git, ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function worktreeClean(git, worktreePath) {
  return (await gitOutput(git, ['-C', worktreePath, 'status', '--porcelain'])).trim() === '';
}

async function branchMerged(git, repoRoot, branch) {
  try {
    await exec(git, ['-C', repoRoot, 'merge-base', '--is-ancestor', branch, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(git, args) {
  const { stdout } = await exec(git, args);
  return stdout;
}

async function gitExec(git, args) {
  await exec(git, args);
}

async function tmuxOutput(tmux, args) {
  const { stdout } = await exec(tmux, args);
  return stdout;
}

async function tmuxExec(tmux, args) {
  await exec(tmux, args);
}

function safeError(message) {
  const error = new Error(message);
  error.safe = true;
  return error;
}
