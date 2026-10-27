/**
 * `teamai recall` prints its output between fixed markers, and the transcript
 * parser reads them back to credit recalled docs: both use the same constants.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatResults } from '../recall.js';
import { parseTranscriptForVotes } from '../transcript-parser.js';

describe('teamai recall output markers', () => {
  it('delimit real recall output so the transcript parser credits the recalled doc', async () => {
    const output = formatResults([{
      entry: {
        filename: 'api-retry-fix.md', title: 'API retry fix', author: 'a', date: '2026-01-01',
        tags: [], tokens: [], votes: 0, type: 'learnings', domain: 'technical',
      },
      score: 5,
      learningsBase: '/team/learnings',
    }]);
    expect(output.startsWith('--- [teamai:recall:start] --- (1 result)')).toBe(true);
    expect(output).toContain('\n--- [teamai:recall:end] ---\n');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-markers-'));
    try {
      const transcript = path.join(dir, 't.jsonl');
      fs.writeFileSync(transcript, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: output }] },
      }) + '\n');
      const { recalledDocIds } = await parseTranscriptForVotes(transcript);
      expect(recalledDocIds).toEqual(['api-retry-fix']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
