/**
 * Integration test for the prism spawn path.
 *
 * Regression guard for the Windows "RPC error 400" bug: when the locally
 * installed `prism` resolves to a `.cmd`/`.bat` shim (the usual shape of a
 * Windows console-script), Node's execFile refused to launch it (spawn
 * EINVAL), and the backend mapped that to HTTP 400. The backend must instead
 * spawn the shim successfully and return 200.
 *
 * The shim case only exists on Windows, so the test is skipped elsewhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'dist', 'server.js');
const isWindows = process.platform === 'win32';

const REPORT_JSON =
  '[{"project":"p","display_name":"p","session_count":1,"overall_grade":"A","overall_score":90,"dimensions":{},"top_issues":[]}]';

/** Write a Windows .cmd shim that mimics the prism CLI. */
function writeCmdShim(dir) {
  const shim = path.join(dir, 'prism.cmd');
  fs.writeFileSync(
    shim,
    [
      '@echo off',
      'if "%~1"=="--version" (',
      '  echo prism v9.9.9',
      ') else (',
      `  echo ${REPORT_JSON}`,
      ')',
      '',
    ].join('\r\n'),
  );
  return shim;
}

/** Boot dist/server.js with a given PRISM_BIN and return {proc, port}. */
function startServer(prismBin) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PRISM_BIN: prismBin },
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server never reported ready')), 15000);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      // Only scan completed lines: the final split element is the in-progress
      // tail (no trailing newline yet), so parsing it could throw on a partial
      // ready JSON delivered across two chunks.
      const lines = buf.split('\n');
      const line = lines.slice(0, -1).find((l) => l.includes('"ready"'));
      if (line) {
        clearTimeout(timer);
        resolve({ proc, port: JSON.parse(line).port });
      }
    });
    proc.on('error', reject);
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      })
      .on('error', reject);
  });
}

test('health works when prism is a .cmd shim (Windows)', { skip: !isWindows }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-shim-'));
  const shim = writeCmdShim(dir);
  const { proc, port } = await startServer(shim);
  try {
    const res = await get(port, '/health');
    assert.equal(res.status, 200, `health status (body: ${res.body})`);
    const json = JSON.parse(res.body);
    assert.equal(json.installed, true);
    assert.equal(json.version, '9.9.9');
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health reports not-installed when prism is missing (ENOENT)', async () => {
  const missing = path.join(os.tmpdir(), 'definitely-no-such-prism-binary-xyz');
  const { proc, port } = await startServer(missing);
  try {
    const res = await get(port, '/health');
    assert.equal(res.status, 200, `health status (body: ${res.body})`);
    const json = JSON.parse(res.body);
    assert.equal(json.installed, false);
    assert.equal(json.version, null);
  } finally {
    proc.kill();
  }
});

test('report works when prism is a .cmd shim (Windows)', { skip: !isWindows }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-shim-'));
  const shim = writeCmdShim(dir);
  const { proc, port } = await startServer(shim);
  try {
    const res = await get(port, '/report');
    assert.equal(res.status, 200, `report status (body: ${res.body})`);
    const json = JSON.parse(res.body);
    assert.equal(json.reports.length, 1);
    assert.equal(json.reports[0].overall_grade, 'A');
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
