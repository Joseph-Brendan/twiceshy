#!/usr/bin/env node

import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import type { Tool } from '@modelcontextprotocol/server';
import type { ActionRecord, Guard, ListFilter, RecordState } from 'twiceshy';
import { createGuard, isTwiceshyError, parseDuration, shouldGuard } from 'twiceshy';
import type { ProxyConfig } from './config.js';
import { loadConfigFile } from './config.js';
import { connectAllDownstreams } from './downstream.js';
import type { Logger, LogLevel } from './logger.js';
import { createLogger, isLogLevel } from './logger.js';
import { createActionStore, guardAnnotations, startProxy } from './proxy.js';
import { PROXY_VERSION } from './version.js';

/**
 * The C14 CLI. One command, `twiceshy`, with proxy, doctor, list, show,
 * resolve, allow, and purge. Exit codes: 0 success, 1 error, 2 bad usage.
 */

const COMMANDS = ['proxy', 'doctor', 'list', 'show', 'resolve', 'allow', 'purge'] as const;
type Command = (typeof COMMANDS)[number];

const RECORD_STATES: readonly RecordState[] = [
  'IN_FLIGHT',
  'SUCCEEDED',
  'FAILED_DEFINITE',
  'IN_DOUBT',
  'RESOLVED_SUCCEEDED',
  'RESOLVED_FAILED',
];

const FREE_TEXT_FIELDS = new Set(['note', 'reason', 'message', 'description', 'comment', 'memo']);

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliDependencies {
  /** Injectable proxy starter; tests use it to avoid touching real stdio. */
  start?: typeof startProxy;
  /** Injectable purge confirmation; tests answer yes or no without a TTY. */
  confirm?: (question: string) => Promise<boolean>;
  logger?: Logger;
  io?: CliIo;
  cwd?: string;
  now?: () => Date;
}

/** A command failure with the C9 what/why/fix shape, printed on separate lines. */
class CliError extends Error {
  readonly what: string;
  readonly why: string;
  readonly fix: string;

  constructor(what: string, why: string, fix: string) {
    super(what);
    this.name = 'CliError';
    this.what = what;
    this.why = why;
    this.fix = fix;
  }
}

/** Bad usage: exit code 2. */
class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const GLOBAL_HELP = `Usage: twiceshy [command] [options]

Commands:
  proxy    --config <file>                 Run the MCP proxy (default when no command is given)
  doctor   --config <file>                 Check the config and every downstream server
  list     [--state <state>] [--since 1h]  Show stored action records
  show     <id>                            Show one record in full
  resolve  <id> --succeeded|--failed --by <name> [--note <text>]
  allow    <fingerprint> --by <name> [--note <text>]
  purge    [--older-than 30d] [--yes]      Remove records past retention

Options:
  --config <file>       Config file (default: twiceshy.config.json)
  --json                Machine-readable output
  --log-level <level>   error, warn, info, or debug (default: warn)
  --help, -h            Show help
  --version, -v         Show the version

Example:
  twiceshy list --state IN_DOUBT --config twiceshy.config.json
`;

const COMMAND_HELP: Readonly<Record<Command, string>> = {
  proxy: `Usage: twiceshy proxy --config <file> [--log-level <level>]

Run the MCP proxy on stdio. This is what the agent's client launches.

Example:
  twiceshy proxy --config ~/.twiceshy/config.json --log-level info
`,
  doctor: `Usage: twiceshy doctor --config <file> [--json]

Check the config, start every downstream server, and list each tool as
GUARDED or open with the reason. Exits 0 when every server connects, 1 when
any server fails.

Example:
  twiceshy doctor --config twiceshy.config.json
`,
  list: `Usage: twiceshy list [--state <state>] [--since <duration>] [--config <file>] [--json]

Show stored action records, newest first.

Example:
  twiceshy list --state IN_DOUBT --since 1h
`,
  show: `Usage: twiceshy show <id> [--config <file>] [--json]

Show every stored field of one record.

Example:
  twiceshy show mem-7 --json
`,
  resolve: `Usage: twiceshy resolve <id> --succeeded|--failed --by <name> [--note <text>] [--config <file>] [--json]

Settle an in-doubt record after checking whether the action happened.

Example:
  twiceshy resolve mem-7 --succeeded --by kola --note "checked the Paystack dashboard"
`,
  allow: `Usage: twiceshy allow <fingerprint> --by <name> [--note <text>] [--config <file>] [--json]

Approve exactly one repeat of an action inside its window. Human only: the
proxy exposes no tool that can do this.

Example:
  twiceshy allow 4f2a... --by kola --note "customer asked for a second refund"
`,
  purge: `Usage: twiceshy purge [--older-than <duration>] [--yes] [--config <file>] [--json]

Remove records older than retention (default 7d). Asks for confirmation
unless --yes is given.

Example:
  twiceshy purge --older-than 30d --yes
`,
};

interface OptionSpec {
  type: 'boolean' | 'string';
  short?: string;
  multiple?: boolean;
}

const COMMON_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  config: { type: 'string' },
  'log-level': { type: 'string' },
};

const COMMAND_OPTIONS: Readonly<Record<Command, Readonly<Record<string, OptionSpec>>>> = {
  proxy: COMMON_OPTIONS,
  doctor: COMMON_OPTIONS,
  list: {
    ...COMMON_OPTIONS,
    state: { type: 'string', multiple: true },
    since: { type: 'string' },
  },
  show: COMMON_OPTIONS,
  resolve: {
    ...COMMON_OPTIONS,
    succeeded: { type: 'boolean' },
    failed: { type: 'boolean' },
    by: { type: 'string' },
    note: { type: 'string' },
  },
  allow: {
    ...COMMON_OPTIONS,
    by: { type: 'string' },
    note: { type: 'string' },
  },
  purge: {
    ...COMMON_OPTIONS,
    'older-than': { type: 'string' },
    yes: { type: 'boolean' },
  },
};

interface ParsedInvocation {
  values: Record<string, unknown>;
  positionals: string[];
}

function parseCommand(command: Command, args: string[]): ParsedInvocation {
  try {
    const parsed = parseArgs({
      args,
      options: COMMAND_OPTIONS[command] as never,
      allowPositionals: true,
      strict: true,
    });
    return {
      values: parsed.values as Record<string, unknown>,
      positionals: parsed.positionals,
    };
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function stringValue(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(values: Record<string, unknown>, key: string): boolean {
  return values[key] === true;
}

function multipleStringValues(values: Record<string, unknown>, key: string): string[] {
  const value = values[key];
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === 'string',
  );
}

function durationValue(values: Record<string, unknown>, key: string): number | undefined {
  const text = stringValue(values, key);
  if (text === undefined) {
    return undefined;
  }
  try {
    return parseDuration(text);
  } catch {
    throw new CliUsageError(`Invalid ${key} "${text}". Use a duration like "30d" or milliseconds.`);
  }
}

function configFor(values: Record<string, unknown>, deps: CliDependencies): ProxyConfig {
  const base = deps.cwd ?? process.cwd();
  const path = stringValue(values, 'config') ?? 'twiceshy.config.json';
  return loadConfigFile(resolvePath(base, path));
}

async function withGuard<T>(
  config: ProxyConfig,
  logger: Logger,
  fn: (guard: Guard) => Promise<T>,
): Promise<T> {
  const store = createActionStore(config.store, logger);
  const guard = createGuard({
    store,
    window: config.windowMs,
    retention: config.retentionMs,
  });
  try {
    return await fn(guard);
  } finally {
    await guard.close();
  }
}

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function shorten(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function toJsonRecord(record: ActionRecord): Record<string, unknown> {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt === null ? null : record.completedAt.toISOString(),
    leaseExpiresAt: record.leaseExpiresAt === null ? null : record.leaseExpiresAt.toISOString(),
    resolvedAt: record.resolvedAt === null ? null : record.resolvedAt.toISOString(),
    repeatGrant:
      record.repeatGrant === null
        ? null
        : {
            ...record.repeatGrant,
            grantedAt: record.repeatGrant.grantedAt.toISOString(),
          },
  };
}

function renderListTable(records: readonly ActionRecord[]): string {
  if (records.length === 0) {
    return 'No records.\n';
  }
  const columns = { id: 12, tool: 22, state: 17, created: 19 };
  const header = `${'ID'.padEnd(columns.id)}  ${'TOOL'.padEnd(columns.tool)}  ${'STATE'.padEnd(columns.state)}  CREATED`;
  const lines = records.map(
    (record) =>
      `${shorten(record.id, columns.id).padEnd(columns.id)}  ` +
      `${shorten(`${record.serverId}/${record.toolName}`, columns.tool).padEnd(columns.tool)}  ` +
      `${record.state.padEnd(columns.state)}  ` +
      `${formatDate(record.createdAt)}`,
  );
  return `${[header, ...lines].join('\n')}\n`;
}

function renderRecord(record: ActionRecord): string {
  const lines = [
    `id:          ${record.id}`,
    `state:       ${record.state}`,
    `server:      ${record.serverId}`,
    `tool:        ${record.toolName}`,
    `scope:       ${record.scope}`,
    `fingerprint: ${record.fingerprint}`,
    `explicitKey: ${record.explicitKey ?? '-'}`,
    `attempt:     ${record.attempt}`,
    `created:     ${formatDate(record.createdAt)}`,
    `started:     ${formatDate(record.startedAt)}`,
    `completed:   ${record.completedAt === null ? '-' : formatDate(record.completedAt)}`,
    `error:       ${record.errorSummary ?? '-'}`,
    `resolvedBy:  ${record.resolvedBy ?? '-'}`,
    `resolution:  ${record.resolutionNote ?? '-'}`,
    `repeatGrant: ${record.repeatGrant === null ? '-' : JSON.stringify(toJsonRecord(record).repeatGrant)}`,
    `args:        ${JSON.stringify(record.redactedArgs ?? null)}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function commandProxy(
  values: Record<string, unknown>,
  deps: CliDependencies,
  logger: Logger,
): Promise<number> {
  if (stringValue(values, 'config') === undefined) {
    throw new CliUsageError(
      'Missing --config <file>.\nExample: twiceshy proxy --config twiceshy.config.json',
    );
  }
  const config = configFor(values, deps);
  const start = deps.start ?? startProxy;
  const proxy = await start({ config, logger });
  logger.info('proxy started');
  const reason = await waitForShutdown();
  logger.info(`shutting down (${reason}); waiting up to 10s for in-flight calls`);
  await proxy.close();
  logger.info('proxy stopped');
  return 0;
}

interface DoctorToolReport {
  name: string;
  guarded: boolean;
  reason: string;
  warnings: string[];
}

type DoctorServerReport =
  | { name: string; status: 'connected'; tools: DoctorToolReport[] }
  | { name: string; status: 'failed'; what: string; why: string; fix: string };

function freeTextWarning(tool: Tool): string[] {
  const properties = tool.inputSchema?.properties;
  if (properties === undefined || properties === null) {
    return [];
  }
  const fields = Object.keys(properties).filter((key) => FREE_TEXT_FIELDS.has(key.toLowerCase()));
  if (fields.length === 0) {
    return [];
  }
  const quoted = fields.map((field) => `"${field}"`).join(', ');
  return [
    `no keyFields are set and ${quoted} ${fields.length === 1 ? 'is' : 'are'} free text, so a retry with rephrased text looks like a new action and can slip through; set keyFields to the fields that define the action.`,
  ];
}

function wrapText(text: string, width: number, indent: string): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(`${indent}${current}`);
      current = word;
    }
  }
  if (current.length > 0) {
    lines.push(`${indent}${current}`);
  }
  return lines;
}

function renderDoctor(servers: readonly DoctorServerReport[], inDoubt: number): string {
  const nameWidth = Math.min(Math.max(...servers.map((server) => server.name.length + 2), 14), 24);
  const toolNames = servers.flatMap((server) =>
    server.status === 'connected' ? server.tools.map((tool) => tool.name) : [],
  );
  const toolWidth = Math.min(Math.max(...toolNames.map((name) => name.length), 10), 30);
  const lines: string[] = [];
  for (const server of servers) {
    if (server.status === 'connected') {
      lines.push(
        `${shorten(server.name, nameWidth - 2).padEnd(nameWidth)}${'connected'.padEnd(12)}${server.tools.length} tools`,
      );
      for (const tool of server.tools) {
        lines.push(
          `  ${shorten(tool.name, toolWidth).padEnd(toolWidth)}   ` +
            `${(tool.guarded ? 'GUARDED' : 'open').padEnd(11)}(${tool.reason})`,
        );
        for (const warning of tool.warnings) {
          lines.push(...wrapText(`WARNING ${tool.name}: ${warning}`, 78, '  '));
        }
      }
    } else {
      const prefix = `${shorten(server.name, nameWidth - 2).padEnd(nameWidth)}FAILED      `;
      lines.push(...wrapText(server.what, Math.max(20, 80 - prefix.length), prefix));
      lines.push(...wrapText(`Why: ${server.why}`, 80 - nameWidth, ' '.repeat(nameWidth)));
      lines.push(...wrapText(`Fix: ${server.fix}`, 80 - nameWidth, ' '.repeat(nameWidth)));
    }
  }
  lines.push('');
  lines.push(`records in doubt: ${inDoubt}`);
  return `${lines.join('\n')}\n`;
}

async function commandDoctor(
  values: Record<string, unknown>,
  deps: CliDependencies,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const config = configFor(values, deps);
  const downstreams = await connectAllDownstreams(config.mcpServers, { logger });
  const store = createActionStore(config.store, logger);
  try {
    const inDoubt = (await store.list({ state: 'IN_DOUBT' })).length;
    const servers: DoctorServerReport[] = [];
    for (const connection of downstreams.connections) {
      const tools = connection.tools.map((tool): DoctorToolReport => {
        const options = config.mcpServers[connection.name]?.tools[tool.name] ?? {};
        const decision = shouldGuard(
          { name: tool.name, annotations: guardAnnotations(tool) },
          {
            ...(options.guard === undefined ? {} : { guard: options.guard }),
            trustIdempotentHint: config.trustIdempotentHint,
          },
        );
        const hasKeyFields = options.keyFields !== undefined && options.keyFields.length > 0;
        return {
          name: tool.name,
          guarded: decision.guarded,
          reason: decision.reason,
          warnings: decision.guarded && !hasKeyFields ? freeTextWarning(tool) : [],
        };
      });
      servers.push({ name: connection.name, status: 'connected', tools });
    }
    for (const failure of downstreams.failures) {
      servers.push({ ...failure, status: 'failed' });
    }
    if (booleanValue(values, 'json')) {
      io.out(`${JSON.stringify({ servers, inDoubt }, null, 2)}\n`);
    } else {
      io.out(renderDoctor(servers, inDoubt));
    }
    return downstreams.failures.length === 0 ? 0 : 1;
  } finally {
    await store.close();
    await downstreams.close();
  }
}

async function commandList(
  values: Record<string, unknown>,
  deps: CliDependencies,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const config = configFor(values, deps);
  const states = multipleStringValues(values, 'state');
  for (const state of states) {
    if (!(RECORD_STATES as readonly string[]).includes(state)) {
      throw new CliUsageError(
        `Invalid --state "${state}". Use one of: ${RECORD_STATES.join(', ')}.`,
      );
    }
  }
  const sinceMs = durationValue(values, 'since');
  const now = (deps.now ?? (() => new Date()))();
  const filter: ListFilter = {
    ...(states.length === 0
      ? {}
      : { state: states.length === 1 ? (states[0] as RecordState) : (states as RecordState[]) }),
    ...(sinceMs === undefined ? {} : { since: new Date(now.getTime() - sinceMs) }),
  };
  return withGuard(config, logger, async (guard) => {
    const records = await guard.list(filter);
    if (booleanValue(values, 'json')) {
      io.out(`${JSON.stringify(records.map(toJsonRecord), null, 2)}\n`);
    } else {
      io.out(renderListTable(records));
    }
    return 0;
  });
}

function requirePositional(positionals: readonly string[], name: string, example: string): string {
  const value = positionals[0];
  if (value === undefined || value.trim().length === 0) {
    throw new CliUsageError(`Missing <${name}>.\nExample: ${example}`);
  }
  return value;
}

async function commandShow(
  values: Record<string, unknown>,
  positionals: readonly string[],
  deps: CliDependencies,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const id = requirePositional(positionals, 'id', 'twiceshy show mem-7');
  const config = configFor(values, deps);
  return withGuard(config, logger, async (guard) => {
    const record = await guard.get(id);
    if (record === null) {
      throw new CliError(
        `The record "${id}" was not found.`,
        'No stored record has that id, or it was already purged.',
        'List the current records with `twiceshy list` and copy the id from there.',
      );
    }
    if (booleanValue(values, 'json')) {
      io.out(`${JSON.stringify(toJsonRecord(record), null, 2)}\n`);
    } else {
      io.out(renderRecord(record));
    }
    return 0;
  });
}

async function commandResolve(
  values: Record<string, unknown>,
  positionals: readonly string[],
  deps: CliDependencies,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const id = requirePositional(positionals, 'id', 'twiceshy resolve mem-7 --succeeded --by kola');
  const succeeded = booleanValue(values, 'succeeded');
  const failed = booleanValue(values, 'failed');
  if (succeeded === failed) {
    throw new CliUsageError(
      'Pass exactly one of --succeeded or --failed.\nExample: twiceshy resolve mem-7 --succeeded --by kola',
    );
  }
  const by = stringValue(values, 'by')?.trim();
  if (by === undefined || by.length === 0) {
    throw new CliUsageError(
      'Missing --by <name>: a person must approve this resolution.\nExample: twiceshy resolve mem-7 --succeeded --by kola',
    );
  }
  const note = stringValue(values, 'note');
  const config = configFor(values, deps);
  return withGuard(config, logger, async (guard) => {
    const record = await guard.get(id);
    if (record === null) {
      throw new CliError(
        `The record "${id}" was not found.`,
        'No stored record has that id, or it was already purged.',
        'List the in-doubt records with `twiceshy list --state IN_DOUBT`.',
      );
    }
    if (record.state !== 'IN_DOUBT') {
      throw new CliError(
        `The record "${id}" is in state ${record.state}; only IN_DOUBT records can be resolved.`,
        'A human decision is only needed when Twiceshy could not tell whether the action happened.',
        'Pick an in-doubt record with `twiceshy list --state IN_DOUBT`.',
      );
    }
    await guard.resolve(id, {
      as: succeeded ? 'succeeded' : 'failed',
      by,
      ...(note === undefined ? {} : { note }),
    });
    if (booleanValue(values, 'json')) {
      io.out(
        `${JSON.stringify({ ok: true, id, state: succeeded ? 'RESOLVED_SUCCEEDED' : 'RESOLVED_FAILED', by })}\n`,
      );
    } else {
      io.out(`Record ${id} resolved as ${succeeded ? 'succeeded' : 'failed'} by ${by}.\n`);
    }
    return 0;
  });
}

async function commandAllow(
  values: Record<string, unknown>,
  positionals: readonly string[],
  deps: CliDependencies,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const fingerprint = requirePositional(
    positionals,
    'fingerprint',
    'twiceshy allow 4f2a... --by kola',
  );
  const by = stringValue(values, 'by')?.trim();
  if (by === undefined || by.length === 0) {
    throw new CliUsageError(
      'Missing --by <name>: a person must approve this repeat.\nExample: twiceshy allow 4f2a... --by kola',
    );
  }
  const note = stringValue(values, 'note');
  const config = configFor(values, deps);
  return withGuard(config, logger, async (guard) => {
    const [record] = await guard.list({ fingerprint, limit: 1 });
    if (record === undefined) {
      throw new CliError(
        `No record was found for fingerprint "${fingerprint}".`,
        'A repeat can only be granted for an action Twiceshy has already recorded.',
        'Find the fingerprint with `twiceshy list` and try again.',
      );
    }
    if (record.state !== 'SUCCEEDED' && record.state !== 'RESOLVED_SUCCEEDED') {
      throw new CliError(
        `The latest record for "${fingerprint}" is in state ${record.state}; only a succeeded action can be repeated.`,
        'A repeat makes no sense until the action has actually happened.',
        'Resolve the record first (if it is IN_DOUBT), or wait for it to finish.',
      );
    }
    await guard.allowRepeat(fingerprint, { by, ...(note === undefined ? {} : { note }) });
    if (booleanValue(values, 'json')) {
      io.out(`${JSON.stringify({ ok: true, fingerprint, by })}\n`);
    } else {
      io.out(`One repeat allowed for ${fingerprint} by ${by}.\n`);
    }
    return 0;
  });
}

async function defaultConfirm(question: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function commandPurge(
  values: Record<string, unknown>,
  deps: CliDependencies,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const config = configFor(values, deps);
  const olderThanMs = durationValue(values, 'older-than') ?? config.retentionMs;
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - olderThanMs);
  return withGuard(config, logger, async (guard) => {
    if (!booleanValue(values, 'yes')) {
      const confirm = deps.confirm ?? defaultConfirm;
      const confirmed = await confirm(`Remove records finished before ${cutoff.toISOString()}?`);
      if (!confirmed) {
        if (booleanValue(values, 'json')) {
          io.out(`${JSON.stringify({ ok: true, removed: 0, confirmed: false })}\n`);
        } else {
          io.out('Nothing was removed.\n');
        }
        return 0;
      }
    }
    const removed = await guard.purge(cutoff);
    if (booleanValue(values, 'json')) {
      io.out(`${JSON.stringify({ ok: true, removed, confirmed: true })}\n`);
    } else {
      io.out(`Removed ${removed} record${removed === 1 ? '' : 's'}.\n`);
    }
    return 0;
  });
}

async function dispatch(
  command: Command,
  invocation: ParsedInvocation,
  deps: CliDependencies,
  io: CliIo,
  logger: Logger,
): Promise<number> {
  const { values, positionals } = invocation;
  switch (command) {
    case 'proxy':
      return commandProxy(values, deps, logger);
    case 'doctor':
      return commandDoctor(values, deps, io, logger);
    case 'list':
      return commandList(values, deps, io, logger);
    case 'show':
      return commandShow(values, positionals, deps, io, logger);
    case 'resolve':
      return commandResolve(values, positionals, deps, io, logger);
    case 'allow':
      return commandAllow(values, positionals, deps, io, logger);
    case 'purge':
      return commandPurge(values, deps, io, logger);
  }
}

/**
 * Runs one CLI invocation. Returns only when a proxy session ends; other
 * commands return as soon as they finish.
 */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  deps: CliDependencies = {},
): Promise<number> {
  const io = deps.io ?? {
    out: (text: string) => process.stdout.write(text),
    err: (text: string) => process.stderr.write(text),
  };
  const first = argv[0];

  if (first === '--version' || first === '-v') {
    io.out(`@twiceshy/mcp-proxy v${PROXY_VERSION}\n`);
    return 0;
  }
  if (first === '--help' || first === '-h') {
    io.out(GLOBAL_HELP);
    return 0;
  }

  let command: Command;
  let rest: string[];
  if (first === undefined || first.startsWith('-')) {
    command = 'proxy';
    rest = argv;
  } else if ((COMMANDS as readonly string[]).includes(first)) {
    command = first as Command;
    rest = argv.slice(1);
  } else {
    io.err(`Unknown command "${first}".\n\n${GLOBAL_HELP}`);
    return 2;
  }

  let invocation: ParsedInvocation;
  try {
    invocation = parseCommand(command, rest);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(`${error.message}\n\n${COMMAND_HELP[command]}`);
      return 2;
    }
    throw error;
  }
  if (booleanValue(invocation.values, 'help')) {
    io.out(COMMAND_HELP[command]);
    return 0;
  }

  const levelText = stringValue(invocation.values, 'log-level') ?? 'warn';
  if (!isLogLevel(levelText)) {
    io.err(`Invalid --log-level "${levelText}". Use error, warn, info, or debug.\n`);
    return 2;
  }
  const level: LogLevel = levelText;
  const logger = deps.logger ?? createLogger({ level });

  try {
    return await dispatch(command, invocation, deps, io, logger);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(`${error.message}\n\n${COMMAND_HELP[command]}`);
      return 2;
    }
    if (error instanceof CliError) {
      io.err(`${error.what}\nWhy: ${error.why}\nFix: ${error.fix}\n`);
      return 1;
    }
    if (isTwiceshyError(error)) {
      io.err(`${error.what}\nWhy: ${error.why}\nFix: ${error.fix}\n`);
      return 1;
    }
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Resolves once the client disconnects or the process is asked to stop.
 * Registering SIGTERM/SIGINT handlers replaces the default immediate exit, so
 * the caller can close the proxy gracefully first (C13).
 */
function waitForShutdown(): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.stdin.off('end', onStdinEnd);
      resolve(reason);
    };
    const onSigint = (): void => finish('SIGINT');
    const onSigterm = (): void => finish('SIGTERM');
    const onStdinEnd = (): void => finish('client disconnect');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.stdin.once('end', onStdinEnd);
    if (process.stdin.readableEnded) {
      finish('client disconnect');
    }
  });
}

/* v8 ignore start */
if (process.env.NODE_ENV !== 'test') {
  void runCli()
    .then((code) => {
      if (code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
/* v8 ignore stop */
