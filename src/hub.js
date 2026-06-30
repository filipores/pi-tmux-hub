import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const DEFAULT_PI_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');
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
    fullPaths: false,
    help: false,
    interval: 5,
    json: false,
    piRoot: DEFAULT_PI_ROOT,
    tmux: 'tmux',
    watch: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--full-paths') options.fullPaths = true;
    else if (arg === '--watch') options.watch = true;
    else if (arg === '--pi-root') options.piRoot = requireValue(argv, ++index, '--pi-root');
    else if (arg.startsWith('--pi-root=')) options.piRoot = requireNonEmpty(arg.slice('--pi-root='.length), '--pi-root');
    else if (arg === '--tmux') options.tmux = requireValue(argv, ++index, '--tmux');
    else if (arg.startsWith('--tmux=')) options.tmux = requireNonEmpty(arg.slice('--tmux='.length), '--tmux');
    else if (arg === '--interval') options.interval = parseInterval(requireValue(argv, ++index, '--interval'));
    else if (arg.startsWith('--interval=')) options.interval = parseInterval(arg.slice('--interval='.length));
    else throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

export async function snapshot(options = {}) {
  const resolved = { piRoot: DEFAULT_PI_ROOT, tmux: 'tmux', ...options };
  const panes = await listTmuxPanes(resolved.tmux);
  const rows = await Promise.all(panes.map((pane) => enrichPane(pane, resolved.piRoot)));
  return rows.sort((left, right) => left.target.localeCompare(right.target, undefined, { numeric: true }));
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

async function enrichPane(pane, piRoot) {
  const pi = pane.cwd ? await latestPiSessionForCwd(pane.cwd, piRoot) : null;
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
  if (pi.lastStopReason === 'error') return 'error';
  if (pi.lastRole === 'toolResult' || pi.lastStopReason === 'toolUse') return 'working';
  if (pi.lastRole === 'user') return 'queued';
  if (pi.lastStopReason === 'stop') return 'waiting';
  return SHELLS.has(pane.command) ? 'idle' : 'live';
}

export async function latestPiSessionForCwd(cwd, piRoot = DEFAULT_PI_ROOT) {
  const files = [];
  for (const dirName of piSessionDirNames(cwd)) {
    for (const file of await jsonlFiles(path.join(piRoot, dirName))) files.push(file);
  }

  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const file of files) {
    try {
      const text = await readFile(file.path, 'utf8');
      return { ...parsePiSessionText(text), file: file.path };
    } catch {
      // Skip unreadable session files; one bad log should not kill the hub or leak paths.
    }
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
  return {
    state: row.state,
    target: row.target,
    command: row.command,
    directory: options.fullPaths ? row.cwd : row.cwdName,
    adapter: row.adapter,
    name: row.pi?.name || '-',
    updated: row.pi?.lastTimestamp?.toISOString() || '-',
    age: formatAge(row.pi?.lastTimestamp),
    ...(options.fullPaths && row.pi?.file ? { sessionFile: row.pi.file } : {}),
  };
}

export function renderTable(rows) {
  const table = [
    ['STATE', 'TARGET', 'CMD', 'DIR', 'ADAPTER', 'PI NAME', 'AGE'],
    ...rows.map((row) => [row.state, row.target, row.command, row.directory, row.adapter, row.name, row.age]),
  ];
  const widths = table[0].map((_, index) => Math.max(...table.map((row) => printable(row[index]).length)));
  return table.map((row) => row.map((cell, index) => printable(cell).padEnd(widths[index])).join('  ').trimEnd()).join('\n');
}

function printable(value) {
  return String(value ?? '');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helpText() {
  return `pi-tmux-hub

Usage:
  pi-tmux-hub [--json] [--watch] [--interval <seconds>] [--full-paths]

Read-only tmux snapshot with a Pi JSONL adapter. No network, no tokens, no controls.

Options:
  --json                 Print machine-readable rows.
  --watch                Refresh until interrupted.
  --interval <seconds>   Watch refresh interval. Default: 5.
  --full-paths           Show cwd and Pi session file paths. Hidden by default.
  --pi-root <dir>        Pi session root. Default: ~/.pi/agent/sessions.
  --tmux <binary>        tmux binary. Default: tmux.
  -h, --help             Show help.`;
}
