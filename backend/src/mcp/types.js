/**
 * MCP shared typedefs and small pure helpers (ARCHITECTURE.md §11).
 *
 * This module has no side effects and imports nothing: it is the lowest layer of
 * `backend/src/mcp/` and is safe to import from clients, managers and tests.
 */

/** JSON value used by JSON-RPC payloads. @typedef {any} JsonValue */

/**
 * One MCP tool as reported by `tools/list`.
 * @typedef {object} McpTool
 * @property {string} name
 * @property {string} [title]
 * @property {string} [description]
 * @property {object} [inputSchema]  JSON Schema (object root)
 */

/**
 * One MCP resource as reported by `resources/list`.
 * @typedef {object} McpResource
 * @property {string} uri
 * @property {string} [name]
 * @property {string} [description]
 * @property {string} [mimeType]
 */

/**
 * One MCP prompt as reported by `prompts/list`.
 * @typedef {object} McpPrompt
 * @property {string} name
 * @property {string} [description]
 * @property {{name: string, description?: string, required?: boolean}[]} [arguments]
 */

/**
 * One entry of a `tools/call` `content[]` array.
 * @typedef {object} McpContentPart
 * @property {string} type
 * @property {string} [text]
 * @property {string} [data]
 * @property {string} [mimeType]
 * @property {string} [uri]
 */

/**
 * Result of `tools/call`.
 * @typedef {object} McpToolCallResult
 * @property {McpContentPart[]} content
 * @property {boolean} [isError]
 * @property {object} [structuredContent]
 */

/**
 * Minimal server descriptor consumed by `McpClient` / `createMcpManager`
 * (the persisted shape is `McpServer` in the store, §3).
 * @typedef {object} McpServerConfig
 * @property {string} [id]
 * @property {string} name
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 * @property {string} [cwd]
 * @property {boolean} [enabled]
 * @property {boolean} [autoStart]
 * @property {'stdio'} [transport]
 */

/**
 * Live MCP server status.
 * @typedef {'stopped'|'starting'|'ready'|'error'|'crashed'} McpStatus
 */

/** Largest text blob appended into a tool result before truncation. */
const MAX_FLAT_TEXT = 20_000;
/** Longest slug produced by {@link slugify}. */
const MAX_SLUG = 60;

/**
 * Turn a human readable name into a safe identifier fragment:
 * lower-case, non-alphanumerics collapsed into `_`, max 60 characters.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  const raw = typeof name === 'string' ? name : String(name ?? '');
  const slug = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  const capped = slug.slice(0, MAX_SLUG);
  // Never end on a separator after truncation.
  return capped.replace(/_+$/g, '');
}

/**
 * Canonical registry name of an MCP tool: `mcp__<slug(server)>__<slug(tool)>`.
 * @param {McpServerConfig|string} server Server descriptor or server name.
 * @param {{name: string}|string} tool Tool descriptor or tool name.
 * @returns {string}
 */
export function toolNameFor(server, tool) {
  const serverName = typeof server === 'string' ? server : server?.name;
  const toolName = typeof tool === 'string' ? tool : tool?.name;
  const serverSlug = slugify(serverName) || 'server';
  const toolSlug = slugify(toolName) || 'tool';
  return `mcp__${serverSlug}__${toolSlug}`.slice(0, MAX_SLUG * 2 + 6);
}

/**
 * Flatten an MCP `content[]` array into plain text.
 * `type:'text'` parts are joined with `\n`; non-text parts are rendered as a
 * short placeholder so the model still learns that they exist.
 * @param {unknown} contentArray
 * @param {{maxLength?: number}} [options]
 * @returns {string}
 */
export function flattenContent(contentArray, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) ? Number(options.maxLength) : MAX_FLAT_TEXT;
  if (!Array.isArray(contentArray)) return '';
  const parts = [];
  for (const part of contentArray) {
    const line = contentPartToText(part);
    if (line) parts.push(line);
  }
  return truncate(parts.join('\n'), maxLength);
}

/**
 * Render a single MCP content part as text.
 * @param {unknown} part
 * @returns {string}
 */
export function contentPartToText(part) {
  if (part === null || part === undefined) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object') return stringifyValue(part);
  const record = /** @type {Record<string, any>} */ (part);
  if (typeof record.text === 'string') return record.text;
  if (record.type === 'image') {
    const mime = typeof record.mimeType === 'string' ? record.mimeType : 'image';
    return `[image: ${mime}]`;
  }
  if (record.type === 'audio') {
    const mime = typeof record.mimeType === 'string' ? record.mimeType : 'audio';
    return `[audio: ${mime}]`;
  }
  if (record.type === 'resource' && record.resource && typeof record.resource === 'object') {
    const uri = record.resource.uri ?? 'resource';
    if (typeof record.resource.text === 'string') return `[resource ${uri}]\n${record.resource.text}`;
    return `[resource ${uri}]`;
  }
  if (typeof record.uri === 'string') return `[resource ${record.uri}]`;
  if (record.type) return `[${String(record.type)}]`;
  return stringifyValue(record);
}

/**
 * Unwrap a JSON-RPC `tools/call` result into `{ content, isError }`,
 * tolerating servers that answer with a bare content array.
 * @param {unknown} result
 * @returns {{ content: McpContentPart[], isError: boolean }}
 */
export function parseToolResult(result) {
  if (Array.isArray(result)) return { content: /** @type {any} */ (result), isError: false };
  const record = result && typeof result === 'object' ? /** @type {Record<string, any>} */ (result) : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const isError = record.isError === true;
  const parts = content.length || typeof record.text !== 'string'
    ? content
    : [{ type: 'text', text: record.text }];
  return { content: /** @type {any} */ (parts), isError };
}

/**
 * Truncate a string, appending a marker when something was cut.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(text, maxLength) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : MAX_FLAT_TEXT;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`;
}

/**
 * `JSON.stringify` that never throws (cycles, BigInt, functions).
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
export function stringifyValue(value, maxLength) {
  try {
    if (typeof value === 'string') return truncate(value, maxLength ?? MAX_FLAT_TEXT);
    const json = JSON.stringify(value);
    if (typeof json === 'string') return truncate(json, maxLength ?? MAX_FLAT_TEXT);
  } catch {
    // Fall through to String() for cyclic structures.
  }
  try {
    return truncate(String(value), maxLength ?? MAX_FLAT_TEXT);
  } catch {
    return '[unserializable]';
  }
}

export const MCP_LIMITS = Object.freeze({ MAX_FLAT_TEXT, MAX_SLUG });
