import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { commitTeamRepo } from '../helpers/team-repo-history.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const START = '<!-- [teamai:team-rules:start] -->';
const PERSONAL_RULES = '# My own Kimi instructions\n';
const PERSONAL_AGENT = '---\ndescription: My own agent\n---\nLeave this file alone.\n';

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function seedTeam(root: string): string {
  const seed = path.join(root, 'seed');

  write(path.join(seed, 'teamai.yaml'), YAML.stringify({
    team: 'kimi-rules-agents',
    repo: seed,
    provider: 'git',
    usageReport: false,
    sharing: { recall: { enabled: false }, env: { injectShellProfile: false } },
  }));
  write(path.join(seed, 'rules/team.md'), 'Always keep the team convention.\n');
  write(path.join(seed, 'agents/reviewer.yaml'), YAML.stringify({
    name: 'reviewer',
    description: 'Review the code',
    instructions: 'Review the changed code.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
  }));
  commitTeamRepo(seed);

  return seed;
}

function run(home: string, cwd: string, kimiHome: string, args: string[]): void {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, KIMI_CODE_HOME: kimiHome, FORCE_COLOR: '0', NO_COLOR: '1' },
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
  });

  expect(result.status, result.stdout + result.stderr).toBe(0);
}

function expectDelivery(kimiHome: string): void {
  const rules = fs.readFileSync(path.join(kimiHome, 'AGENTS.md'), 'utf8');
  const agentFile = path.join(kimiHome, 'agents/reviewer.md');

  expect(rules.startsWith(PERSONAL_RULES)).toBe(true);
  expect(rules).toContain(START);
  expect(rules).toContain('Always keep the team convention.');
  expect(matter(fs.readFileSync(agentFile, 'utf8')).data.tools).toEqual(['Bash', 'Read', 'Grep', 'Glob']);
  expect(matter(fs.readFileSync(agentFile, 'utf8')).content).toContain('Review the changed code.');
}

function expectSelectiveRemoval(kimiHome: string): void {
  const rules = fs.readFileSync(path.join(kimiHome, 'AGENTS.md'), 'utf8');

  expect(rules).toBe(PERSONAL_RULES);
  expect(fs.existsSync(path.join(kimiHome, 'agents/reviewer.md'))).toBe(false);
  expect(fs.readFileSync(path.join(kimiHome, 'agents/personal.md'), 'utf8')).toBe(PERSONAL_AGENT);
}

describe('Kimi rules and agents through the built CLI', () => {
  it('delivers and selectively removes user rules and agents in a moved home', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-user-'));

    try {
      const home = path.join(root, 'home');
      const kimiHome = path.join(root, 'moved-kimi');
      const repo = path.join(home, '.teamai/team-repo');
      const seed = seedTeam(root);

      fs.mkdirSync(path.dirname(repo), { recursive: true });
      execFileSync('git', ['clone', '-q', seed, repo]);
      write(path.join(home, '.teamai/config.yaml'), YAML.stringify({
        repo: { localPath: repo, remote: seed },
        username: 'tester',
        scope: 'user',
        autoUpdate: false,
        enabledAgents: ['kimi'],
      }));
      write(path.join(kimiHome, 'AGENTS.md'), PERSONAL_RULES);
      write(path.join(kimiHome, 'agents/personal.md'), PERSONAL_AGENT);

      run(home, home, kimiHome, ['pull', '--force']);
      expectDelivery(kimiHome);
      run(home, home, kimiHome, ['uninstall', '--agent', 'kimi', '--force']);
      expectSelectiveRemoval(kimiHome);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('delivers and selectively removes project rules and agents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-kimi-project-'));

    try {
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      const kimiHome = path.join(project, '.kimi-code');
      const repo = path.join(project, '.teamai/team-repo');
      const seed = seedTeam(root);

      fs.mkdirSync(path.dirname(repo), { recursive: true });
      execFileSync('git', ['clone', '-q', seed, repo]);
      write(path.join(project, '.teamai/config.yaml'), YAML.stringify({
        repo: { localPath: repo, remote: seed },
        username: 'tester',
        scope: 'project',
        projectRoot: project,
        autoUpdate: false,
        enabledAgents: ['kimi'],
      }));
      write(path.join(kimiHome, 'AGENTS.md'), PERSONAL_RULES);
      write(path.join(kimiHome, 'agents/personal.md'), PERSONAL_AGENT);
      fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });

      run(home, project, path.join(home, '.kimi-code'), ['pull', '--force']);
      expectDelivery(kimiHome);
      run(home, project, path.join(home, '.kimi-code'), ['uninstall', '--agent', 'kimi', '--force']);
      expectSelectiveRemoval(kimiHome);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
