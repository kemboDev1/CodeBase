/**
 * Skills registry (architecture contract §13).
 *
 * Skills are small, on-demand instruction documents. The system prompt only ever
 * carries `skillSummaryPrompt()` (name + description + whenToUse); the full body
 * is disclosed with `renderSkill()` when the model calls `skill.load`.
 *
 * Sources, in load order (first id wins):
 *  1. `backend/src/skills/builtin/*.md`      → id `builtin:<slug>`
 *  2. extra directories (`<userData>/skills`, `<project>/.codebase/skills`)
 *     → `<dir>/<slug>/SKILL.md` and loose `<dir>/*.md`, id `file:<slug>`
 *  3. inline skills already in the store       → their own store id
 *
 * Remote import accepts `https://` only, rejects private/loopback hosts, and caps
 * the payload size (SSRF guard, because the request runs on the user's machine).
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The builtin skills live next to the source in development, but the packaged app
 * runs a single bundled file, so several layouts have to be probed before giving up.
 */
function resolveBuiltinSkillsDir() {
  const candidates = [
    process.env.CODEBASE_BUILTIN_SKILLS_DIR || '',
    path.join(here, 'builtin'), // backend/src/skills/builtin (dev + tests)
    path.join(here, 'skills', 'builtin'), // backend/dist/skills/builtin (bundled)
    path.join(here, '..', 'skills', 'builtin'),
    path.join(here, '..', '..', 'skills', 'builtin'),
    process.resourcesPath ? path.join(process.resourcesPath, 'backend', 'dist', 'skills', 'builtin') : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'backend', 'skills', 'builtin') : ''
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const entries = fsSync.readdirSync(candidate);
      if (entries.some((entry) => entry.toLowerCase().endsWith('.md'))) return candidate;
    } catch {
      /* try the next layout */
    }
  }
  return path.join(here, 'builtin');
}

/** Absolute path of the builtin skills shipped with the app. */
export const BUILTIN_SKILLS_DIR = resolveBuiltinSkillsDir();

/** Maximum accepted size of a skill document (file or remote). */
export const MAX_SKILL_BYTES = 200 * 1024;

/** Directories never scanned for skills. */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'coverage', '.cache']);

/**
 * Lowercase, separator-safe identifier for a skill.
 *
 * @param {unknown} value Raw value (name, file name, ...).
 * @returns {string} Slug, `skill` when nothing usable remains.
 */
export function slugifySkill(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'skill';
}

/**
 * Strip a leading BOM and normalise CRLF/CR line endings to LF.
 *
 * @param {unknown} value Raw text.
 * @returns {string} Normalised text.
 */
export function normalizeText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * Drop one layer of matching quotes.
 *
 * @param {string} value Raw scalar.
 * @returns {string} Unquoted scalar.
 */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Parse a minimal YAML frontmatter block: `key: value` pairs, quotes optional,
 * colons inside values allowed, `|`/`>` block scalars folded to one line.
 *
 * @param {string} text Normalised markdown.
 * @returns {{data: Record<string, string>, body: string, hasFrontmatter: boolean}} Parsed block.
 */
function splitFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { data: {}, body: text, hasFrontmatter: false };
  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '---' || line === '...') {
      end = index;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text, hasFrontmatter: false };

  const data = {};
  let lastKey = '';
  for (const rawLine of lines.slice(1, end)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    if (/^\s+\S/.test(rawLine) && lastKey) {
      // Continuation of the previous scalar; fold to a single line.
      data[lastKey] = `${data[lastKey]} ${rawLine.trim()}`.trim();
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') value = '';
    data[key] = unquote(value);
    lastKey = key;
  }
  return { data, body: lines.slice(end + 1).join('\n'), hasFrontmatter: true };
}

/**
 * Readable form of a frontmatter list value: `[a, b]` → `a, b`.
 *
 * @param {string} value Raw frontmatter value.
 * @returns {string} Value without list brackets.
 */
function plainList(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(part => unquote(part)).filter(Boolean).join(', ');
  }
  return trimmed;
}

/**
 * Guess skill metadata from the markdown body when frontmatter is absent/incomplete.
 *
 * @param {string} body Markdown body.
 * @returns {{name: string, description: string}} Fallbacks (possibly empty strings).
 */
function inferFromBody(body) {
  const lines = body.split('\n');
  let name = '';
  let description = '';
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!name) {
      const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
      if (heading) {
        name = heading[1].trim();
        continue;
      }
    }
    if (!description) {
      const isNoise = !line
        || line.startsWith('#')
        || line.startsWith('>')
        || /^[-*+]\s/.test(line)
        || /^\d+[.)]\s/.test(line)
        || /^([-*_])\1{2,}$/.test(line) // thematic break / stray frontmatter fence
        || /^[A-Za-z0-9_.-]+\s*:\s*\S/.test(line); // stray `key: value` line
      if (isNoise) continue;
      description = line.replace(/\s+/g, ' ').trim();
    }
    if (name && description) break;
  }
  return { name, description };
}

/**
 * Parse a SKILL.md document into skill metadata + body.
 *
 * @param {string} text Raw markdown (frontmatter optional, CRLF tolerated).
 * @param {string} [filePath] Origin path, used for the name fallback and diagnostics.
 * @returns {{name: string, description: string, whenToUse: string, content: string}} Parsed skill fields.
 */
export function parseSkillMarkdown(text, filePath = '') {
  const normalized = normalizeText(text);
  const { data, body } = splitFrontmatter(normalized);
  const inferred = inferFromBody(body);
  const slugFromPath = path.basename(filePath || '').replace(/\.md$/i, '');
  const name = plainList(data.name || data.title || inferred.name || slugFromPath || 'Untitled skill');
  const description = plainList(data.description || inferred.description || '').replace(/\s+/g, ' ').trim();
  const whenToUse = plainList(data.whentouse || data['when-to-use'] || data.when_to_use || '').replace(/\s+/g, ' ').trim();
  return {
    name: name.trim(),
    description,
    whenToUse,
    content: body.replace(/^\n+/, '').trimEnd(),
  };
}

/**
 * Build a store `Skill` object.
 *
 * @param {object} options Options.
 * @param {string} options.id Stable skill id.
 * @param {'inline'|'file'|'builtin'} options.source Skill source.
 * @param {{name: string, description: string, whenToUse: string, content: string}} options.parsed Parsed markdown.
 * @param {string} [options.path] Absolute path for file/builtin skills.
 * @param {boolean} [options.enabled] Whether the skill is active.
 * @param {string} [options.createdAt] ISO timestamp override.
 * @returns {object} Store skill record.
 */
function makeSkill({ id, source, parsed, path: filePath, enabled = true, createdAt }) {
  return {
    id,
    name: parsed.name,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    content: parsed.content,
    enabled,
    source,
    path: filePath,
    createdAt: createdAt || new Date().toISOString(),
  };
}

/**
 * Convert an unknown thrown value into a log message.
 *
 * @param {unknown} error Thrown value.
 * @returns {string} Message.
 */
function message(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  return error.message ? String(error.message) : String(error);
}

/**
 * Read one markdown file into a skill. Never throws.
 *
 * @param {object} options Options.
 * @param {string} options.file Absolute file path.
 * @param {string} options.id Skill id.
 * @param {'file'|'builtin'} options.source Source tag.
 * @param {object} [options.logger] Logger for warnings.
 * @returns {Promise<object|null>} Skill or null.
 */
async function readSkillFile({ file, id, source, logger }) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_SKILL_BYTES) {
      logger?.warn?.(`Skill ${path.basename(file)} skipped: ${stat.size} bytes exceeds the 200 KB limit`);
      return null;
    }
    const text = await fs.readFile(file, 'utf8');
    const parsed = parseSkillMarkdown(text, file);
    if (!parsed.content.trim() && !parsed.description) {
      logger?.warn?.(`Skill ${path.basename(file)} skipped: empty document`);
      return null;
    }
    return makeSkill({ id, source, parsed, path: file, createdAt: new Date(stat.mtimeMs).toISOString() });
  } catch (error) {
    logger?.warn?.(`Skill ${file} skipped: ${message(error)}`);
    return null;
  }
}

/**
 * Discover skills inside one extra directory.
 *
 * Supports `<dir>/<slug>/SKILL.md` and loose `<dir>/<slug>.md` files.
 *
 * @param {object} options Options.
 * @param {string} options.dir Directory to scan.
 * @param {object} [options.logger] Logger.
 * @returns {Promise<object[]>} Discovered file skills.
 */
async function readSkillDir({ dir, logger }) {
  const found = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`Skills directory ${dir} skipped: ${message(error)}`);
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const skillFile = path.join(absolute, 'SKILL.md');
      const skill = await readSkillFile({ file: skillFile, id: `file:${slugifySkill(entry.name)}`, source: 'file', logger });
      if (skill) found.push(skill);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const slug = slugifySkill(entry.name.replace(/\.md$/i, ''));
      const skill = await readSkillFile({ file: absolute, id: `file:${slug}`, source: 'file', logger });
      if (skill) found.push(skill);
    }
  }
  return found;
}

/**
 * Load every skill available to the agent: builtin, then extra directories, then
 * inline skills from the store. Duplicate ids keep the first occurrence.
 *
 * @param {object} options Options.
 * @param {string[]} [options.dirs] Extra skill directories (missing ones are ignored).
 * @param {object} [options.store] Live store object with `skills`.
 * @param {object} [options.logger] Logger.
 * @returns {Promise<object[]>} Merged skill list.
 */
export async function loadSkills({ dirs = [], store, logger } = {}) {
  const byId = new Map();
  const add = (skill) => {
    if (!skill || !skill.id) return;
    if (byId.has(skill.id)) {
      logger?.debug?.(`Skill id "${skill.id}" already loaded; keeping the first one`);
      return;
    }
    byId.set(skill.id, skill);
  };

  // 1. Builtin skills, resolved relative to this module.
  try {
    const entries = await fs.readdir(BUILTIN_SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const slug = slugifySkill(entry.name.replace(/\.md$/i, ''));
      add(await readSkillFile({
        file: path.join(BUILTIN_SKILLS_DIR, entry.name),
        id: `builtin:${slug}`,
        source: 'builtin',
        logger,
      }));
    }
  } catch (error) {
    logger?.warn?.(`Builtin skills unavailable: ${message(error)}`);
  }

  // 2. Extra directories (user data, project-local).
  for (const dir of (Array.isArray(dirs) ? dirs : [dirs])) {
    if (typeof dir !== 'string' || !dir.trim()) continue;
    for (const skill of await readSkillDir({ dir: path.resolve(dir), logger })) add(skill);
  }

  // 3. Inline skills already persisted in the store.
  const stored = Array.isArray(store?.skills) ? store.skills : [];
  for (const record of stored) {
    if (!record || typeof record !== 'object') continue;
    if (record.source === 'builtin' || (typeof record.path === 'string' && record.path)) {
      // Seeded copies of disk skills: their file/builtin version is authoritative.
      continue;
    }
    const content = typeof record.content === 'string' ? record.content : '';
    if (!content.trim() && !record.name) continue;
    add({
      id: record.id || `inline:${slugifySkill(record.name)}`,
      name: record.name || 'Untitled skill',
      description: record.description || '',
      whenToUse: record.whenToUse || '',
      content: normalizeText(content).trim(),
      enabled: record.enabled !== false,
      source: 'inline',
      path: undefined,
      createdAt: record.createdAt || new Date().toISOString(),
    });
  }

  const skills = [...byId.values()];
  logger?.debug?.(`Loaded ${skills.length} skill(s)`);
  return skills;
}

/**
 * Validate and normalise a remote skill URL.
 *
 * @param {string} value URL candidate.
 * @returns {URL} Parsed URL.
 */
function parseRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid skill URL: ${value}`);
  }
  if (url.protocol !== 'https:') throw new Error('Only https:// URLs can be imported');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('The URL has no host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Refusing to fetch a local host: ${host}`);
  }
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) {
    throw new Error(`Refusing to fetch a private address: ${host}`);
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    const isPrivate = a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
    if (isPrivate) throw new Error(`Refusing to fetch a private address: ${host}`);
  }
  return url;
}

/**
 * Download a skill from an https URL with a hard size cap.
 *
 * @param {string} from Remote URL.
 * @returns {Promise<{text: string, path: undefined}>} Fetched markdown.
 */
async function fetchRemote(from) {
  const url = parseRemoteUrl(from);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1', 'User-Agent': 'CodeBase-Agent' },
    });
    if (!response.ok) throw new Error(`Remote skill returned HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_SKILL_BYTES) throw new Error(`Remote skill is too large (${declared} bytes, limit 200 KB)`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) {
      throw new Error('Remote skill is too large (limit 200 KB)');
    }
    return { text, path: undefined };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Import one skill from a local directory, a local `.md` file, or an https URL.
 *
 * @param {object} options Options.
 * @param {string} options.from Directory path, `.md` file path, or https URL.
 * @param {object} [options.store] Live store object (used only for diagnostics).
 * @param {object} [options.logger] Logger.
 * @returns {Promise<object>} The imported skill (`source: 'file'`, `enabled: true`).
 */
export async function importSkill({ from, logger } = {}) {
  if (typeof from !== 'string' || !from.trim()) throw new Error('importSkill requires a path or https URL');
  const source = from.trim();

  let text;
  let filePath;
  let slugHint;

  if (/^https?:\/\//i.test(source)) {
    if (!/^https:\/\//i.test(source)) throw new Error('Only https:// URLs can be imported');
    const remote = await fetchRemote(source);
    text = remote.text;
    filePath = undefined;
    slugHint = path.basename(new URL(source).pathname || '').replace(/\.md$/i, '') || 'remote-skill';
  } else {
    const absolute = path.resolve(source);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      throw new Error(`Skill path not found: ${absolute}`);
    }
    if (stat.isDirectory()) {
      filePath = path.join(absolute, 'SKILL.md');
      try {
        const inner = await fs.stat(filePath);
        if (!inner.isFile()) throw new Error('not a file');
        if (inner.size > MAX_SKILL_BYTES) throw new Error(`Skill is too large (${inner.size} bytes, limit 200 KB)`);
      } catch (error) {
        if (String(error?.message || '').includes('too large')) throw error;
        throw new Error(`No SKILL.md found in ${absolute}`);
      }
      slugHint = path.basename(absolute);
    } else if (stat.isFile()) {
      if (!absolute.toLowerCase().endsWith('.md')) throw new Error(`Not a markdown file: ${absolute}`);
      if (stat.size > MAX_SKILL_BYTES) throw new Error(`Skill is too large (${stat.size} bytes, limit 200 KB)`);
      filePath = absolute;
      slugHint = path.basename(absolute).replace(/\.md$/i, '');
    } else {
      throw new Error(`Unsupported skill source: ${absolute}`);
    }
    text = await fs.readFile(filePath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) {
      throw new Error('Skill is too large (limit 200 KB)');
    }
  }

  const parsed = parseSkillMarkdown(text, slugHint || '');
  if (!parsed.content.trim() && !parsed.description) throw new Error('The skill document is empty');
  const id = `file:${slugifySkill(parsed.name || slugHint)}`;
  logger?.info?.(`Imported skill "${parsed.name}" from ${filePath || source}`);
  return makeSkill({ id, source: 'file', parsed, path: filePath, enabled: true });
}

/**
 * One compact line per skill for the system prompt (progressive disclosure).
 *
 * @param {object[]} skills Skills to advertise.
 * @param {number} [max] Maximum number of skills to include.
 * @returns {string} Prompt block, or an empty string when there is nothing to show.
 */
export function skillSummaryPrompt(skills, max = 40) {
  const list = (Array.isArray(skills) ? skills : [])
    .filter(skill => skill && skill.enabled !== false)
    .slice(0, max);
  if (!list.length) return '';
  const lines = list.map((skill) => {
    const id = skill.id || `inline:${slugifySkill(skill.name)}`;
    const description = String(skill.description || '').replace(/\s+/g, ' ').trim();
    const when = String(skill.whenToUse || '').replace(/\s+/g, ' ').trim();
    const head = `- ${id} — ${skill.name || 'Untitled skill'}${description ? `: ${description}` : ''}`;
    return when ? `${head}\n  use when: ${when}` : head;
  });
  return [
    'Available skills (call skill.load with the id to read the full procedure before doing the work):',
    ...lines,
  ].join('\n');
}

/**
 * Full skill body for `skill.load`, with a compact header for the model.
 *
 * @param {object} skill Skill record.
 * @returns {string} Rendered markdown.
 */
export function renderSkill(skill) {
  if (!skill || typeof skill !== 'object') throw new Error('renderSkill requires a skill');
  const id = skill.id || `inline:${slugifySkill(skill.name)}`;
  const header = [`# ${skill.name || 'Untitled skill'}`, `id: ${id}`, `source: ${skill.source || 'inline'}`];
  if (skill.description) header.push(`description: ${skill.description}`);
  if (skill.whenToUse) header.push(`use when: ${skill.whenToUse}`);
  if (skill.path) header.push(`path: ${skill.path}`);
  const body = normalizeText(skill.content || '').trim();
  return `${header.join('\n')}\n\n${body}`.trimEnd();
}
