import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { expect, it } from 'vitest';
import YAML from 'yaml';
import { commitTeamRepo } from '../helpers/team-repo-history.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

const MEMBER_CONFIG = [
  '# my Kimi config',
  'default_model = "kimi-k2"',
  '',
  '[providers.moonshot]',
  'api_key = "sk-test-not-a-real-key"',
  '',
  '# my own guard',
  '[[hooks]]',
  'event = "PreToolUse"',
  'command = "my-guard --check"',
  '',
].join('\r\n');

const KIMI_CHECK = /^teamai hooks in Kimi Code config/;

it('manages teamai hooks in a moved Kimi home through pull, hooks, doctor and uninstall', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-hooks-'));

  try {
    const home = path.join(root, 'home');
    const kimiHome = path.join(root, 'moved-kimi');
    const seed = path.join(root, 'seed');
    const repo = path.join(home, '.teamai/team-repo');

    for (const dir of [seed, path.dirname(repo), kimiHome]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'kimi-hooks', repo: seed, provider: 'git', usageReport: false }));
    commitTeamRepo(seed);
    execFileSync('git', ['clone', '-q', seed, repo]);
    fs.writeFileSync(path.join(home, '.teamai/config.yaml'), YAML.stringify({ repo: { localPath: repo, remote: seed }, username: 'tester', scope: 'user', autoUpdate: false }));
    const configFile = path.join(kimiHome, 'config.toml');

    fs.writeFileSync(configFile, MEMBER_CONFIG);
    const env = { ...process.env, HOME: home, USERPROFILE: home, KIMI_CODE_HOME: kimiHome, FORCE_COLOR: '0', NO_COLOR: '1' };
    const run = (args: string[], input?: string) => spawnSync(process.execPath, [cli, ...args], { cwd: home, env, encoding: 'utf8', input });
    const read = () => fs.readFileSync(configFile, 'utf8');

    const doctorCheck = () => {
      const report = JSON.parse(run(['doctor', '--json']).stdout) as { checks: Array<{ name: string; ok: boolean }> };

      return report.checks.find((check) => KIMI_CHECK.test(check.name));
    };

    // Pull keeps the member's bytes, in the moved home only, and a second pull changes nothing.
    const pull = run(['pull', '--force']);

    expect(pull.status, pull.stdout + pull.stderr).toBe(0);
    const pulled = read();

    expect(pulled.startsWith(MEMBER_CONFIG.trimEnd())).toBe(true);
    expect(pulled).not.toMatch(/[^\r]\n/);
    expect(fs.existsSync(path.join(home, '.kimi-code'))).toBe(false);
    const { hooks } = parseToml(pulled) as { hooks: Array<{ event: string; matcher?: string; command: string; timeout?: number }> };

    expect(hooks).toEqual([
      { event: 'PreToolUse', command: 'my-guard --check' },
      { event: 'SessionStart', command: 'teamai hook-dispatch session-start --tool kimi', timeout: 15 },
      { event: 'Stop', command: 'teamai hook-dispatch stop --tool kimi', timeout: 15 },
      { event: 'PostToolUse', command: 'teamai hook-dispatch post-tool-use --tool kimi', timeout: 10 },
      { event: 'PostToolUse', matcher: 'TodoList', command: 'teamai hook-dispatch post-tool-use --tool kimi --matcher TodoList', timeout: 3 },
      { event: 'UserPromptSubmit', command: 'teamai hook-dispatch prompt-submit --tool kimi', timeout: 10 },
    ]);
    expect(run(['pull', '--force']).status).toBe(0);
    expect(read()).toBe(pulled);

    // `hooks list` shows what is on disk, and doctor agrees.
    const list = run(['hooks', 'list']);

    expect(list.status, list.stdout + list.stderr).toBe(0);
    expect(list.stdout).toContain(configFile.replace(home, '~'));
    for (const { command } of hooks.slice(1)) expect(list.stdout).toContain(command.replace('--tool kimi', '--tool <tool>'));
    expect(list.stdout).toContain('PostToolUse [TodoList]');
    expect(doctorCheck()?.ok).toBe(true);

    // The dispatch answers the shape Kimi sends: a todo call under its own name, a prompt in parts.
    const todo = run(['hook-dispatch', 'post-tool-use', '--tool', 'kimi', '--matcher', 'TodoList'], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'kimi-e2e', cwd: home, tool_name: 'TodoList', tool_input: { todos: [] } }));

    expect(todo.status, todo.stderr).toBe(0);
    expect(run(['hook-dispatch', 'prompt-submit', '--tool', 'kimi'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'kimi-e2e', cwd: home, prompt: [{ type: 'text', text: 'hello' }] })).status).toBe(0);

    // A file teamai cannot edit stays as it is, with a warning.
    const inline = 'hooks = [{ event = "Stop", command = "echo hi" }]\n';

    fs.writeFileSync(configFile, inline);
    const refused = run(['hooks', 'inject']);

    expect(refused.stdout + refused.stderr).toContain('cannot safely update');
    expect(fs.readFileSync(configFile, 'utf8')).toBe(inline);
    expect(doctorCheck()?.ok).toBe(false);

    // Uninstall takes teamai's entries and nothing else.
    fs.writeFileSync(configFile, pulled);
    const uninstall = run(['uninstall', '--force']);

    expect(uninstall.status, uninstall.stdout + uninstall.stderr).toBe(0);
    const left = read();

    expect(left).not.toContain('teamai hook-dispatch');
    expect(left.trimEnd()).toBe(MEMBER_CONFIG.trimEnd());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
