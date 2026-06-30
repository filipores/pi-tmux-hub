import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { closeWorktree, spawnWorktree } from './worktree.js';

const exec = promisify(execFile);
const DEFAULT_PI_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const DEFAULT_REGISTRY_DIR = path.join(os.homedir(), '.pi-tmux-hub', 'registry');
const SIDEBAR_ROLE_OPTION = '@pi_tmux_hub_role';
const SIDEBAR_ROLE = 'sidebar';
const SIDEBAR_WIDTH = '35%';
const TMUX_FORMAT = [
  '#{session_name}',
  '#{window_index}',
  '#{pane_index}',
  '#{pane_id}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{pane_title}',
].join('\t');
const SHELLS = new Set(['bash', 'fish', 'sh', 'tmux', 'zsh']);

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }

  if (options.action === 'jump') {
    await jumpToTarget(options.tmux, options.target);
    return;
  }

  if (options.action === 'register') {
    await registerCurrentPane(options);
    return;
  }

  if (options.action === 'hub') {
    await runHub(options);
    return;
  }

  if (options.action === 'sidebar') {
    await toggleSidebar(options);
    return;
  }

  if (options.action === 'spawn') {
    const result = await spawnWorktree(options);
    console.log(`spawned ${result.branch}`);
    return;
  }

  if (options.action === 'close') {
    const result = await closeWorktree(options);
    console.log(result.deleted ? 'closed and deleted' : 'closed');
    return;
  }

  if (options.action === 'next') {
    await jumpToNext(options);
    return;
  }

  if (options.watch) {
    for (;;) {
      await printSnapshot(options);
      await sleep(options.interval * 1000);
    }
  }

  await printSnapshot(options);
}

export function parseArgs(argv) {
  const options = {
    action: 'snapshot',
    fullPaths: false,
    help: false,
    interval: 5,
    json: false,
    last: undefined,
    lastToolName: undefined,
    paneId: process.env.TMUX_PANE,
    command: 'pi',
    deleteWorktree: false,
    force: false,
    nameParts: [],
    pid: process.pid,
    registryDir: defaultRegistryDir(),
    selector: undefined,
    sessionFile: undefined,
    state: 'working',
    target: undefined,
    cwd: process.cwd(),
    piRoot: DEFAULT_PI_ROOT,
    tmux: 'tmux',
    watch: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === 'close' || arg === 'hub' || arg === 'jump' || arg === 'next' || arg === 'register' || arg === 'sidebar' || arg === 'spawn') && options.action === 'snapshot') {
      options.action = arg;
      continue;
    }

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--full-paths') options.fullPaths = true;
    else if (arg === '--watch') options.watch = true;
    else if (arg === '--delete-worktree') options.deleteWorktree = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--command') options.command = requireValue(argv, ++index, '--command');
    else if (arg.startsWith('--command=')) options.command = requireNonEmpty(arg.slice('--command='.length), '--command');
    else if (arg === '--target') options.target = requireValue(argv, ++index, '--target');
    else if (arg.startsWith('--target=')) options.target = requireNonEmpty(arg.slice('--target='.length), '--target');
    else if (arg === '--pi-root') options.piRoot = requireValue(argv, ++index, '--pi-root');
    else if (arg.startsWith('--pi-root=')) options.piRoot = requireNonEmpty(arg.slice('--pi-root='.length), '--pi-root');
    else if (arg === '--registry-dir') options.registryDir = requireValue(argv, ++index, '--registry-dir');
    else if (arg.startsWith('--registry-dir=')) options.registryDir = requireNonEmpty(arg.slice('--registry-dir='.length), '--registry-dir');
    else if (arg === '--state') options.state = normalizeRegistryState(requireValue(argv, ++index, '--state'));
    else if (arg.startsWith('--state=')) options.state = normalizeRegistryState(arg.slice('--state='.length));
    else if (arg === '--session-file') options.sessionFile = requireValue(argv, ++index, '--session-file');
    else if (arg.startsWith('--session-file=')) options.sessionFile = requireNonEmpty(arg.slice('--session-file='.length), '--session-file');
    else if (arg === '--pane-id') options.paneId = requireValue(argv, ++index, '--pane-id');
    else if (arg.startsWith('--pane-id=')) options.paneId = requireNonEmpty(arg.slice('--pane-id='.length), '--pane-id');
    else if (arg === '--cwd') options.cwd = requireValue(argv, ++index, '--cwd');
    else if (arg.startsWith('--cwd=')) options.cwd = requireNonEmpty(arg.slice('--cwd='.length), '--cwd');
    else if (arg === '--last') options.last = requireValue(argv, ++index, '--last');
    else if (arg.startsWith('--last=')) options.last = requireNonEmpty(arg.slice('--last='.length), '--last');
    else if (arg === '--tool') options.lastToolName = requireValue(argv, ++index, '--tool');
    else if (arg.startsWith('--tool=')) options.lastToolName = requireNonEmpty(arg.slice('--tool='.length), '--tool');
    else if (arg === '--pid') options.pid = parsePid(requireValue(argv, ++index, '--pid'));
    else if (arg.startsWith('--pid=')) options.pid = parsePid(arg.slice('--pid='.length));
    else if (arg === '--tmux') options.tmux = requireValue(argv, ++index, '--tmux');
    else if (arg.startsWith('--tmux=')) options.tmux = requireNonEmpty(arg.slice('--tmux='.length), '--tmux');
    else if (arg === '--interval') options.interval = parseInterval(requireValue(argv, ++index, '--interval'));
    else if (arg.startsWith('--interval=')) options.interval = parseInterval(arg.slice('--interval='.length));
    else if (!arg.startsWith('-') && options.action === 'jump' && !options.target) options.target = arg;
    else if (!arg.startsWith('-') && options.action === 'next' && !options.selector) options.selector = arg;
    else if (!arg.startsWith('-') && options.action === 'close' && !options.target) options.target = arg;
    else if (!arg.startsWith('-') && options.action === 'spawn') options.nameParts.push(arg);
    else throw new Error(`unknown option: ${arg}`);
  }

  options.name = options.nameParts.join(' ');

  if (options.action === 'jump' && !options.target) throw new Error('jump requires a target like session:window.pane');
  if (options.action === 'register' && !options.paneId) throw new Error('register requires --pane-id or TMUX_PANE');
  if (options.action === 'hub' && options.json) throw new Error('hub is interactive; use snapshot --json instead');
  if (options.action === 'sidebar' && options.json) throw new Error('sidebar is interactive; use snapshot --json instead');
  if (options.action === 'spawn' && !options.name) throw new Error('spawn requires a name');
  if (options.action !== 'snapshot' && options.watch) throw new Error('--watch only works with snapshots');
  return options;
}

export async function snapshot(options = {}) {
  const resolved = { piRoot: DEFAULT_PI_ROOT, registryDir: defaultRegistryDir(), tmux: 'tmux', ...options };
  const panes = await listTmuxPanes(resolved.tmux);
  const registryByPane = await registryEntriesForPanes(panes, resolved.registryDir);
  const rows = await Promise.all(panes.map((pane) => enrichPane(pane, resolved.piRoot, registryByPane.get(pane.paneId))));
  return rows.sort((left, right) => left.target.localeCompare(right.target, undefined, { numeric: true }));
}

export async function jumpToNext(options = {}) {
  const rows = await snapshot(options);
  const row = firstMatch(rows, options.selector || 'attention');
  if (!row) throw new Error(`no pane matches ${options.selector || 'attention'}`);
  await jumpToTarget(options.tmux || 'tmux', row.target);
}

export async function runHub(options = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('hub requires an interactive terminal');

  let rows = [];
  let selected = 0;
  let status = '';
  let stopped = false;
  let refreshing = false;
  const previousRaw = stdin.isRaw;

  const refresh = async (nextStatus = status) => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      rows = await snapshot(options);
      status = nextStatus;
    } catch {
      rows = [];
      status = 'snapshot failed';
    } finally {
      selected = hubSelectionIndex(selected, rows.length);
      if (!stopped) stdout.write(`\x1b[H\x1b[2J${renderHub(rows, selected, options, status)}\n`);
      refreshing = false;
    }
  };

  let timer;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stdin.off('data', onKey);
    stdin.setRawMode(previousRaw);
    stdout.write('\x1b[?25h\x1b[?1049l');
    resolveDone();
  };
  const jump = async (row) => {
    if (!row) {
      await refresh('no matching pane');
      return;
    }
    try {
      await jumpToTarget(options.tmux || 'tmux', row.target);
      await refresh(`jumped ${row.target}`);
    } catch {
      await refresh('jump failed');
    }
  };
  const onKey = (data) => {
    const key = data.toString('utf8');
    if (key === '\u0003' || key === '\u001b' || key === 'q') stop();
    else if (key === 'j' || key === '\u001b[B') { selected = hubSelectionIndex(selected + 1, rows.length); void refresh(); }
    else if (key === 'k' || key === '\u001b[A') { selected = hubSelectionIndex(selected - 1, rows.length); void refresh(); }
    else if (key === 'r') void refresh('refreshed');
    else if (key === 'n') void jump(firstMatch(rows, 'attention'));
    else if (key === '\r' || key === '\n') void jump(rows[selected]);
  };

  stdout.write('\x1b[?1049h\x1b[?25l');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onKey);
  timer = setInterval(() => { void refresh(); }, options.interval * 1000);
  await refresh();
  return done;
}

export async function toggleSidebar(options = {}) {
  try {
    const tmux = options.tmux || 'tmux';
    const current = parseCurrentPane(await tmuxOutput(tmux, ['display-message', '-p', '#{window_id}\t#{pane_id}\t#{pane_current_path}']));
    const existing = findSidebarPane(await tmuxOutput(tmux, ['list-panes', '-t', current.windowId, '-F', `#{pane_id}\t#{${SIDEBAR_ROLE_OPTION}}`]));
    if (existing) {
      await tmuxExec(tmux, ['kill-pane', '-t', existing]);
      return { action: 'closed', paneId: existing };
    }

    const paneId = (await tmuxOutput(tmux, [
      'split-window',
      '-h',
      '-l',
      SIDEBAR_WIDTH,
      '-t',
      current.windowId,
      '-c',
      current.cwd || process.cwd(),
      '-P',
      '-F',
      '#{pane_id}',
      hubCommand(options),
    ])).trim();
    if (!paneId) throw new Error('empty sidebar pane');
    await tmuxExec(tmux, ['set-option', '-p', '-t', paneId, SIDEBAR_ROLE_OPTION, SIDEBAR_ROLE]);
    await tmuxExec(tmux, ['select-pane', '-t', current.paneId]);
    return { action: 'opened', paneId };
  } catch {
    throw new Error('sidebar toggle failed');
  }
}

function parseCurrentPane(stdout) {
  const [windowId, paneId, cwd] = stdout.trimEnd().split('\t');
  if (!windowId || !paneId) throw new Error('missing current pane');
  return { windowId, paneId, cwd };
}

function findSidebarPane(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    const [paneId, role] = line.split('\t');
    if (paneId && role === SIDEBAR_ROLE) return paneId;
  }
  return undefined;
}

function hubCommand(options) {
  const cli = process.argv[1] ? path.resolve(process.argv[1]) : 'pi-tmux-hub';
  const args = [process.execPath, cli, 'hub', '--tmux', options.tmux || 'tmux', '--pi-root', options.piRoot || DEFAULT_PI_ROOT, '--registry-dir', options.registryDir || defaultRegistryDir(), '--interval', String(options.interval || 5)];
  if (options.fullPaths) args.push('--full-paths');
  return args.map(shellQuote).join(' ');
}

async function tmuxOutput(tmux, args) {
  const { stdout } = await exec(tmux, args);
  return stdout;
}

function firstMatch(rows, selector) {
  if (selector === 'attention') {
    const priority = new Map([['error', 0], ['working', 1], ['waiting', 2]]);
    return rows
      .filter((row) => priority.has(row.state))
      .sort((left, right) => priority.get(left.state) - priority.get(right.state))[0];
  }

  return rows.find((row) => row.state === selector || row.target === selector || row.pi?.name?.includes(selector));
}

export async function jumpToTarget(tmux, target) {
  const parsed = parseTarget(target);
  await tmuxExec(tmux, ['select-window', '-t', parsed.windowTarget]);
  await tmuxExec(tmux, ['select-pane', '-t', target]);

  if (process.env.TMUX) {
    await tmuxExec(tmux, ['switch-client', '-t', parsed.windowTarget]);
    return;
  }

  await tmuxSpawn(tmux, ['attach-session', '-t', parsed.session]);
}

export function parseTarget(target) {
  const match = String(target || '').match(/^([^:]+):(\d+)\.(\d+)$/);
  if (!match) throw new Error('target must look like session:window.pane');
  return { session: match[1], window: match[2], pane: match[3], windowTarget: `${match[1]}:${match[2]}` };
}

async function tmuxExec(tmux, args) {
  try {
    await exec(tmux, args);
  } catch {
    throw new Error('tmux target switch failed');
  }
}

function tmuxSpawn(tmux, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(tmux, args, { stdio: 'inherit' });
    child.on('error', () => reject(new Error('tmux attach failed')));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('tmux attach failed'))));
  });
}

export async function listTmuxPanes(tmux = 'tmux') {
  let stdout;
  try {
    ({ stdout } = await exec(tmux, ['list-panes', '-a', '-F', TMUX_FORMAT]));
  } catch {
    throw new Error('tmux list-panes failed; is tmux running?');
  }
  return parseTmuxPanes(stdout);
}

export function parseTmuxPanes(stdout) {
  return stdout.trimEnd().split('\n').filter(Boolean).map((line) => {
    const [session, window, pane, paneId, command, cwd, title] = line.split('\t');
    return {
      command: command || '',
      cwd: cwd || '',
      pane: Number(pane),
      paneId: paneId || '',
      session: session || '',
      target: `${session}:${window}.${pane}`,
      title: title || '',
      window: Number(window),
    };
  });
}

async function enrichPane(pane, piRoot, registryEntry) {
  const pi = registryEntry ? await piSessionForRegistryEntry(registryEntry, piRoot) : (pane.cwd ? await latestPiSessionForCwd(pane.cwd, piRoot) : null);
  return {
    adapter: pi ? 'pi' : 'tmux',
    command: pane.command,
    cwd: pane.cwd,
    cwdName: pane.cwd ? path.basename(pane.cwd) : '-',
    paneId: pane.paneId,
    pi,
    state: classifyPane(pane, pi),
    target: pane.target,
  };
}

export function classifyPane(pane, pi) {
  if (!pi) return 'tmux';
  if (pi.registryState) return pi.registryState;
  if (pi.lastStopReason === 'error') return 'error';
  if (pi.lastRole === 'toolResult' || pi.lastRole === 'user' || pi.lastStopReason === 'toolUse') return 'working';
  if (pi.lastStopReason === 'stop') return 'waiting';
  return SHELLS.has(pane.command) ? 'idle' : 'live';
}

export async function registerCurrentPane(options = {}) {
  try {
    return await writeRegistryEntry({
      cwd: options.cwd || process.cwd(),
      last: options.last,
      lastToolName: options.lastToolName,
      paneId: options.paneId || process.env.TMUX_PANE,
      pid: options.pid ?? process.pid,
      sessionFile: options.sessionFile,
      state: options.state || 'working',
    }, options.registryDir || defaultRegistryDir());
  } catch {
    throw new Error('registry write failed');
  }
}

export async function writeRegistryEntry(entry, registryDir = defaultRegistryDir()) {
  const normalized = normalizeRegistryEntry({
    version: 1,
    updatedAt: new Date().toISOString(),
    ...entry,
  });
  if (!normalized) throw new Error('invalid registry entry');

  await mkdir(registryDir, { mode: 0o700, recursive: true });
  const name = `${encodeURIComponent(normalized.paneId)}.json`;
  const tmp = path.join(registryDir, `${name}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(serializableRegistryEntry(normalized))}\n`, { mode: 0o600 });
  await rename(tmp, path.join(registryDir, name));
  return normalized;
}

export async function readRegistry(registryDir = defaultRegistryDir()) {
  let entries;
  try {
    entries = await readdir(registryDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const registry = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(registryDir, entry.name), 'utf8'));
      const normalized = normalizeRegistryEntry(parsed);
      if (normalized) registry.push(normalized);
    } catch {
      // Ignore broken registry files; they must not break snapshots or leak paths.
    }
  }
  return registry;
}

export async function registryEntriesForPanes(panes, registryDir = defaultRegistryDir()) {
  const paneById = new Map(panes.filter((pane) => pane.paneId).map((pane) => [pane.paneId, pane]));
  const byPane = new Map();
  for (const entry of await readRegistry(registryDir)) {
    const pane = paneById.get(entry.paneId);
    if (!pane) continue;
    if (entry.cwd && pane.cwd && entry.cwd !== pane.cwd) continue;

    const state = entry.state !== 'stopped' && entry.pid && !pidAlive(entry.pid) ? 'stopped' : entry.state;
    byPane.set(entry.paneId, { ...entry, state });
  }
  return byPane;
}

async function piSessionForRegistryEntry(entry, piRoot) {
  const fromFile = entry.sessionFile ? await piSessionFromFile(entry.sessionFile) : null;
  const session = fromFile || (entry.cwd ? await latestPiSessionForCwd(entry.cwd, piRoot) : null) || {};
  return {
    ...session,
    file: session.file || entry.sessionFile,
    liveLast: entry.last,
    lastToolName: entry.lastToolName,
    registryState: entry.state,
    registryUpdatedAt: entry.updatedAt,
  };
}

async function piSessionFromFile(file) {
  try {
    const info = await stat(file);
    const text = await readFile(file, 'utf8');
    return { ...parsePiSessionText(text), file, fileUpdatedAt: new Date(info.mtimeMs) };
  } catch {
    return null;
  }
}

function normalizeRegistryEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.paneId !== 'string' || !entry.paneId) return null;
  const state = normalizeRegistryState(entry.state || 'working');
  const updatedAt = parseTimestamp(entry.updatedAt) || new Date();
  return removeUndefined({
    version: 1,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    last: typeof entry.last === 'string' ? entry.last : undefined,
    lastToolName: typeof entry.lastToolName === 'string' ? entry.lastToolName : undefined,
    paneId: entry.paneId,
    pid: Number.isInteger(entry.pid) && entry.pid > 0 ? entry.pid : undefined,
    sessionFile: typeof entry.sessionFile === 'string' ? entry.sessionFile : undefined,
    state,
    updatedAt,
  });
}

function serializableRegistryEntry(entry) {
  return removeUndefined({ ...entry, updatedAt: entry.updatedAt.toISOString() });
}

function normalizeRegistryState(state) {
  if (['error', 'stopped', 'waiting', 'working'].includes(state)) return state;
  throw new Error('unknown registry state');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function defaultRegistryDir() {
  return process.env.PI_TMUX_HUB_REGISTRY_DIR || DEFAULT_REGISTRY_DIR;
}

export async function latestPiSessionForCwd(cwd, piRoot = DEFAULT_PI_ROOT) {
  const files = [];
  for (const dirName of piSessionDirNames(cwd)) {
    for (const file of await jsonlFiles(path.join(piRoot, dirName))) files.push(file);
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const file of files) {
    const session = await piSessionFromFile(file.path);
    if (session) return session;
  }
  return null;
}

export function piSessionDirNames(cwd) {
  const normalized = cwd.replace(/\\/g, '/');
  const withLeadingSlash = normalized.replaceAll('/', '-');
  const withoutLeadingSlash = normalized.replace(/^\/+/, '').replaceAll('/', '-');
  return [...new Set([`--${withLeadingSlash}--`, `--${withoutLeadingSlash}--`])];
}

async function jsonlFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, entry.name);
    try {
      const info = await stat(file);
      files.push({ path: file, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore files that disappear or become unreadable while the hub scans.
    }
  }
  return files;
}

export function parsePiSessionText(text) {
  const session = {
    id: undefined,
    name: undefined,
    cwd: undefined,
    lastRole: undefined,
    lastStopReason: undefined,
    lastTimestamp: undefined,
    lastToolName: undefined,
    malformedLines: 0,
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      session.malformedLines += 1;
      continue;
    }

    if (entry.type === 'session') {
      session.id = entry.id || session.id;
      session.cwd = entry.cwd || session.cwd;
    }
    if (entry.type === 'session_info' && typeof entry.name === 'string') session.name = entry.name;

    const timestamp = parseTimestamp(entry.timestamp || entry.message?.timestamp);
    if (timestamp) session.lastTimestamp = timestamp;

    if (entry.type === 'message' && entry.message) {
      const message = entry.message;
      session.lastRole = message.role;
      session.lastStopReason = message.stopReason;
      const toolCall = Array.isArray(message.content) ? message.content.find((block) => block?.type === 'toolCall' || block?.type === 'tool_use') : undefined;
      session.lastToolName = toolCall?.name || entry.toolName || session.lastToolName;
    }
  }

  return session;
}

function parseTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : undefined;
}

async function printSnapshot(options) {
  const rows = await snapshot(options);
  const view = rows.map((row) => publicRow(row, options));

  if (options.watch && !options.json) process.stdout.write('\x1Bc');
  process.stdout.write(options.json ? `${JSON.stringify(view)}\n` : `${renderTable(view)}\n`);
}

export function publicRow(row, options = {}) {
  const updatedAt = row.pi?.registryUpdatedAt || row.pi?.lastTimestamp || row.pi?.fileUpdatedAt;
  return {
    state: row.state,
    target: row.target,
    command: row.command,
    directory: options.fullPaths ? row.cwd : row.cwdName,
    adapter: row.adapter,
    name: row.pi?.name || '-',
    last: describePi(row.pi),
    updated: updatedAt?.toISOString() || '-',
    age: formatAge(updatedAt),
    ...(options.fullPaths && row.pi?.file ? { sessionFile: row.pi.file } : {}),
  };
}

function describePi(pi) {
  if (!pi) return '-';
  if (pi.lastToolName) return `tool:${pi.lastToolName}`;
  return pi.liveLast || pi.lastStopReason || pi.lastRole || '-';
}

export function renderTable(rows) {
  return renderCells([
    ['STATE', 'TARGET', 'CMD', 'DIR', 'ADAPTER', 'PI NAME', 'LAST', 'AGE'],
    ...rows.map((row) => [row.state, row.target, row.command, row.directory, row.adapter, row.name, row.last, row.age]),
  ]);
}

export function renderHub(rows, selected = 0, options = {}, status = '') {
  const view = rows.map((row) => publicRow(row, options));
  const table = renderCells([
    ['', 'STATE', 'TARGET', 'CMD', 'DIR', 'ADAPTER', 'PI NAME', 'LAST', 'AGE'],
    ...view.map((row, index) => [index === selected ? '›' : ' ', row.state, row.target, row.command, row.directory, row.adapter, row.name, row.last, row.age]),
  ]);
  return [
    'pi-tmux-hub hub  ↑/k ↓/j select  enter jump  n attention  r refresh  q quit',
    status ? `status: ${status}` : '',
    table,
  ].filter(Boolean).join('\n');
}

export function hubSelectionIndex(index, count) {
  if (count < 1) return 0;
  return ((index % count) + count) % count;
}

function renderCells(table) {
  const widths = table[0].map((_, index) => Math.max(...table.map((row) => printable(row[index]).length)));
  return table.map((row) => row.map((cell, index) => printable(cell).padEnd(widths[index])).join('  ').trimEnd()).join('\n');
}

function printable(value) {
  return String(value ?? '');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function formatAge(date) {
  if (!date) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function requireValue(argv, index, flag) {
  return requireNonEmpty(argv[index], flag);
}

function requireNonEmpty(value, flag) {
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function parseInterval(value) {
  if (!/^\d+$/.test(value)) throw new Error('--interval must be a positive integer');
  const seconds = Number(value);
  if (seconds < 1) throw new Error('--interval must be a positive integer');
  return seconds;
}

function parsePid(value) {
  if (!/^\d+$/.test(value)) throw new Error('--pid must be a positive integer');
  const pid = Number(value);
  if (pid < 1) throw new Error('--pid must be a positive integer');
  return pid;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helpText() {
  return `pi-tmux-hub

Usage:
  pi-tmux-hub [--json] [--watch] [--interval <seconds>] [--full-paths]
  pi-tmux-hub hub [--interval <seconds>]
  pi-tmux-hub sidebar
  pi-tmux-hub spawn <name> [--command <cmd>]
  pi-tmux-hub close [target] [--delete-worktree] [--force]
  pi-tmux-hub jump <session:window.pane>
  pi-tmux-hub next [attention|error|working|waiting|target|name]
  pi-tmux-hub register --state <working|waiting|error|stopped>

Read-only tmux snapshot plus deterministic tmux navigation. No network, no tokens.

Commands:
  hub                    Open the interactive live selector.
  sidebar                Toggle hub in a tmux side pane.
  spawn <name>           Create .worktrees/<name>, branch agent/<name>, tmux window.
  close                  Close a pi-tmux-hub spawned window; delete only with flags.

Options:
  --json                 Print machine-readable rows.
  --watch                Refresh until interrupted.
  --interval <seconds>   Watch refresh interval. Default: 5.
  --full-paths           Show cwd and Pi session file paths. Hidden by default.
  --pi-root <dir>        Pi session root. Default: ~/.pi/agent/sessions.
  --registry-dir <dir>   Pi/tmux registry dir. Default: ~/.pi-tmux-hub/registry.
  --tmux <binary>        tmux binary. Default: tmux.
  --target <pane>        tmux target for spawn/close.
  --command <cmd>        Command for spawned window. Default: pi.
  --delete-worktree      With close, also remove managed worktree and branch.
  --force                With --delete-worktree, force git worktree/branch removal.
  -h, --help             Show help.`;
}
