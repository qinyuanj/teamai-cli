/**
 * Kimi Code CLI hook injection.
 *
 * Kimi reads hooks from the `[[hooks]]` tables of its user-level `config.toml`
 * (`$KIMI_CODE_HOME/config.toml`, default `~/.kimi-code/config.toml`), so every
 * scope installs there. Commands run through the system shell. A non-zero exit
 * is logged and blocks nothing.
 *
 * The file usually holds provider secrets and hand-written comments, so it is
 * never re-serialized. Blocks whose command starts with `teamai hook-dispatch`
 * are cut out of the text and fresh ones appended. A file is refused when an
 * edit would change anything else it means, or when its tables cannot be
 * mapped back to its text.
 */

import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, stringify as stringifyToml, type TomlTable, type TomlValue } from 'smol-toml';
import { z } from 'zod';
import { BUILTIN_HOOK_SPECS } from './builtin-hooks.js';
import { toolHome } from './tool-home.js';
import { readFileSafe, writeFileAtomic } from './utils/fs.js';
import { log } from './utils/logger.js';

/** Every teamai-managed `[[hooks]]` entry has a command starting with this. */
export const KIMI_HOOK_COMMAND_PREFIX = 'teamai hook-dispatch';

/** The on-disk shape of one teamai `[[hooks]]` entry. Key order is the written order. */
export interface KimiHookEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout: number;
}

/** Kimi's home: the one recorded in `~/.teamai/tool-homes.json`, else `KIMI_CODE_HOME`, else `~/.kimi-code`. */
export function getKimiHome(): string {
  return toolHome('kimi');
}

/** Kimi's user-level config.toml. */
export function getKimiConfigPath(): string {
  return path.join(getKimiHome(), 'config.toml');
}

/** The built-in hooks as Kimi takes them: no shell wrapper or redirect, since Windows runs them through `cmd.exe`. */
export function buildKimiHookEntries(): KimiHookEntry[] {
  return BUILTIN_HOOK_SPECS.map((spec) => {
    const matcher = spec.matcher === '*' ? undefined : spec.matcher;

    const command = `${KIMI_HOOK_COMMAND_PREFIX} ${spec.dispatchEvent} --tool kimi${matcher ? ` --matcher ${matcher}` : ''}`;

    if (matcher) return { event: spec.event, matcher, command, timeout: spec.timeoutSec };

    return { event: spec.event, command, timeout: spec.timeoutSec };
  });
}

const HookCommandSchema = z.object({ command: z.string() });


function isTeamaiHook(entry: TomlValue): boolean {
  const command = HookCommandSchema.safeParse(entry).data?.command;

  return command?.startsWith(KIMI_HOOK_COMMAND_PREFIX) ?? false;
}

/** A `[[hooks]]` header, its name optionally quoted. */
const HOOKS_HEADER_RE = /^\s*\[\[\s*["']?hooks["']?\s*\]\]\s*(#.*)?$/;

/** Any table header: where the block before it ends. */
const ANY_HEADER_RE = /^\s*\[/;


function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();

  return trimmed === '' || trimmed.startsWith('#');
}

/** The document's values without teamai's hooks: what no edit may change. */
function memberContent(doc: TomlTable): TomlTable {
  const { hooks, ...rest } = doc;
  const kept = Array.isArray(hooks) ? hooks.filter((hook) => !isTeamaiHook(hook)) : hooks;

  if (kept === undefined || (Array.isArray(kept) && kept.length === 0)) return rest;

  return { ...rest, hooks: kept };
}

/**
 * The line ranges `[start, end)` of each `[[hooks]]` block, in document order.
 * Throws when the blocks do not match the parsed `hooks` array: an inline array, or text that only looks like a table.
 */
function hookBlocks(hooks: TomlValue[], lines: readonly string[]): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (!HOOKS_HEADER_RE.test(lines[i].trimEnd())) continue;
    let end = i + 1;

    while (end < lines.length && !ANY_HEADER_RE.test(lines[end])) end++;

    // A comment just above the next header documents that header, so it stays with the next block.
    let tail = end;

    while (tail > i + 1 && isBlankOrComment(lines[tail - 1])) tail--;
    const tailHasComment = lines.slice(tail, end).some((line) => line.trim().startsWith('#'));
    blocks.push({ start: i, end: tailHasComment ? tail : end });
  }

  if (blocks.length !== hooks.length) {
    throw new Error(hooks.length > 0 && blocks.length === 0
      ? 'the "hooks" key is an inline array; teamai only manages [[hooks]] tables'
      : 'could not map the "hooks" entries back to [[hooks]] tables');
  }

  return blocks;
}

/** The document without teamai's blocks and without trailing whitespace; each kept line keeps its own line ending. */
function stripTeamaiBlocks(text: string, doc: TomlTable) {
  const hooks = doc.hooks === undefined ? [] : doc.hooks;

  if (!Array.isArray(hooks)) throw new Error('the "hooks" key is not an array');
  const lines = text.split(/(?<=\n)/);
  const blocks = hookBlocks(hooks, lines);
  const drop = new Set<number>();

  hooks.forEach((hook, index) => {
    if (!isTeamaiHook(hook)) return;

    for (let line = blocks[index].start; line < blocks[index].end; line++) drop.add(line);
  });
  const body = lines.filter((_, index) => !drop.has(index)).join('').trimEnd();

  // A document that opened with a teamai block loses the blank lines that followed it.
  return { body: drop.has(0) ? body.replace(/^(?:[ \t]*\r?\n)+/, '') : body, removed: drop.size > 0 };
}

/** The file's text after `action`, or null when it stays as it is. Throws when teamai cannot safely edit it. */
function editedConfig(current: string, action: 'injection' | 'removal'): string | null {
  const doc = parseToml(current);
  const { body, removed } = stripTeamaiBlocks(current, doc);

  if (action === 'removal' && !removed) return null;
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const appendix = action === 'injection' ? stringifyToml({ hooks: buildKimiHookEntries() }).replace(/\n/g, eol) : '';
  let next = body;

  if (appendix) next = body ? `${body}${eol}${eol}${appendix}` : appendix;
  else if (body) next = `${body}${eol}`;

  if (next === current) return null;

  if (!isDeepStrictEqual(memberContent(parseToml(next)), memberContent(doc))) {
    throw new Error('an edit would change entries that are not teamai\'s');
  }

  return next;
}

/** Refresh or remove teamai's hooks, keeping the member's TOML text. A file unsafe to edit is left as it is, with a warning. */
async function updateKimiHooks(action: 'injection' | 'removal'): Promise<void> {
  const configPath = getKimiConfigPath();
  let next: string | null;

  try {
    next = editedConfig((await readFileSafe(configPath)) ?? '', action);
  } catch (e) {
    log.warn(`Skipping Kimi Code hook ${action}: cannot safely update ${configPath}: ${e instanceof Error ? e.message : String(e)}`);

    return;
  }

  if (next === null) return;
  await writeFileAtomic(configPath, next);
  log.success(action === 'injection'
    ? `Injected teamai Kimi Code hooks into ${configPath}`
    : `Removed teamai Kimi Code hooks from ${configPath}`);
}

/** Whether config.toml holds a teamai entry. A file that does not parse falls back to a text scan, so uninstall still lists it. */
export async function hasKimiTeamaiHooks(): Promise<boolean> {
  const current = await readFileSafe(getKimiConfigPath());

  if (!current) return false;

  try {
    const { hooks } = parseToml(current);

    return Array.isArray(hooks) && hooks.some(isTeamaiHook);
  } catch {
    return current.includes(KIMI_HOOK_COMMAND_PREFIX);
  }
}

/** Inject or remove, then check the end state. Throws when a file teamai cannot edit leaves the hooks in the wrong state. */
export async function reconcileKimiHooks(action: 'injection' | 'removal'): Promise<void> {
  await updateKimiHooks(action);

  if (await hasKimiTeamaiHooks() !== (action === 'injection')) {
    throw new Error(`teamai Kimi Code hook ${action} did not take effect in ${getKimiConfigPath()}`);
  }
}
