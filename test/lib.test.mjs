import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAnalyzeArgs, parseReports, parseVersion } from '../dist/lib.js';

// ── buildAnalyzeArgs ───────────────────────────────────────────────────

test('buildAnalyzeArgs without a project analyzes everything', () => {
  assert.deepEqual(buildAnalyzeArgs(), ['analyze', '--json']);
});

test('buildAnalyzeArgs scopes to a project path', () => {
  assert.deepEqual(buildAnalyzeArgs('/home/user/proj'), [
    'analyze',
    '--json',
    '--project',
    '/home/user/proj',
  ]);
});

// ── parseVersion ───────────────────────────────────────────────────────

test('parseVersion extracts the version number', () => {
  assert.equal(parseVersion('prism v0.3.0\n'), '0.3.0');
});

test('parseVersion returns null on unexpected output', () => {
  assert.equal(parseVersion('command not found'), null);
});

// ── parseReports ───────────────────────────────────────────────────────

const SAMPLE = [
  {
    project: '-Users-user-proj',
    display_name: '/Users/user/proj',
    session_count: 12,
    overall_grade: 'B+',
    overall_score: 81.4,
    dimensions: {
      token_efficiency: { grade: 'A-', score: 86.0, compaction_count: 2 },
      tool_health: { grade: 'B', score: 77.5, retry_loop_count: 1, interactive_call_count: 0 },
      context_hygiene: { grade: 'B+', score: 80.0, compaction_count: 2 },
      claude_md_adherence: { grade: 'C+', score: 67.2, rules_violated: 3 },
      session_continuity: { grade: 'A', score: 92.1, truncated_sessions: 0 },
    },
    top_issues: [
      { severity: 'medium', category: 'tool_health', description: 'Retry loop detected' },
    ],
  },
];

test('parseReports parses a clean JSON array', () => {
  const reports = parseReports(JSON.stringify(SAMPLE, null, 2));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].overall_grade, 'B+');
  assert.equal(reports[0].dimensions.claude_md_adherence.rules_violated, 3);
});

test('parseReports tolerates stray output around the array', () => {
  const stdout = `Warning: something\n${JSON.stringify(SAMPLE)}\n`;
  const reports = parseReports(stdout);
  assert.equal(reports[0].session_count, 12);
});

test('parseReports throws when no JSON is present', () => {
  assert.throws(() => parseReports('No projects found'), /no JSON report/);
});

test('parseReports throws on malformed JSON', () => {
  assert.throws(() => parseReports('[broken]'), SyntaxError);
});
