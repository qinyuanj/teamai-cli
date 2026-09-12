import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const START = '<!-- [teamai:team-rules:start] -->';
const END = '<!-- [teamai:team-rules:end] -->';

// Exercise the built CLI with local Git transport: provider credentials and
// remote hosting APIs are deliberately outside this rule-delivery check.
describe('Kimi Code CLI project rules through pull and uninstall', () => {
  let sandbox: string;
  let project: string;
  let home: string;
  let repo: string;

  function enable(agents: string[]) {
    for (const agent of agents) fs.mkdirSync(path.join(project, agent === 'kimi' ? '.kimi-code' : `.${agent}`, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(project, '.teamai/config.yaml'), YAML.stringify({
      repo: { localPath: repo, remote: repo },
      username: 'test', updatePolicy: 'auto', scope: 'project', projectRoot: project,
      enabledAgents: agents, recallEnabled: false,
    }));
  }

  function cli(...args: string[]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: project, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '0' },
    });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);
    return output;
  }

  const kimiAgentsMd = () => path.join(project, '.kimi-code/AGENTS.md');

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-'));
    home = path.join(sandbox, 'home');
    project = path.join(sandbox, 'project');
    repo = path.join(project, '.teamai/team-repo');
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'kimi-e2e', repo, provider: 'git', sharing: { recall: { enabled: false } } }));
    fs.writeFileSync(path.join(repo, 'rules/first.md'), '---\npaths: ["src/**"]\n---\nAlways explain the change.\n');
    fs.writeFileSync(path.join(repo, 'rules/second.md'), 'Keep all team instructions.\n');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Personal notes\n');
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
    git(['remote', 'add', 'origin', repo]);
    git(['branch', '--set-upstream-to=HEAD']);
  });

  afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  it('delivers full rules with only Kimi and DSH enabled', () => {
    enable(['kimi', 'dsh']);
    fs.mkdirSync(path.join(project, '.kimi-code'), { recursive: true });
    fs.writeFileSync(kimiAgentsMd(), '# My Kimi notes\n');
    cli('pull', '--force');

    const content = fs.readFileSync(kimiAgentsMd(), 'utf8');
    expect(content.startsWith('# My Kimi notes')).toBe(true);
    expect(content.split(START)).toHaveLength(2);
    expect(content.split(END)).toHaveLength(2);
    expect(content).toContain('Always explain the change.');
    expect(content).toContain('Keep all team instructions.');
    expect(fs.existsSync(path.join(project, '.kimi-code/rules'))).toBe(false);
    // The project-root AGENTS.md is the owners': DSH takes its rules from its hook.
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('# Personal notes\n');
    expect(fs.existsSync(path.join(project, '.dsh/rules'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.codex'))).toBe(false);

    cli('uninstall', '--agent', 'kimi', '--force');
    expect(fs.readFileSync(kimiAgentsMd(), 'utf8')).not.toContain(START);
    expect(fs.readFileSync(kimiAgentsMd(), 'utf8')).toContain('# My Kimi notes');
  });
});
