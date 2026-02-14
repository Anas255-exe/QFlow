import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ── Config ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3100');
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const SESSION_SECRET = process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex');
const AUTH_ENABLED = !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

// ── Express + WebSocket setup ──────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(path.join(ROOT, 'output')));

// ═══════════════════════════════════════════════════════════════════════════════
//  SESSION & AUTH
// ═══════════════════════════════════════════════════════════════════════════════

type Session = {
  token: string;
  githubUser: string;
  githubAvatar: string;
  githubId: number;
  createdAt: number;
};

const sessions = new Map<string, Session>();

// Cookie helpers
const parseCookies = (header: string | undefined): Record<string, string> => {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  }
  return cookies;
};

const setSessionCookie = (res: express.Response, token: string) => {
  const isSecure = BASE_URL.startsWith('https');
  res.setHeader('Set-Cookie',
    `qflow_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${isSecure ? '; Secure' : ''}`
  );
};

const clearSessionCookie = (res: express.Response) => {
  res.setHeader('Set-Cookie', 'qflow_session=; Path=/; HttpOnly; Max-Age=0');
};

const getSession = (req: express.Request): Session | null => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['qflow_session'];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  // Expire after 24h
  if (Date.now() - session.createdAt > 86400_000) {
    sessions.delete(token);
    return null;
  }
  return session;
};

// Auth middleware — skips if AUTH_ENABLED is false
const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!AUTH_ENABLED) return next();
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  next();
};

// ── Auth Routes ────────────────────────────────────────────────────────────────

app.get('/auth/login', (_req, res) => {
  if (!AUTH_ENABLED) return res.redirect('/app.html');
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/callback`,
    scope: 'read:user',
    state: crypto.randomBytes(16).toString('hex'),
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  if (!AUTH_ENABLED) return res.redirect('/app.html');
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing code parameter');

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/auth/callback`,
      }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      return res.status(400).send(`GitHub auth error: ${tokenData.error ?? 'Unknown'}`);
    }

    // Fetch user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    const user = await userRes.json() as { login: string; avatar_url: string; id: number };

    // Create session
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
      token,
      githubUser: user.login,
      githubAvatar: user.avatar_url,
      githubId: user.id,
      createdAt: Date.now(),
    });

    setSessionCookie(res, token);
    res.redirect('/app.html');

  } catch (err) {
    console.error('GitHub OAuth error:', err);
    res.status(500).send('Authentication failed');
  }
});

app.get('/auth/me', (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({ user: 'local', avatar: '', authEnabled: false });
  }
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({
    user: session.githubUser,
    avatar: session.githubAvatar,
    authEnabled: true,
  });
});

app.post('/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['qflow_session'];
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Health check (for Render) ──────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SCAN STATE & CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

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

// Cleanup: delete output directory and remove scan from memory
const cleanupScan = async (scanId: string) => {
  const scan = scans.get(scanId);
  if (!scan) return;
  if (scan.outputDir) {
    const dirPath = path.join(ROOT, scan.outputDir);
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      console.log(`[cleanup] Deleted ${dirPath}`);
    } catch {}
  }
  scans.delete(scanId);
};

// Cleanup ALL previous scans (called before starting a new one)
const cleanupAllScans = async () => {
  for (const [id, scan] of scans) {
    if (scan.status === 'running' && scan.process) {
      scan.process.kill('SIGTERM');
    }
    await cleanupScan(id);
  }
};

// ── WebSocket ──────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  // Auth check for WebSocket
  if (AUTH_ENABLED) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['qflow_session'];
    if (!token || !sessions.has(token)) {
      ws.close(4001, 'Unauthorized');
      return;
    }
  }
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

// ═══════════════════════════════════════════════════════════════════════════════
//  API ROUTES (protected by requireAuth)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Start a scan ───────────────────────────────────────────────────────────────

app.post('/api/scan', requireAuth, async (req, res) => {
  const { url, scope = 'Full QA scan' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Only one scan at a time
  for (const s of scans.values()) {
    if (s.status === 'running') {
      return res.status(409).json({ error: 'A scan is already running' });
    }
  }

  // Cleanup all previous scans before starting a new one
  await cleanupAllScans();

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
  console.log(`[scan:${scanId}] Spawning agent: node ${agentPath}`);
  console.log(`[scan:${scanId}] URL=${url}, SCOPE=${scope}`);

  // Use --env-file=.env only if .env exists (local dev), skip in containers
  const envFileExists = await fs.access(path.join(ROOT, '.env')).then(() => true).catch(() => false);
  const nodeArgs = envFileExists ? ['--env-file=.env', agentPath] : [agentPath];
  console.log(`[scan:${scanId}] .env file ${envFileExists ? 'found' : 'not found (using process env)'}, args: ${nodeArgs.join(' ')}`);

  const child = spawn('node', nodeArgs, {
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

  // Handle spawn errors (e.g. binary not found)
  child.on('error', (err) => {
    const msg = `[SPAWN ERROR] ${err.message}`;
    console.error(`[scan:${scanId}] ${msg}`);
    scan.logs.push(msg);
    broadcast(scanId, { type: 'log', line: msg });
    scan.status = 'error';
    scan.completedAt = Date.now();
    delete scan.process;
    broadcast(scanId, {
      type: 'complete',
      status: 'error',
      bugsFound: 0,
      outputDir: null,
      duration: scan.completedAt - scan.startedAt,
      error: msg,
    });
  });

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
      console.error(`[scan:${scanId}:stderr] ${line}`);
      scan.logs.push(`[stderr] ${line}`);
      broadcast(scanId, { type: 'log', line: `[stderr] ${line}` });
    }
  });

  // On process exit
  child.on('close', (code, signal) => {
    console.log(`[scan:${scanId}] Process exited: code=${code}, signal=${signal}`);
    scan.status = code === 0 ? 'complete' : 'error';
    scan.completedAt = Date.now();
    delete scan.process;

    // If the process crashed with no logs, add a diagnostic message
    if (scan.status === 'error' && scan.logs.length === 0) {
      const msg = `Agent process crashed immediately (code=${code}, signal=${signal}). Check Render logs for details.`;
      scan.logs.push(msg);
      broadcast(scanId, { type: 'log', line: msg });
    }

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

// ── Cancel a running scan ──────────────────────────────────────────────────────

app.post('/api/scans/:id/cancel', requireAuth, (req, res) => {
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

// ── Scan details ───────────────────────────────────────────────────────────────

app.get('/api/scans/:id', requireAuth, (req, res) => {
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

// ── Scan logs ──────────────────────────────────────────────────────────────────

app.get('/api/scans/:id/logs', requireAuth, (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json({ logs: scan.logs });
});

// ── Report markdown ────────────────────────────────────────────────────────────

app.get('/api/scans/:id/report', requireAuth, async (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan?.reportPath) return res.status(404).json({ error: 'Report not available' });
  try {
    const content = await fs.readFile(scan.reportPath, 'utf-8');
    res.json({ markdown: content, outputDir: scan.outputDir });
  } catch {
    res.status(404).json({ error: 'Report file not found on disk' });
  }
});

// ── Download ZIP (report + screenshots) ────────────────────────────────────────

app.get('/api/scans/:id/download', requireAuth, async (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan?.outputDir) return res.status(404).json({ error: 'No output available' });

  const outputPath = path.join(ROOT, scan.outputDir);
  const reportFile = path.join(outputPath, 'report.md');

  try { await fs.access(reportFile); } catch {
    return res.status(404).json({ error: 'Report not found on disk' });
  }

  const runId = scan.outputDir.replace('output/', '');
  const zipName = `qflow-report-${runId}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('[zip] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'ZIP creation failed' });
  });

  archive.pipe(res);
  archive.file(reportFile, { name: 'report.md' });

  // Add screenshots folder if it exists
  const ssDir = path.join(outputPath, 'screenshots');
  try { await fs.access(ssDir); archive.directory(ssDir, 'screenshots'); } catch {}

  await archive.finalize();
});

// ── List scans ─────────────────────────────────────────────────────────────────

app.get('/api/scans', requireAuth, (_req, res) => {
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

// ═══════════════════════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │                                              │');
  console.log('  │   ⚡ QFlow Server                             │');
  console.log(`  │   ${BASE_URL.padEnd(40)}  │`);
  console.log('  │                                              │');
  if (AUTH_ENABLED) {
    console.log('  │   🔒 GitHub OAuth:  enabled                  │');
  } else {
    console.log('  │   🔓 Auth:  disabled (no GitHub credentials) │');
  }
  console.log('  │                                              │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
});
