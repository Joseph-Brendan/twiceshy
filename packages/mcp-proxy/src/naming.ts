import { ConfigInvalidError } from 'twiceshy';

/**
 * Tool naming (C13). In prefix mode the proxy exposes `server__tool`. Every
 * exposed name keeps a route back to its server and tool through the routing
 * map, so calls always reach the right place even for awkward names.
 */

export type ToolNaming = 'prefix' | 'none';

const SEPARATOR = '__';

/** Characters kept as-is. Everything else is encoded. */
const ALLOWED = /^[A-Za-z0-9_.-]$/;

const HEX_RUN = /^[0-9a-fA-F]{4}$/;

function escapeCodeUnit(codeUnit: number): string {
  return `_${codeUnit.toString(16).padStart(4, '0')}`;
}

/**
 * Encodes one name part so the result contains only allowed characters and the
 * encoding is injective: a literal `_` followed by four hex digits is escaped
 * too, so it can never be mistaken for an encoded character. `create_refund`
 * passes through unchanged.
 */
export function encodeNamePart(part: string): string {
  let output = '';
  for (let index = 0; index < part.length; index += 1) {
    const character = part.charAt(index);
    if (character === '_' && HEX_RUN.test(part.slice(index + 1, index + 5))) {
      output += '_005f';
      continue;
    }
    if (ALLOWED.test(character)) {
      output += character;
      continue;
    }
    output += escapeCodeUnit(character.charCodeAt(0));
  }
  return output;
}

/** `server__tool`, with both parts encoded. */
export function prefixToolName(server: string, tool: string): string {
  return `${encodeNamePart(server)}${SEPARATOR}${encodeNamePart(tool)}`;
}

/** A connection as naming needs to see it. */
export interface NamedToolSource {
  name: string;
  tools: readonly { name: string }[];
}

export interface NamedTool {
  server: string;
  toolName: string;
  exposedName: string;
}

export interface ToolRouting {
  entries: NamedTool[];
  byExposedName: ReadonlyMap<string, NamedTool>;
}

function collisions(entries: readonly NamedTool[]): { exposedName: string; servers: string[] }[] {
  const byName = new Map<string, Set<string>>();
  for (const entry of entries) {
    const servers = byName.get(entry.exposedName) ?? new Set<string>();
    servers.add(entry.server);
    byName.set(entry.exposedName, servers);
  }
  return [...byName.entries()]
    .filter(([, servers]) => servers.size > 1)
    .map(([exposedName, servers]) => ({ exposedName, servers: [...servers] }));
}

function collisionError(
  naming: ToolNaming,
  found: readonly { exposedName: string; servers: string[] }[],
): ConfigInvalidError {
  const issues = found.map(
    ({ exposedName, servers }) =>
      `toolNaming "${naming}": the exposed tool name "${exposedName}" comes from both ${servers
        .map((server) => `"${server}"`)
        .join(' and ')}; rename one of the tools or servers`,
  );
  return new ConfigInvalidError({ issues });
}

/**
 * Applies the configured naming and returns both the exposed tools and the
 * route map used to send calls back to the right server. In "none" mode the
 * original names pass through and any clash is CONFIG_INVALID naming both
 * servers (C13). Prefix mode is collision-free for normal names; a rare name
 * combination that would collide is refused the same way rather than routing
 * a call to the wrong server.
 */
export function buildToolRouting(
  connections: readonly NamedToolSource[],
  naming: ToolNaming,
): ToolRouting {
  const entries: NamedTool[] = [];
  for (const connection of connections) {
    for (const tool of connection.tools) {
      entries.push({
        server: connection.name,
        toolName: tool.name,
        exposedName: naming === 'prefix' ? prefixToolName(connection.name, tool.name) : tool.name,
      });
    }
  }
  const found = collisions(entries);
  if (found.length > 0) {
    throw collisionError(naming, found);
  }
  return {
    entries,
    byExposedName: new Map(entries.map((entry) => [entry.exposedName, entry])),
  };
}
