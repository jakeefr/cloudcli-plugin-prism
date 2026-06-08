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

/** Write a .cmd shim mimicking prism for a project with no recorded sessions. */
function writeNoSessionShim(dir) {
  const shim = path.join(dir, 'prism.cmd');
  fs.writeFileSync(
    shim,
    [
      '@echo off',
      'if "%~1"=="--version" (',
      '  echo prism v9.9.9',
      ') else (',
      '  echo Project not found: no Claude Code sessions found 1>&2',
      '  exit /b 1',
      ')',
      '',
    ].join('\r\n'),
  );
  return shim;
}

/**
 * Write a .cmd shim that reproduces a `pip install --user` prism: its package
 * lives in the per-user site-packages, which CPython only finds when `APPDATA`
 * is set. With `APPDATA` stripped (as the host does) the real prism.exe dies
 * with `ModuleNotFoundError: No module named 'prism'`; mimic that with a
 * non-zero exit so the shim only "works" when the backend restores `APPDATA`.
 */
function writeUserSiteShim(dir) {
  const shim = path.join(dir, 'prism.cmd');
  fs.writeFileSync(
    shim,
    [
      '@echo off',
      'if "%APPDATA%"=="" (',
      "  echo ModuleNotFoundError: No module named 'prism' 1>&2",
      '  exit /b 1',
      ')',
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

/**
 * Write a .cmd shim that records the APPDATA it was invoked with to a file, so
 * a test can assert what env the backend actually handed prism. Reports a
 * version so /health succeeds.
 */
function writeAppdataEchoShim(dir) {
  const shim = path.join(dir, 'prism.cmd');
  fs.writeFileSync(
    shim,
    [
      '@echo off',
      '> "%~dp0appdata_seen.txt" echo %APPDATA%',
      'echo prism v9.9.9',
      '',
    ].join('\r\n'),
  );
  return shim;
}

/** Boot dist/server.js with a given PRISM_BIN and return {proc, port}. */
function startServer(prismBin, envMutator) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PRISM_BIN: prismBin };
    if (envMutator) envMutator(env);
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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

test('health survives the host stripping APPDATA from the env (Windows)', { skip: !isWindows }, async () => {
  // Regression guard for the real "RPC error 400": the host launches the plugin
  // with APPDATA/USERPROFILE stripped, so a `pip install --user` prism.exe
  // launches but can't import its package. The backend must restore APPDATA so
  // prism's interpreter finds the user site-packages and /health returns 200.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-shim-'));
  const shim = writeUserSiteShim(dir);
  const { proc, port } = await startServer(shim, (env) => {
    delete env.APPDATA;
    delete env.USERPROFILE;
    delete env.LOCALAPPDATA;
  });
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

test('a host-supplied APPDATA is passed through unchanged, not clobbered (Windows)', { skip: !isWindows }, async () => {
  // The env restore must only fill gaps: when the host already provides APPDATA
  // (e.g. a venv/system install that works fine), the backend must not overwrite
  // it with a profile-derived guess. Pins the `??=` preserve contract.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-shim-'));
  const shim = writeAppdataEchoShim(dir);
  const customAppData = path.join(dir, 'CustomRoaming');
  const { proc, port } = await startServer(shim, (env) => {
    env.APPDATA = customAppData;
  });
  try {
    const res = await get(port, '/health');
    assert.equal(res.status, 200, `health status (body: ${res.body})`);
    const seen = fs.readFileSync(path.join(dir, 'appdata_seen.txt'), 'utf8').trim();
    assert.equal(seen, customAppData, 'prism must receive the host-supplied APPDATA verbatim');
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

test('report returns empty (not 400) when project has no sessions (Windows)', { skip: !isWindows }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-shim-'));
  writeNoSessionShim(dir);
  const { proc, port } = await startServer(path.join(dir, 'prism.cmd'));
  try {
    const res = await get(port, '/report?path=' + encodeURIComponent('D:\\charter-clinic'));
    assert.equal(res.status, 200, `report status (body: ${res.body})`);
    assert.deepEqual(JSON.parse(res.body), { reports: [] });
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('report returns empty (not 400) for an unanalyzable/relative path', async () => {
  // Drive-relative path fails the absolute-path guard; must be a no-data
  // state, never a surfaced error.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-shim-'));
  // Any prism is fine here — the guard short-circuits before it runs.
  const { proc, port } = await startServer(isWindows ? writeCmdShim(dir) : 'prism');
  try {
    const res = await get(port, '/report?path=' + encodeURIComponent('D:charter-clinic'));
    assert.equal(res.status, 200, `status (body: ${res.body})`);
    assert.deepEqual(JSON.parse(res.body), { reports: [] });
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
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
