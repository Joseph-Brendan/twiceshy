import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigInvalidError, parseDuration } from 'twiceshy';
import { z } from 'zod';
import type { ToolNaming } from './naming.js';

/**
 * Config loading (C13). The Zod schema is the single source of truth; the
 * committed schema.json is generated from it. Every problem is collected and
 * reported in one CONFIG_INVALID error.
 */

export type NormalizerName = 'number' | 'trim' | 'lowercase' | 'lowercase-trim';

const DEFAULT_STORE_PATH = '~/.twiceshy/actions.db';

const DURATION_EXPECTED =
  'a duration such as "10m", "30s", "7d", or a whole number of milliseconds like 600000';

const EXAMPLE_BY_FIELD: Readonly<Record<string, string>> = {
  $schema: '"https://unpkg.com/@twiceshy/mcp-proxy/schema.json"',
  store: '{ "type": "sqlite", "path": "~/.twiceshy/actions.db" }',
  window: '"10m"',
  retention: '"7d"',
  onStoreFailure: '"closed"',
  toolNaming: '"prefix"',
  trustIdempotentHint: 'true',
  annotateDuplicates: 'true',
  exposeRecentActions: 'false',
  mcpServers: '{ "paystack": { "command": "npx" } }',
  path: '"~/.twiceshy/actions.db"',
  type: '"sqlite"',
  command: '"npx"',
  args: '["-y", "paystack-mcp"]',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is the documented placeholder syntax
  env: '{ "PAYSTACK_SECRET_KEY": "${PAYSTACK_SECRET_KEY}" }',
  cwd: '"~"',
  url: '"https://example.com/mcp"',
  tools: '{ "create_refund": { "guard": true } }',
  guard: 'true',
  keyFields: '["transaction", "amount"]',
  ignoreFields: '["reason"]',
  normalize: '{ "amount": "number" }',
  timeoutMs: '30000',
  treatToolErrorsAsDefinite: 'false',
};

const durationSchema = z
  .union([z.number(), z.string()], { error: `expected ${DURATION_EXPECTED}` })
  .refine(
    (value) => {
      try {
        parseDuration(value);
        return true;
      } catch {
        return false;
      }
    },
    { error: `expected ${DURATION_EXPECTED}` },
  );

const toolConfigSchema = z.strictObject({
  guard: z.boolean({ error: 'expected true or false' }).optional(),
  keyFields: z
    .array(z.string().min(1, { error: 'expected non-empty field names' }), {
      error: 'expected an array of field names',
    })
    .optional(),
  ignoreFields: z
    .array(z.string().min(1, { error: 'expected non-empty field names' }), {
      error: 'expected an array of field names',
    })
    .optional(),
  normalize: z
    .record(
      z.string(),
      z.enum(['number', 'trim', 'lowercase', 'lowercase-trim'], {
        error: 'expected "number", "trim", "lowercase", or "lowercase-trim"',
      }),
    )
    .optional(),
  timeoutMs: durationSchema.optional(),
  treatToolErrorsAsDefinite: z.boolean({ error: 'expected true or false' }).optional(),
});

const toolsSchema = z.record(
  z.string().min(1, { error: 'expected a tool name' }),
  toolConfigSchema,
);

const stdioServerSchema = z.strictObject({
  command: z.string().min(1, { error: 'expected the command to start the server' }),
  args: z.array(z.string(), { error: 'expected command arguments as strings' }).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  tools: toolsSchema.optional(),
});

const httpServerSchema = z.strictObject({
  url: z.url({ error: 'expected a URL' }),
  tools: toolsSchema.optional(),
});

const serverSchema = z.union([stdioServerSchema, httpServerSchema]);

const sqliteStoreSchema = z.strictObject({
  type: z.literal('sqlite'),
  path: z.string().min(1, { error: 'expected the database path' }),
});

const memoryStoreSchema = z.strictObject({ type: z.literal('memory') });

const storeSchema = z.union([sqliteStoreSchema, memoryStoreSchema]);

const globalFields = {
  $schema: z.string().optional(),
  store: storeSchema.optional(),
  window: durationSchema.optional(),
  retention: durationSchema.optional(),
  onStoreFailure: z.enum(['closed', 'open'], { error: 'expected "closed" or "open"' }).optional(),
  toolNaming: z.enum(['prefix', 'none'], { error: 'expected "prefix" or "none"' }).optional(),
  trustIdempotentHint: z.boolean({ error: 'expected true or false' }).optional(),
  annotateDuplicates: z.boolean({ error: 'expected true or false' }).optional(),
  exposeRecentActions: z.boolean({ error: 'expected true or false' }).optional(),
} as const;

/** The canonical config schema. `schema.json` is generated from this. */
export const configSchema = z.strictObject({
  ...globalFields,
  mcpServers: z.record(z.string().min(1, { error: 'expected a server name' }), serverSchema),
});

/** Same fields, but servers stay unknown so their errors can be reported precisely. */
const topLevelSchema = z.strictObject({
  ...globalFields,
  mcpServers: z.record(z.string().min(1), z.unknown()),
});

export interface ToolOptions {
  guard?: boolean;
  keyFields?: readonly string[];
  ignoreFields?: readonly string[];
  normalize?: Readonly<Record<string, NormalizerName>>;
  timeoutMs?: number;
  treatToolErrorsAsDefinite?: boolean;
}

export interface StdioServerConfig {
  kind: 'stdio';
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
  tools: Readonly<Record<string, ToolOptions>>;
}

export interface HttpServerConfig {
  kind: 'http';
  url: string;
  tools: Readonly<Record<string, ToolOptions>>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export type StoreConfig = { type: 'sqlite'; path: string } | { type: 'memory' };

export interface ProxyConfig {
  store: StoreConfig;
  windowMs: number;
  retentionMs: number;
  onStoreFailure: 'closed' | 'open';
  toolNaming: ToolNaming;
  trustIdempotentHint: boolean;
  annotateDuplicates: boolean;
  exposeRecentActions: boolean;
  mcpServers: Readonly<Record<string, ServerConfig>>;
}

export interface LoadConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandHome(input: string, home: string): string {
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(home, input.slice(2));
  }
  return input;
}

function flattenIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  const flat: z.core.$ZodIssue[] = [];
  for (const issue of issues) {
    const nested = (issue as { errors?: unknown }).errors;
    if (issue.code === 'invalid_union' && Array.isArray(nested)) {
      for (const branch of nested as z.core.$ZodIssue[][]) {
        flat.push(...flattenIssues(branch));
      }
      continue;
    }
    flat.push(issue);
  }
  return flat;
}

function describeIssue(issue: z.core.$ZodIssue, basePath: string): string {
  const parts = [...(basePath.length === 0 ? [] : basePath.split('.')), ...issue.path.map(String)];
  const label = parts.length === 0 ? 'config' : parts.join('.');
  const example = EXAMPLE_BY_FIELD[String(issue.path[issue.path.length - 1] ?? '')];
  const hint = example === undefined ? '' : `, for example ${example}`;
  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as { keys?: readonly string[] }).keys ?? [];
    return `${label}: unknown field ${keys.map((key) => `"${key}"`).join(', ')}`;
  }
  if (issue.code === 'invalid_type') {
    return `${label}: expected ${String((issue as { expected?: unknown }).expected)}${hint}`;
  }
  if (issue.code === 'invalid_value') {
    const values = (issue as { values?: readonly unknown[] }).values ?? [];
    return `${label}: expected one of ${values.map((value) => JSON.stringify(value)).join(', ')}${hint}`;
  }
  return `${label}: ${issue.message}${hint}`;
}

function pushIssues(target: string[], issues: readonly z.core.$ZodIssue[], basePath: string): void {
  const seen = new Set(target);
  for (const issue of flattenIssues(issues)) {
    const message = describeIssue(issue, basePath);
    if (!seen.has(message)) {
      seen.add(message);
      target.push(message);
    }
  }
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function serverFromPath(path: readonly string[]): string | null {
  return path[0] === 'mcpServers' && path.length > 1 ? String(path[1]) : null;
}

function expandEnv(
  value: unknown,
  path: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  issues: string[],
): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (match, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        const label = [...(path.length === 0 ? ['config'] : path)].join('.');
        const server = serverFromPath(path);
        const context = server === null ? '' : ` (used by server "${server}")`;
        const message = `${label}: environment variable "${name}" is not set${context}`;
        if (!issues.includes(message)) {
          issues.push(message);
        }
        return match;
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => expandEnv(item, [...path, String(index)], env, issues));
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = expandEnv(item, [...path, key], env, issues);
    }
    return output;
  }
  return value;
}

function normalizeTools(
  raw: Readonly<Record<string, z.infer<typeof toolConfigSchema>>>,
): Record<string, ToolOptions> {
  const tools: Record<string, ToolOptions> = {};
  for (const [name, config] of Object.entries(raw)) {
    tools[name] = {
      ...(config.guard === undefined ? {} : { guard: config.guard }),
      ...(config.keyFields === undefined ? {} : { keyFields: config.keyFields }),
      ...(config.ignoreFields === undefined ? {} : { ignoreFields: config.ignoreFields }),
      ...(config.normalize === undefined ? {} : { normalize: config.normalize }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: parseDuration(config.timeoutMs) }),
      ...(config.treatToolErrorsAsDefinite === undefined
        ? {}
        : { treatToolErrorsAsDefinite: config.treatToolErrorsAsDefinite }),
    };
  }
  return tools;
}

function parseServers(raw: unknown, home: string, issues: string[]): Record<string, ServerConfig> {
  const servers: Record<string, ServerConfig> = {};
  if (raw === undefined) {
    return servers;
  }
  if (!isRecord(raw)) {
    issues.push(
      'mcpServers: expected an object of server definitions, for example { "paystack": { "command": "npx" } }',
    );
    return servers;
  }
  for (const [name, value] of Object.entries(raw)) {
    const label = `mcpServers.${name}`;
    if (!isRecord(value)) {
      issues.push(`${label}: expected an object with "command" (stdio) or "url" (HTTP)`);
      continue;
    }
    const hasCommand = 'command' in value;
    const hasUrl = 'url' in value;
    if (hasCommand && hasUrl) {
      issues.push(`${label}: expected either "command" (stdio) or "url" (HTTP), not both`);
      continue;
    }
    if (hasCommand) {
      const parsed = stdioServerSchema.safeParse(value);
      if (!parsed.success) {
        pushIssues(issues, parsed.error.issues, label);
        continue;
      }
      servers[name] = {
        kind: 'stdio',
        command: expandHome(parsed.data.command, home),
        args: parsed.data.args ?? [],
        env: parsed.data.env ?? {},
        ...(parsed.data.cwd === undefined ? {} : { cwd: expandHome(parsed.data.cwd, home) }),
        tools: normalizeTools(parsed.data.tools ?? {}),
      };
      continue;
    }
    if (hasUrl) {
      const parsed = httpServerSchema.safeParse(value);
      if (!parsed.success) {
        pushIssues(issues, parsed.error.issues, label);
        continue;
      }
      servers[name] = {
        kind: 'http',
        url: parsed.data.url,
        tools: normalizeTools(parsed.data.tools ?? {}),
      };
      continue;
    }
    issues.push(
      `${label}: expected "command" (stdio, for example "npx") or "url" (HTTP, for example "https://example.com/mcp")`,
    );
  }
  return servers;
}

function parseStore(raw: unknown, home: string, issues: string[]): StoreConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    issues.push(
      'store: expected an object, for example { "type": "sqlite", "path": "~/.twiceshy/actions.db" }',
    );
    return undefined;
  }
  if (raw.type === 'sqlite') {
    const parsed = sqliteStoreSchema.safeParse(raw);
    if (!parsed.success) {
      pushIssues(issues, parsed.error.issues, 'store');
      return undefined;
    }
    return { type: 'sqlite', path: expandHome(parsed.data.path, home) };
  }
  if (raw.type === 'memory') {
    const parsed = memoryStoreSchema.safeParse(raw);
    if (!parsed.success) {
      pushIssues(issues, parsed.error.issues, 'store');
      return undefined;
    }
    return { type: 'memory' };
  }
  issues.push('store.type: expected "sqlite" or "memory", for example "sqlite"');
  return undefined;
}

/** Parses and validates raw config, collecting every problem. */
export function loadConfig(raw: unknown, options: LoadConfigOptions = {}): ProxyConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const issues: string[] = [];

  const expanded = expandEnv(raw, [], env, issues);
  const top = topLevelSchema.safeParse(expanded);
  if (!top.success) {
    pushIssues(issues, top.error.issues, '');
  }
  const servers = parseServers(isRecord(expanded) ? expanded.mcpServers : undefined, home, issues);
  const store = parseStore(isRecord(expanded) ? expanded.store : undefined, home, issues);

  if (!top.success || issues.length > 0) {
    throw new ConfigInvalidError({ issues });
  }
  const data = top.data;
  return {
    store: store ?? { type: 'sqlite', path: expandHome(DEFAULT_STORE_PATH, home) },
    windowMs: parseDuration(data.window ?? '10m'),
    retentionMs: parseDuration(data.retention ?? '7d'),
    onStoreFailure: data.onStoreFailure ?? 'closed',
    toolNaming: data.toolNaming ?? 'prefix',
    trustIdempotentHint: data.trustIdempotentHint ?? true,
    annotateDuplicates: data.annotateDuplicates ?? true,
    exposeRecentActions: data.exposeRecentActions ?? false,
    mcpServers: servers,
  };
}

export function loadConfigFile(path: string, options: LoadConfigOptions = {}): ProxyConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigInvalidError({
      issues: [
        `config: could not read "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
      cause,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigInvalidError({
      issues: [
        `config: "${path}" is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
      cause,
    });
  }
  return loadConfig(raw, options);
}
