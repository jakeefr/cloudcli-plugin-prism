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
import spawn from 'cross-spawn';
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
    // cross-spawn (not node:child_process) so a Windows `.cmd`/`.bat` prism
    // shim — the usual shape of a pip/pipx console script — launches instead
    // of failing with `spawn EINVAL`. Args stay an array, so the project path
    // is never run through a shell (no quoting/injection surprises).
    const child = spawn(PRISM_BIN, args, {
      windowsHide: true,
      env: {
        ...process.env,
        // prism renders through a rich console; force plain, unwrapped
        // output so the piped JSON survives intact.
        NO_COLOR: '1',
        TERM: 'dumb',
        COLUMNS: '4096',
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // Ask the child to stop, then force-kill if it ignores SIGTERM, so a
    // wedged prism can never leave this promise (and the request) hanging.
    // Idempotent: a second call (e.g. timeout then overflow) must not orphan
    // the first SIGKILL timer.
    const terminate = (): void => {
      if (killTimer) return;
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, PRISM_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BUFFER) {
        terminate();
        settle(() => reject(new Error('prism output exceeded buffer limit')));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_BUFFER) {
        terminate();
        settle(() => reject(new Error('prism output exceeded buffer limit')));
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (err.code === 'ENOENT') {
          const e: PrismError = new Error(
            'prism is not installed or not on PATH (pip install prism-cc)',
          );
          e.notInstalled = true;
          reject(e);
        } else {
          reject(err);
        }
      });
    });

    child.on('close', (code) => {
      // Process is gone, so the hard-kill fallback is no longer needed.
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      // Decode once, at the end: concatenating raw bytes before decoding
      // keeps multi-byte UTF-8 sequences that straddle a chunk boundary
      // intact (a per-chunk toString() would corrupt them).
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      settle(() => {
        if (timedOut) {
          reject(new Error(`prism timed out after ${PRISM_TIMEOUT_MS}ms`));
        } else if (code !== 0) {
          reject(new Error((stderr || `prism exited with code ${code}`).trim()));
        } else {
          resolve(stdout);
        }
      });
    });
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
  // A specific project that can't be analyzed is a no-data state, not an
  // error: a suspicious/relative path (never handed to prism), a project with
  // no recorded sessions yet, or any case where prism produces no report.
  // Return an empty list so the tab renders a clean "no data" view instead of
  // surfacing an error. Only "prism isn't installed" is allowed to propagate
  // (so the install hint shows); everything else degrades to empty.
  if (projectPath !== null && (!path.isAbsolute(projectPath) || projectPath.includes('..'))) {
    return { reports: [] };
  }
  try {
    const stdout = await runPrism(buildAnalyzeArgs(projectPath ?? undefined));
    return { reports: parseReports(stdout) };
  } catch (err) {
    if ((err as PrismError).notInstalled) {
      throw err;
    }
    // Diagnostic only — goes to the plugin server's stderr, never the user.
    console.error('[prism] report unavailable:', (err as Error).message);
    return { reports: [] };
  }
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
