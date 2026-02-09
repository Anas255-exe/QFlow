import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ── Express + WebSocket setup ──────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(path.join(ROOT, 'output')));

// ── State ──────────────────────────────────────────────────────────────────────

type ScanState = {
  id: string;
  url: string;
  scope: string;
  status: 'running' | 'complete' | 'error';
  logs: string[];
  outputDir?: string;
  reportPath?: string;
  process?: ChildProcess;
  startedAt: number;
  completedAt?: number;
  bugsFound?: number;
};

const scans = new Map<string, ScanState>();
const clients = new Set<WebSocket>();

// ── WebSocket ──────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

const broadcast = (scanId: string, data: Record<string, unknown>) => {
  const msg = JSON.stringify({ scanId, ...data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
};

// ── API: Start a scan ──────────────────────────────────────────────────────────

app.post('/api/scan', async (req, res) => {
  const { url, scope = 'Full QA scan' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Only one scan at a time
  for (const s of scans.values()) {
    if (s.status === 'running') {
      return res.status(409).json({ error: 'A scan is already running' });
    }
  }

  const scanId = `scan-${Date.now()}`;
  const scan: ScanState = {
    id: scanId,
    url,
    scope,
    status: 'running',
    logs: [],
    startedAt: Date.now(),
  };
  scans.set(scanId, scan);

  // Spawn the agent in non-interactive mode (URL & scope via env vars)
  const agentPath = path.join(ROOT, 'dist', 'qaAgent.mjs');
  const child = spawn('node', ['--env-file=.env', agentPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      QFLOW_NON_INTERACTIVE: '1',
      QFLOW_URL: url,
      QFLOW_SCOPE: scope,
    },
  });
  scan.process = child;
  child.stdin.end();

  // Capture stdout
  child.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      scan.logs.push(line);
      broadcast(scanId, { type: 'log', line });

      // Detect run ID → output directory
      if (line.includes('Run ID :')) {
        const runId = line.split('Run ID :')[1]?.trim();
        if (runId) {
          scan.outputDir = `output/${runId}`;
          scan.reportPath = path.join(ROOT, 'output', runId, 'report.md');
        }
      }

      // Detect bug count from final summary
      const bugMatch = line.match(/(\d+) bug\(s\) found/);
      if (bugMatch) scan.bugsFound = parseInt(bugMatch[1]);
    }
  });

  // Capture stderr
  child.stderr.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      scan.logs.push(`[stderr] ${line}`);
      broadcast(scanId, { type: 'log', line: `[stderr] ${line}` });
    }
  });

  // On process exit
  child.on('close', (code) => {
    scan.status = code === 0 ? 'complete' : 'error';
    scan.completedAt = Date.now();
    delete scan.process;
    broadcast(scanId, {
      type: 'complete',
      status: scan.status,
      bugsFound: scan.bugsFound ?? 0,
      outputDir: scan.outputDir ?? null,
      duration: scan.completedAt - scan.startedAt,
    });
  });

  res.json({ scanId });
});

// ── API: Cancel a running scan ─────────────────────────────────────────────────

app.post('/api/scans/:id/cancel', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.status !== 'running' || !scan.process) {
    return res.status(400).json({ error: 'Scan is not running' });
  }
  scan.process.kill('SIGTERM');
  scan.status = 'error';
  scan.completedAt = Date.now();
  broadcast(scan.id, { type: 'complete', status: 'error', bugsFound: 0, cancelled: true });
  res.json({ ok: true });
});

// ── API: Scan details ──────────────────────────────────────────────────────────

app.get('/api/scans/:id', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json({
    id: scan.id,
    url: scan.url,
    scope: scan.scope,
    status: scan.status,
    bugsFound: scan.bugsFound,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    outputDir: scan.outputDir ?? null,
    logCount: scan.logs.length,
  });
});

// ── API: Scan logs ─────────────────────────────────────────────────────────────

app.get('/api/scans/:id/logs', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json({ logs: scan.logs });
});

// ── API: Report markdown ───────────────────────────────────────────────────────

app.get('/api/scans/:id/report', async (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan?.reportPath) return res.status(404).json({ error: 'Report not available' });
  try {
    const content = await fs.readFile(scan.reportPath, 'utf-8');
    res.json({ markdown: content, outputDir: scan.outputDir });
  } catch {
    res.status(404).json({ error: 'Report file not found on disk' });
  }
});

// ── API: List scans ────────────────────────────────────────────────────────────

app.get('/api/scans', (_req, res) => {
  const list = [...scans.values()].map(s => ({
    id: s.id,
    url: s.url,
    status: s.status,
    bugsFound: s.bugsFound,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    outputDir: s.outputDir ?? null,
  }));
  res.json({ scans: list.reverse() });
});

// ── Start server ───────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3100');
server.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │                                          │');
  console.log(`  │   ⚡ QFlow Server                         │`);
  console.log(`  │   http://localhost:${PORT}                  │`);
  console.log('  │                                          │');
  console.log('  └──────────────────────────────────────────┘');
  console.log('');
});
