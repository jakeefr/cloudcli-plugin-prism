/**
 * PRISM plugin backend.
 *
 * Runs as a CloudCLI plugin subprocess and shells out to the locally
 * installed `prism` CLI (pip install prism-cc). Two endpoints:
 *
 *   GET /health            -> { installed, version }
 *   GET /report[?path=..]  -> { reports: PrismReport[] }
 *
 * With ?path= the report is scoped to that project (prism maps the real
 * workspace path to its session directory under ~/.claude/projects).
 * Without it, prism analyzes every project it can discover.
 */

import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { buildAnalyzeArgs, parseReports, parseVersion } from './lib.js';

// ── prism invocation ───────────────────────────────────────────────────

const PRISM_BIN = process.env.PRISM_BIN || 'prism';
const PRISM_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 16 * 1024 * 1024;

interface PrismError extends Error {
  notInstalled?: boolean;
}

function runPrism(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      PRISM_BIN,
      args,
      {
        timeout: PRISM_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          // prism renders through a rich console; force plain, unwrapped
          // output so the piped JSON survives intact.
          NO_COLOR: '1',
          TERM: 'dumb',
          COLUMNS: '4096',
        },
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          const e: PrismError = new Error(
            'prism is not installed or not on PATH (pip install prism-cc)',
          );
          e.notInstalled = true;
          reject(e);
        } else if (err) {
          reject(new Error((stderr || err.message).trim()));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

// ── Request handlers ───────────────────────────────────────────────────

async function handleHealth(): Promise<{ installed: boolean; version: string | null }> {
  try {
    const stdout = await runPrism(['--version']);
    return { installed: true, version: parseVersion(stdout) };
  } catch (err) {
    if ((err as PrismError).notInstalled) {
      return { installed: false, version: null };
    }
    throw err;
  }
}

async function handleReport(projectPath: string | null): Promise<{ reports: unknown[] }> {
  if (projectPath !== null) {
    if (!path.isAbsolute(projectPath) || projectPath.includes('..')) {
      throw new Error('Invalid path');
    }
  }
  const stdout = await runPrism(buildAnalyzeArgs(projectPath ?? undefined));
  return { reports: parseReports(stdout) };
}

// ── HTTP server ────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const respond = (promise: Promise<unknown>): void => {
    promise
      .then((payload) => {
        res.end(JSON.stringify(payload));
      })
      .catch((err: PrismError) => {
        res.writeHead(err.notInstalled ? 503 : 400);
        res.end(JSON.stringify({ error: err.message, notInstalled: !!err.notInstalled }));
      });
  };

  if (req.method === 'GET' && req.url?.startsWith('/health')) {
    respond(handleHealth());
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/report')) {
    const { searchParams } = new URL(req.url, 'http://localhost');
    respond(handleReport(searchParams.get('path')));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (addr && typeof addr !== 'string') {
    // Signal readiness to the host: this JSON line is required
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  }
});
