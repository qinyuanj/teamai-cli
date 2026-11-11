import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from '../utils/logger.js';
import {
  getKimiHome,
  getKimiConfigPath,
  buildKimiHookEntries,
  hasKimiTeamaiHooks,
  reconcileKimiHooks,
  KIMI_HOOK_COMMAND_PREFIX,
} from '../kimi-hooks.js';
import { injectHooksToAllTools, reconcileHooksToAllTools } from '../hooks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-test-'));
  vi.stubEnv('KIMI_CODE_HOME', tmpDir);
  vi.mocked(log.warn).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// teamai's own entry points: pull injects, uninstall removes. Each throws when its result does not hold.
const inject = () => reconcileKimiHooks('injection');
const remove = () => reconcileKimiHooks('removal');

function configPath(): string {
  return path.join(tmpDir, 'config.toml');
}
function readConfig(): string {
  return fs.readFileSync(configPath(), 'utf-8');
}
function parsedHooks(): Array<Record<string, unknown>> {
  const doc = parseToml(readConfig()) as { hooks?: Array<Record<string, unknown>> };
  return doc.hooks ?? [];
}

// A realistic user config: comments, a provider secret, and the user's own hook.
// The secret must survive untouched (we never rewrite user content).
const USER_CONFIG = `# Kimi Code CLI config
default_model = "kimi-k2"

[providers.moonshot]
type = "kimi"
base_url = "https://api.moonshot.cn/v1"
api_key = "sk-user-secret-do-not-touch"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "my-guard --check"
timeout = 5
`;

// ─── home / paths ─────────────────────────────────────────────────────────────

describe('getKimiHome', () => {
  it('honours KIMI_CODE_HOME when set', () => {
    expect(getKimiHome()).toBe(path.resolve(tmpDir));
  });

  it('falls back to ~/.kimi-code', () => {
    vi.stubEnv('KIMI_CODE_HOME', '');
    vi.stubEnv('HOME', tmpDir);
    vi.stubEnv('USERPROFILE', tmpDir);
    expect(getKimiHome()).toBe(path.join(tmpDir, '.kimi-code'));
  });

  it('follows the home recorded in ~/.teamai/tool-homes.json when the shell does not move it', () => {
    const moved = path.join(tmpDir, 'kimi-moved');
    fs.mkdirSync(path.join(tmpDir, '.teamai'));
    fs.writeFileSync(path.join(tmpDir, '.teamai', 'tool-homes.json'), JSON.stringify({ kimi: moved }));
    vi.stubEnv('KIMI_CODE_HOME', '');
    vi.stubEnv('HOME', tmpDir);
    vi.stubEnv('USERPROFILE', tmpDir);
    expect(getKimiHome()).toBe(moved);
  });

  it('getKimiConfigPath points at <home>/config.toml', () => {
    expect(getKimiConfigPath()).toBe(configPath());
  });
});

// ─── entry shape ──────────────────────────────────────────────────────────────

describe('buildKimiHookEntries', () => {
  it('produces the four built-in hooks with exactly the fields kimi accepts', () => {
    const entries = buildKimiHookEntries();
    expect(entries).toHaveLength(4);
    for (const e of entries) {
      const keys = Object.keys(e).sort();
      const expectedKeys = e.matcher === undefined
        ? ['command', 'event', 'timeout']
        : ['command', 'event', 'matcher', 'timeout'];
      expect(keys).toEqual(expectedKeys);
      expect(e.timeout).toBeGreaterThanOrEqual(1);
      expect(e.timeout).toBeLessThanOrEqual(600);
      expect(Number.isInteger(e.timeout)).toBe(true);
      expect(e.command.startsWith(KIMI_HOOK_COMMAND_PREFIX)).toBe(true);
      // kimi spawns hooks through the system shell (cmd.exe on Windows), so
      // the command must be shell-neutral: no bash wrapper, no POSIX redirects.
      expect(e.command).not.toMatch(/bash|\/dev\/null|\|\|/);
      expect(e.command).toContain('--tool kimi');
    }
  });

  it('maps events, matchers and timeouts per issue #5', () => {
    const entries = buildKimiHookEntries();
    expect(entries).toEqual([
      { event: 'SessionStart', command: 'teamai hook-dispatch session-start --tool kimi', timeout: 15 },
      { event: 'Stop', command: 'teamai hook-dispatch stop --tool kimi', timeout: 15 },
      { event: 'PostToolUse', command: 'teamai hook-dispatch post-tool-use --tool kimi', timeout: 10 },
      { event: 'UserPromptSubmit', command: 'teamai hook-dispatch prompt-submit --tool kimi', timeout: 10 },
    ]);
  });
});

// ─── reconcile ────────────────────────────────────────────────────────────────

describe('reconcileKimiHooks', () => {
  it('accepts an injection that is already in place', async () => {
    await inject();
    await expect(reconcileKimiHooks('injection')).resolves.toBeUndefined();
  });

  it('throws when the config cannot take the hooks', async () => {
    fs.writeFileSync(configPath(), 'hooks = []\n');
    await expect(reconcileKimiHooks('injection')).rejects.toThrow(/did not take effect/);
    expect(readConfig()).toBe('hooks = []\n');
  });

  it('throws when teamai entries are left in a config that does not parse', async () => {
    const broken = '[[hooks]]\ncommand = "teamai hook-dispatch stop --tool kimi"\nevent = \n';
    fs.writeFileSync(configPath(), broken);
    await expect(reconcileKimiHooks('removal')).rejects.toThrow(/did not take effect/);
    expect(readConfig()).toBe(broken);
  });
});

// ─── inject ───────────────────────────────────────────────────────────────────

describe('injecting Kimi hooks', () => {
  it('creates config.toml with four [[hooks]] entries when none exists', async () => {
    await inject();
    const hooks = parsedHooks();
    expect(hooks).toHaveLength(4);
    expect(hooks).toEqual(buildKimiHookEntries());
  });

  it('appends to an existing config without touching user content', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await inject();
    const text = readConfig();
    expect(text.startsWith(USER_CONFIG)).toBe(true);
    expect(text).toContain('api_key = "sk-user-secret-do-not-touch"');
    const hooks = parsedHooks();
    expect(hooks).toHaveLength(5);
    expect(hooks[0]).toEqual({ event: 'PreToolUse', matcher: 'Bash', command: 'my-guard --check', timeout: 5 });
    expect(hooks.slice(1)).toEqual(buildKimiHookEntries());
  });

  it('is idempotent: a second run is a byte-for-byte no-op', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await inject();
    const first = readConfig();
    await inject();
    expect(readConfig()).toBe(first);
    expect(parsedHooks()).toHaveLength(5);
  });

  it('replaces stale teamai entries instead of duplicating them', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG + `
[[hooks]]
event = "Stop"
command = "teamai hook-dispatch stop --tool kimi --legacy-flag"
timeout = 30

[[hooks]]
event = "Notification"
command = "echo user-hook-after"
`);
    await inject();
    const hooks = parsedHooks();
    const teamai = hooks.filter(h => String(h.command).startsWith(KIMI_HOOK_COMMAND_PREFIX));
    expect(teamai).toEqual(buildKimiHookEntries());
    expect(hooks.filter(h => h.event === 'Notification')).toHaveLength(1);
    expect(hooks.filter(h => h.matcher === 'Bash')).toHaveLength(1);
    expect(readConfig()).not.toContain('--legacy-flag');
  });

  it('refuses to touch a config that does not parse', async () => {
    const broken = 'default_model = "kimi-k2\n[[hooks]\n';
    fs.writeFileSync(configPath(), broken);
    await expect(inject()).rejects.toThrow(/did not take effect/);
    expect(readConfig()).toBe(broken);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('config.toml'));
  });

  it('refuses when hooks is declared as an inline static array', async () => {
    const inline = 'hooks = [{ event = "Stop", command = "echo hi" }]\n';
    fs.writeFileSync(configPath(), inline);
    await expect(inject()).rejects.toThrow(/did not take effect/);
    expect(readConfig()).toBe(inline);
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps CRLF line endings when the existing config uses them', async () => {
    const crlf = USER_CONFIG.replace(/\n/g, '\r\n');
    fs.writeFileSync(configPath(), crlf);
    await inject();
    const text = readConfig();
    expect(text.startsWith(crlf)).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(parsedHooks()).toHaveLength(5);
    await inject();
    expect(readConfig()).toBe(text);
    await remove();
    expect(readConfig()).toBe(crlf);
  });

  it('recognizes quoted [[hooks]] headers', async () => {
    fs.writeFileSync(configPath(), "[['hooks']]\nevent = \"Stop\"\ncommand = \"echo bye\"\n");
    await inject();
    expect(parsedHooks()).toHaveLength(5);
    await remove();
    expect(parsedHooks()).toEqual([{ event: 'Stop', command: 'echo bye' }]);
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe('injecting Kimi hooks keeps the bytes of the member', () => {
  it('keeps every line ending of a file that mixes CRLF and LF', async () => {
    const mixed = '# first\r\ndefault_model = "kimi-k2"\n\n[thinking]\r\nmode = "auto"\n';
    fs.writeFileSync(configPath(), mixed);
    await inject();
    const first = readConfig();
    expect(first.startsWith(mixed.trimEnd())).toBe(true);
    await inject();
    expect(readConfig()).toBe(first);
    await remove();
    expect(readConfig().trimEnd()).toBe(mixed.trimEnd());
  });

  it('keeps the mode of a config that holds secrets', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG, { mode: 0o600 });
    fs.chmodSync(configPath(), 0o640);
    await inject();
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o640);
  });

  it('refuses a teamai block whose sub-table a text edit would orphan', async () => {
    const nested = '[[hooks]]\nevent = "Stop"\ncommand = "teamai hook-dispatch stop --tool kimi"\n\n[hooks.extra]\nkeep = "yes"\n';
    fs.writeFileSync(configPath(), nested);
    await inject();
    expect(readConfig()).toBe(nested);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('config.toml'));
  });

  it('refuses a multi-line string that looks like a hooks table', async () => {
    const tricky = 'note = """\n[[hooks]]\n"""\n';
    fs.writeFileSync(configPath(), tricky);
    await expect(inject()).rejects.toThrow(/did not take effect/);
    expect(readConfig()).toBe(tricky);
  });
});

describe('removing Kimi hooks', () => {
  it('removes exactly the teamai entries and leaves valid TOML', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await inject();
    await remove();
    const text = readConfig();
    expect(text).not.toContain(KIMI_HOOK_COMMAND_PREFIX);
    expect(text).toContain('api_key = "sk-user-secret-do-not-touch"');
    expect(parsedHooks()).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: 'my-guard --check', timeout: 5 },
    ]);
  });

  it('keeps user hooks that sit after the teamai entries', async () => {
    await inject();
    fs.appendFileSync(configPath(), '\n[[hooks]]\nevent = "Stop"\ncommand = "echo bye"\n');
    await remove();
    expect(parsedHooks()).toEqual([{ event: 'Stop', command: 'echo bye' }]);
  });

  it('is a no-op when config.toml is missing or has no teamai entries', async () => {
    await remove();
    expect(fs.existsSync(configPath())).toBe(false);
    fs.writeFileSync(configPath(), USER_CONFIG);
    await remove();
    expect(readConfig()).toBe(USER_CONFIG);
  });

  it('leaves an empty document when teamai hooks were the only content', async () => {
    await inject();
    await remove();
    expect(readConfig()).toBe('');
    expect(parseToml(readConfig())).toEqual({});
  });

  it('keeps a comment that documents the user block following a teamai block', async () => {
    await inject();
    fs.appendFileSync(configPath(), '\n# my own stop hook\n[[hooks]]\nevent = "Stop"\ncommand = "echo bye"\n');
    await remove();
    expect(readConfig()).toBe('# my own stop hook\n[[hooks]]\nevent = "Stop"\ncommand = "echo bye"\n');
  });
});

describe('hasKimiTeamaiHooks', () => {
  it('reports whether teamai entries are present', async () => {
    expect(await hasKimiTeamaiHooks()).toBe(false);
    fs.writeFileSync(configPath(), USER_CONFIG);
    expect(await hasKimiTeamaiHooks()).toBe(false);
    await inject();
    expect(await hasKimiTeamaiHooks()).toBe(true);
  });
});

// ─── reconcile / inject wiring ────────────────────────────────────────────────

describe('hooks reconcile — kimi branch', () => {
  // Kimi's toolPaths entry only carries `skills`; the hooks reconciler ignores it.
  const toolPaths: Record<string, { settings?: string }> = { kimi: {} };
  let baseDir: string;
  let manifest: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-base-'));
    manifest = path.join(baseDir, 'managed-hooks.json');
  });
  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('installs into the kimi user config when the kimi home exists', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, {});
    expect(parsedHooks()).toHaveLength(5);
    // Nothing is written under baseDir: kimi hooks are user-level regardless of scope.
    expect(fs.readdirSync(baseDir)).toEqual([]);
  });

  it('does not create a kimi home for users without Kimi Code CLI', async () => {
    const missing = path.join(tmpDir, 'not-installed');
    vi.stubEnv('KIMI_CODE_HOME', missing);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, {});
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('warns when kimi is enabled but the kimi home is missing (issue #12)', async () => {
    const missing = path.join(tmpDir, 'not-installed');
    vi.stubEnv('KIMI_CODE_HOME', missing);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { filterAgents: ['kimi'] });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      `Kimi Code hooks skipped: ${missing} does not exist (run Kimi Code once, then re-run teamai pull)`,
    );
    expect(fs.existsSync(missing)).toBe(false);
  });

  function kimiSkipWarnings(): string[] {
    return vi.mocked(log.warn).mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('Kimi Code hooks skipped'));
  }

  it('stays quiet when kimi is not a target and its home is missing', async () => {
    vi.stubEnv('KIMI_CODE_HOME', path.join(tmpDir, 'not-installed'));
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, {});
    expect(kimiSkipWarnings()).toEqual([]);
  });

  it('a project .kimi-code dir alone (e.g. committed to the repo) does not trigger the warning', async () => {
    vi.stubEnv('KIMI_CODE_HOME', path.join(tmpDir, 'not-installed'));
    const projectRoot = path.join(baseDir, 'project');
    fs.mkdirSync(path.join(projectRoot, '.kimi-code'), { recursive: true });
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { installedBaseDir: projectRoot });
    expect(kimiSkipWarnings()).toEqual([]);
  });

  it('reports a missing kimi home once per run, even across scopes', async () => {
    vi.stubEnv('KIMI_CODE_HOME', path.join(tmpDir, 'not-installed'));
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { filterAgents: ['kimi'] });
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { filterAgents: ['kimi'] });
    expect(kimiSkipWarnings()).toHaveLength(1);
  });

  it('a filter widened from disabledAgents is not an explicit kimi choice', async () => {
    vi.stubEnv('KIMI_CODE_HOME', path.join(tmpDir, 'not-installed'));
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, {
      filterAgents: ['claude', 'kimi'],
      explicitAgents: [],
    });
    expect(kimiSkipWarnings()).toEqual([]);
  });

  it('injectHooksToAllTools (legacy path) warns when kimi is requested but its home is missing', async () => {
    const missing = path.join(tmpDir, 'not-installed');
    vi.stubEnv('KIMI_CODE_HOME', missing);
    await injectHooksToAllTools(toolPaths, baseDir, ['kimi']);
    expect(kimiSkipWarnings()).toHaveLength(1);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('removeAll strips the teamai entries and keeps the user ones', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, {});
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { removeAll: true });
    expect(parsedHooks()).toHaveLength(1);
    expect(readConfig()).not.toContain(KIMI_HOOK_COMMAND_PREFIX);
  });

  it('settingsOnly sweeps skip kimi (global adapter, no baseDir)', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { removeAll: true, settingsOnly: true });
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { settingsOnly: true });
    expect(readConfig()).toBe(USER_CONFIG);
  });

  it('filterAgents excluding kimi leaves the config untouched', async () => {
    fs.writeFileSync(configPath(), USER_CONFIG);
    await reconcileHooksToAllTools(toolPaths, baseDir, [], manifest, { filterAgents: ['claude'] });
    expect(readConfig()).toBe(USER_CONFIG);
  });

  it('injectHooksToAllTools (legacy pull path) also installs kimi hooks', async () => {
    await injectHooksToAllTools(toolPaths, baseDir);
    expect(parsedHooks()).toHaveLength(4);
  });
});
