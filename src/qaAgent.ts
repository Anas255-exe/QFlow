import fs from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { chromium, Page, BrowserContext, Response, Request } from 'playwright';

// ── Types ──────────────────────────────────────────────────────────────────────

type Severity = 'Low' | 'Medium' | 'High' | 'Critical';
type Category =
  | 'Navigation'
  | 'Console'
  | 'Network'
  | 'Accessibility'
  | 'SEO'
  | 'Security'
  | 'Performance'
  | 'Layout'
  | 'Functional'
  | 'Content'
  | 'UX';

type BugEntry = {
  id: string;
  title: string;
  severity: Severity;
  category: Category;
  description: string;
  steps: string[];
  evidence: string[];
  details?: string[];
};

type RunContext = {
  runId: string;
  outputRoot: string;
  screenshotDir: string;
  reportPath: string;
};

type FailedRequest = {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  failure?: string;
};

// ── Globals ────────────────────────────────────────────────────────────────────

const rl = createInterface({ input, output });
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT_MS ?? '90000');
const SETTLE_DELAY = 5_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

const nowFs = () => new Date().toISOString().replace(/[:.]/g, '-');

const slug = (v: string) =>
  (v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'ev');

const ensureDir = (d: string) => fs.mkdir(d, { recursive: true });

const ask = async (q: string, fallback = '') => {
  const a = (await rl.question(fallback ? `${q} [${fallback}]: ` : `${q}: `)).trim();
  return a || fallback;
};

const log = (msg: string) => console.log(`  -> ${msg}`);

// ── Context ────────────────────────────────────────────────────────────────────

const buildCtx = (): RunContext => {
  const runId = `run-${nowFs()}`;
  const outputRoot = path.join(process.cwd(), 'output', runId);
  return {
    runId,
    outputRoot,
    screenshotDir: path.join(outputRoot, 'screenshots'),
    reportPath: path.join(outputRoot, 'report.md'),
  };
};

// ── Evidence capture ───────────────────────────────────────────────────────────

const takeScreenshot = async (
  page: Page,
  ctx: RunContext,
  label: string,
  fullPage = true,
): Promise<string> => {
  const file = `${slug(label)}-${Date.now()}.png`;
  const abs = path.join(ctx.screenshotDir, file);
  await page.screenshot({ path: abs, fullPage }).catch(() => {});
  return path.relative(ctx.outputRoot, abs).replace(/\\/g, '/');
};

// ── Bug recorder ───────────────────────────────────────────────────────────────

const bugs: BugEntry[] = [];

const addBug = async (
  page: Page,
  ctx: RunContext,
  opts: {
    title: string;
    severity: Severity;
    category: Category;
    description: string;
    steps: string[];
    evidenceLabel: string;
    details?: string[];
    fullPage?: boolean;
  },
) => {
  const id = `BUG-${String(bugs.length + 1).padStart(3, '0')}`;
  const shot = await takeScreenshot(page, ctx, `${id}-${opts.evidenceLabel}`, opts.fullPage ?? true);
  bugs.push({
    id,
    title: opts.title,
    severity: opts.severity,
    category: opts.category,
    description: opts.description,
    steps: opts.steps,
    evidence: [shot],
    details: opts.details,
  });
  log(`${id} [${opts.severity}] ${opts.title}`);
};

// ═══════════════════════════════════════════════════════════════════════════════
//  CHECK MODULES
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Console & page errors ───────────────────────────────────────────────────

const consoleErrors: string[] = [];
const consoleWarnings: string[] = [];
const pageErrors: string[] = [];

const attachConsoleListeners = (page: Page) => {
  page.on('console', msg => {
    const loc = msg.location();
    const where = loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}` : '';
    const text = `${msg.text()} ${where ? `(${where})` : ''}`.trim();
    if (msg.type() === 'error') consoleErrors.push(text);
    if (msg.type() === 'warning') consoleWarnings.push(text);
  });
  page.on('pageerror', err => pageErrors.push(err.message));
};

const checkConsoleErrors = async (page: Page, ctx: RunContext) => {
  if (consoleErrors.length) {
    await addBug(page, ctx, {
      title: `${consoleErrors.length} console error(s)`,
      severity: 'High',
      category: 'Console',
      description: 'JavaScript errors were logged in the browser console during page load and interaction.',
      steps: ['Open target URL', 'Open browser DevTools -> Console'],
      evidenceLabel: 'console-errors',
      details: consoleErrors.slice(0, 20),
    });
  }
  if (pageErrors.length) {
    await addBug(page, ctx, {
      title: `${pageErrors.length} uncaught exception(s)`,
      severity: 'High',
      category: 'Console',
      description: 'Unhandled JavaScript exceptions were thrown.',
      steps: ['Open target URL'],
      evidenceLabel: 'page-errors',
      details: pageErrors.slice(0, 20),
    });
  }
  if (consoleWarnings.length > 10) {
    await addBug(page, ctx, {
      title: `${consoleWarnings.length} console warnings`,
      severity: 'Low',
      category: 'Console',
      description: 'Excessive console warnings may indicate underlying problems.',
      steps: ['Open target URL', 'Open browser DevTools -> Console'],
      evidenceLabel: 'console-warnings',
      details: consoleWarnings.slice(0, 15),
    });
  }
};

// 2. Network failures ────────────────────────────────────────────────────────

const failedRequests: FailedRequest[] = [];

const attachNetworkListeners = (page: Page) => {
  page.on('requestfailed', (req: Request) => {
    failedRequests.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      failure: req.failure()?.errorText,
    });
  });
  page.on('response', (res: Response) => {
    const st = res.status();
    if (st >= 400) {
      failedRequests.push({
        url: res.url(),
        method: res.request().method(),
        resourceType: res.request().resourceType(),
        status: st,
      });
    }
  });
};

const checkNetworkFailures = async (page: Page, ctx: RunContext) => {
  if (!failedRequests.length) return;

  const critical = failedRequests.filter(
    r => (r.status ?? 0) >= 500 || r.resourceType === 'fetch' || r.resourceType === 'xhr',
  );
  const assets = failedRequests.filter(r =>
    ['stylesheet', 'script', 'font', 'image'].includes(r.resourceType),
  );

  if (critical.length) {
    await addBug(page, ctx, {
      title: `${critical.length} failed API/server request(s)`,
      severity: 'High',
      category: 'Network',
      description: 'XHR/fetch requests failed or returned server errors.',
      steps: ['Open target URL', 'Monitor Network tab'],
      evidenceLabel: 'network-api-fails',
      details: critical.slice(0, 15).map(r => `${r.method} ${r.url} -> ${r.status ?? r.failure}`),
    });
  }
  if (assets.length) {
    await addBug(page, ctx, {
      title: `${assets.length} failed asset request(s)`,
      severity: 'Medium',
      category: 'Network',
      description: 'Static assets (CSS, JS, fonts, images) failed to load.',
      steps: ['Open target URL', 'Monitor Network tab'],
      evidenceLabel: 'network-asset-fails',
      details: assets.slice(0, 15).map(r => `${r.resourceType}: ${r.url} -> ${r.status ?? r.failure}`),
    });
  }
};

// 3. SEO & meta checks ──────────────────────────────────────────────────────

const checkSEO = async (page: Page, ctx: RunContext) => {
  const title = (await page.title()).trim();
  if (!title) {
    await addBug(page, ctx, {
      title: 'Missing page <title>',
      severity: 'Medium',
      category: 'SEO',
      description: 'The page has no <title> or it is empty — hurts SEO and browser tab UX.',
      steps: ['Open target URL', 'Inspect <head>'],
      evidenceLabel: 'missing-title',
    });
  }

  const meta = await page.evaluate(() => {
    const get = (name: string) =>
      (document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement)?.content?.trim() ?? '';
    const getOg = (prop: string) =>
      (document.querySelector(`meta[property="${prop}"]`) as HTMLMetaElement)?.content?.trim() ?? '';
    return {
      description: get('description'),
      viewport: get('viewport'),
      ogTitle: getOg('og:title'),
      ogImage: getOg('og:image'),
      charset: !!document.querySelector('meta[charset]'),
      lang: document.documentElement.lang?.trim() ?? '',
      canonical: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href ?? '',
      favicon: !!(
        document.querySelector('link[rel="icon"]') ||
        document.querySelector('link[rel="shortcut icon"]')
      ),
    };
  });

  if (!meta.description) {
    await addBug(page, ctx, {
      title: 'Missing meta description',
      severity: 'Low',
      category: 'SEO',
      description: 'No <meta name="description"> found — important for search engine snippets.',
      steps: ['Inspect <head>'],
      evidenceLabel: 'missing-description',
    });
  }

  if (!meta.viewport) {
    await addBug(page, ctx, {
      title: 'Missing viewport meta tag',
      severity: 'Medium',
      category: 'SEO',
      description: 'Without a viewport meta tag the page may not render correctly on mobile.',
      steps: ['Inspect <head>'],
      evidenceLabel: 'missing-viewport',
    });
  }

  if (!meta.lang) {
    await addBug(page, ctx, {
      title: 'Missing lang attribute on <html>',
      severity: 'Low',
      category: 'Accessibility',
      description: 'Screen readers need a lang attribute to choose the right pronunciation.',
      steps: ['Inspect <html> element'],
      evidenceLabel: 'missing-lang',
    });
  }

  if (!meta.favicon) {
    await addBug(page, ctx, {
      title: 'Missing favicon',
      severity: 'Low',
      category: 'UX',
      description: 'No favicon link detected; the browser will show a generic icon.',
      steps: ['Check browser tab icon'],
      evidenceLabel: 'missing-favicon',
    });
  }

  if (!meta.ogTitle && !meta.ogImage) {
    await addBug(page, ctx, {
      title: 'Missing Open Graph tags',
      severity: 'Low',
      category: 'SEO',
      description: 'No og:title / og:image found — shared links will have poor previews.',
      steps: ['Inspect <head> for og: meta tags'],
      evidenceLabel: 'missing-og',
    });
  }
};

// 4. Accessibility audit ─────────────────────────────────────────────────────

const checkAccessibility = async (page: Page, ctx: RunContext) => {
  const a11y = await page.evaluate(() => {
    const issues: string[] = [];

    // Images without alt
    let missingAlt = 0;
    document.querySelectorAll('img').forEach(img => {
      if (!img.hasAttribute('alt')) missingAlt++;
    });
    if (missingAlt > 0) issues.push(`${missingAlt} <img> element(s) missing alt attribute`);

    // Buttons without accessible text
    let emptyBtns = 0;
    document.querySelectorAll('button').forEach(btn => {
      const text = (btn.textContent?.trim() ?? '') || (btn.getAttribute('aria-label') ?? '');
      if (!text) emptyBtns++;
    });
    if (emptyBtns) issues.push(`${emptyBtns} <button>(s) without accessible label`);

    // Links without accessible text
    let emptyLinks = 0;
    document.querySelectorAll('a').forEach(a => {
      const text = (a.textContent?.trim() ?? '') || (a.getAttribute('aria-label') ?? '');
      if (!text && !a.querySelector('img')) emptyLinks++;
    });
    if (emptyLinks) issues.push(`${emptyLinks} <a> link(s) without accessible text`);

    // Form inputs without labels
    let unlabelled = 0;
    document.querySelectorAll('input, select, textarea').forEach(el => {
      const inp = el as HTMLInputElement;
      if (inp.type === 'hidden') return;
      const id = inp.id;
      const hasLabel = id && document.querySelector(`label[for="${id}"]`);
      const hasAriaLabel = inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby');
      const wrappedInLabel = inp.closest('label');
      if (!hasLabel && !hasAriaLabel && !wrappedInLabel) unlabelled++;
    });
    if (unlabelled) issues.push(`${unlabelled} form input(s) without associated label`);

    // Heading hierarchy
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    const levels = headings.map(h => parseInt(h.tagName[1]));
    if (levels.length && levels[0] !== 1) issues.push(`First heading is <h${levels[0]}> instead of <h1>`);
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i - 1] > 1) {
        issues.push(`Heading level jumps from <h${levels[i - 1]}> to <h${levels[i]}>`);
        break;
      }
    }

    // Very small text
    let tinyText = 0;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      if (fs > 0 && fs < 10 && el.textContent?.trim()) tinyText++;
    });
    if (tinyText > 3) issues.push(`${tinyText} elements with font-size < 10px (potential readability issue)`);

    // Positive tabindex
    let highTabIndex = 0;
    document.querySelectorAll('[tabindex]').forEach(el => {
      const ti = parseInt(el.getAttribute('tabindex') ?? '0');
      if (ti > 0) highTabIndex++;
    });
    if (highTabIndex > 0) issues.push(`${highTabIndex} element(s) with positive tabindex (anti-pattern)`);

    return issues;
  });

  if (a11y.length) {
    await addBug(page, ctx, {
      title: `${a11y.length} accessibility issue(s)`,
      severity: a11y.length > 5 ? 'High' : 'Medium',
      category: 'Accessibility',
      description: 'Automated accessibility scan found potential WCAG violations.',
      steps: ['Open target URL', 'Run accessibility audit'],
      evidenceLabel: 'accessibility',
      details: a11y,
    });
  }
};

// 5. Broken links ────────────────────────────────────────────────────────────

const checkBrokenLinks = async (page: Page, ctx: RunContext) => {
  const links: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => (a as HTMLAnchorElement).href)
      .filter(h => h.startsWith('http')),
  );

  const unique = [...new Set(links)].slice(0, 30);
  const broken: string[] = [];

  for (const href of unique) {
    try {
      const res = await page.request.head(href, { timeout: 8_000 });
      if (res.status() >= 400) broken.push(`${href} -> ${res.status()}`);
    } catch {
      broken.push(`${href} -> timeout/network error`);
    }
  }

  if (broken.length) {
    await addBug(page, ctx, {
      title: `${broken.length} broken / unreachable link(s)`,
      severity: broken.length > 5 ? 'High' : 'Medium',
      category: 'Content',
      description: 'Links on the page point to unreachable or error-returning URLs.',
      steps: ['Open target URL', 'Click links'],
      evidenceLabel: 'broken-links',
      details: broken.slice(0, 20),
    });
  }
};

// 6. Broken images ───────────────────────────────────────────────────────────

const checkBrokenImages = async (page: Page, ctx: RunContext) => {
  const result = await page.evaluate(() => {
    const broken: string[] = [];
    document.querySelectorAll('img').forEach(img => {
      const el = img as HTMLImageElement;
      if (!el.complete || el.naturalWidth === 0) {
        broken.push(el.src || el.getAttribute('data-src') || '(unknown src)');
      }
    });
    return broken;
  });

  if (result.length) {
    await addBug(page, ctx, {
      title: `${result.length} broken image(s)`,
      severity: 'Medium',
      category: 'Content',
      description: 'Image elements failed to load or have zero natural dimensions.',
      steps: ['Open target URL', 'Scroll through page'],
      evidenceLabel: 'broken-images',
      details: result.slice(0, 15),
    });
  }
};

// 7. Security headers ────────────────────────────────────────────────────────

const checkSecurityHeaders = async (response: Response, page: Page, ctx: RunContext) => {
  const headers = response.headers();
  const missing: string[] = [];

  const checks: [string, string][] = [
    ['content-security-policy', 'Content-Security-Policy — protects against XSS'],
    ['x-content-type-options', 'X-Content-Type-Options — prevents MIME sniffing'],
    ['x-frame-options', 'X-Frame-Options — prevents clickjacking'],
    ['strict-transport-security', 'Strict-Transport-Security — enforces HTTPS'],
    ['referrer-policy', 'Referrer-Policy — controls referrer leakage'],
    ['permissions-policy', 'Permissions-Policy — restricts browser features'],
  ];

  for (const [header, desc] of checks) {
    if (!headers[header]) missing.push(desc);
  }

  // Mixed content
  const mixedContent = await page.evaluate(() => {
    const mixed: string[] = [];
    if (location.protocol === 'https:') {
      document
        .querySelectorAll('img, script, link[rel="stylesheet"], iframe, video, audio, source')
        .forEach(el => {
          const src = el.getAttribute('src') || el.getAttribute('href') || '';
          if (src.startsWith('http://')) mixed.push(`${el.tagName.toLowerCase()}: ${src}`);
        });
    }
    return mixed;
  });

  if (missing.length) {
    await addBug(page, ctx, {
      title: `${missing.length} missing security header(s)`,
      severity: missing.length > 3 ? 'High' : 'Medium',
      category: 'Security',
      description: 'Important HTTP security headers are not set on the response.',
      steps: ['Open target URL', 'Inspect response headers'],
      evidenceLabel: 'security-headers',
      details: missing,
    });
  }

  if (mixedContent.length) {
    await addBug(page, ctx, {
      title: `${mixedContent.length} mixed content resource(s)`,
      severity: 'High',
      category: 'Security',
      description: 'HTTPS page loads HTTP resources — browsers may block them.',
      steps: ['Open target URL on HTTPS', 'Check console for mixed content warnings'],
      evidenceLabel: 'mixed-content',
      details: mixedContent.slice(0, 15),
    });
  }
};

// 8. Performance ─────────────────────────────────────────────────────────────

const checkPerformance = async (page: Page, ctx: RunContext) => {
  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const paint = performance.getEntriesByType('paint');
    const fcp = paint.find(p => p.name === 'first-contentful-paint')?.startTime ?? 0;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const largeResources = resources
      .filter(r => r.transferSize > 500_000)
      .map(r => `${r.name.split('/').pop()} (${(r.transferSize / 1024).toFixed(0)} KB)`);

    return {
      domReady: nav?.domContentLoadedEventEnd ?? 0,
      loadComplete: nav?.loadEventEnd ?? 0,
      fcp,
      domNodes: document.querySelectorAll('*').length,
      largeResources,
      totalResources: resources.length,
    };
  });

  const issues: string[] = [];
  if (perf.fcp > 3_000)
    issues.push(`First Contentful Paint: ${(perf.fcp / 1000).toFixed(1)}s (should be < 1.8s)`);
  if (perf.domReady > 5_000) issues.push(`DOM ready: ${(perf.domReady / 1000).toFixed(1)}s`);
  if (perf.loadComplete > 10_000) issues.push(`Full load: ${(perf.loadComplete / 1000).toFixed(1)}s`);
  if (perf.domNodes > 3_000) issues.push(`${perf.domNodes} DOM nodes (>1500 is heavy)`);
  if (perf.largeResources.length) issues.push(`Large assets: ${perf.largeResources.join(', ')}`);

  if (issues.length) {
    await addBug(page, ctx, {
      title: `${issues.length} performance concern(s)`,
      severity: issues.some(i => i.includes('First Contentful')) ? 'High' : 'Medium',
      category: 'Performance',
      description: 'Page performance metrics exceed recommended thresholds.',
      steps: ['Open target URL', 'Run Lighthouse / DevTools Performance tab'],
      evidenceLabel: 'performance',
      details: issues,
    });
  }
};

// 9. Layout / overflow / visual ──────────────────────────────────────────────

const checkLayout = async (page: Page, ctx: RunContext) => {
  const issues = await page.evaluate(() => {
    const problems: string[] = [];
    const vw = document.documentElement.clientWidth;

    // Horizontal overflow
    if (document.documentElement.scrollWidth > vw + 5) {
      problems.push(
        `Page is ${document.documentElement.scrollWidth - vw}px wider than viewport — horizontal scroll`,
      );
    }

    // Elements overflowing viewport
    let overflowCount = 0;
    document.querySelectorAll('body *').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > vw + 10) overflowCount++;
    });
    if (overflowCount > 0)
      problems.push(`${overflowCount} element(s) overflow the viewport horizontally`);

    // Text truncation
    let truncated = 0;
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (
        cs.overflow === 'hidden' &&
        cs.textOverflow === 'ellipsis' &&
        el.scrollWidth > el.clientWidth
      ) {
        truncated++;
      }
    });
    if (truncated > 5) problems.push(`${truncated} element(s) show truncated text (ellipsis)`);

    // Overlapping interactive elements
    const interactives = Array.from(
      document.querySelectorAll('button, a, input, select, [role="button"]'),
    );
    let overlaps = 0;
    for (let i = 0; i < Math.min(interactives.length, 50); i++) {
      const rect = interactives[i].getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > vw) continue;
      const topEl = document.elementFromPoint(cx, cy);
      if (
        topEl &&
        topEl !== interactives[i] &&
        !interactives[i].contains(topEl) &&
        !topEl.contains(interactives[i])
      ) {
        overlaps++;
      }
    }
    if (overlaps > 0)
      problems.push(`${overlaps} interactive element(s) may be obscured by overlapping elements`);

    // Empty visible containers
    let emptyContainers = 0;
    document.querySelectorAll('div, section, main, article').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.height > 50 && rect.width > 100) {
        const text = el.textContent?.trim() ?? '';
        const children = el.children.length;
        if (!text && children === 0) emptyContainers++;
      }
    });
    if (emptyContainers > 0)
      problems.push(`${emptyContainers} visible empty container(s) detected`);

    return problems;
  });

  if (issues.length) {
    await addBug(page, ctx, {
      title: `${issues.length} layout/visual issue(s)`,
      severity: 'Medium',
      category: 'Layout',
      description: 'Visual inspection found layout irregularities.',
      steps: ['Open target URL', 'Inspect page layout'],
      evidenceLabel: 'layout',
      details: issues,
    });
  }
};

// 10. Interactive elements ───────────────────────────────────────────────────

const checkInteractiveElements = async (page: Page, ctx: RunContext) => {
  const issues = await page.evaluate(() => {
    const problems: string[] = [];

    // Disabled buttons
    let disabledBtns = 0;
    document.querySelectorAll('button, [role="button"]').forEach(btn => {
      if ((btn as HTMLButtonElement).disabled) disabledBtns++;
    });
    if (disabledBtns > 0) problems.push(`${disabledBtns} disabled button(s) on the page`);

    // Dead links
    let deadLinks = 0;
    document.querySelectorAll('a[href]').forEach(a => {
      const href = (a as HTMLAnchorElement).getAttribute('href') ?? '';
      if (href === '#' || href === 'javascript:void(0)' || href === 'javascript:;' || href === '') {
        deadLinks++;
      }
    });
    if (deadLinks > 0) problems.push(`${deadLinks} link(s) with dead href (# or javascript:void)`);

    // Inputs without type
    let untypedInputs = 0;
    document.querySelectorAll('input:not([type])').forEach(() => untypedInputs++);
    if (untypedInputs > 0)
      problems.push(`${untypedInputs} <input> element(s) without type attribute`);

    // Empty selects
    let emptySelects = 0;
    document.querySelectorAll('select').forEach(sel => {
      if ((sel as HTMLSelectElement).options.length === 0) emptySelects++;
    });
    if (emptySelects > 0) problems.push(`${emptySelects} <select> element(s) with no options`);

    // Tiny touch targets
    let tinyTouchTargets = 0;
    document
      .querySelectorAll(
        'a, button, [role="button"], input[type="checkbox"], input[type="radio"]',
      )
      .forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24)) {
          tinyTouchTargets++;
        }
      });
    if (tinyTouchTargets > 3)
      problems.push(
        `${tinyTouchTargets} interactive element(s) smaller than 24x24px (poor touch target)`,
      );

    return problems;
  });

  if (issues.length) {
    await addBug(page, ctx, {
      title: `${issues.length} interactive/functional issue(s)`,
      severity: issues.length > 3 ? 'High' : 'Medium',
      category: 'Functional',
      description: 'Interactive elements have usability or functional concerns.',
      steps: ['Open target URL', 'Inspect buttons, links, and form controls'],
      evidenceLabel: 'interactive',
      details: issues,
    });
  }
};

// 11. Responsive — mobile viewport ───────────────────────────────────────────

const checkResponsive = async (
  browserCtx: BrowserContext,
  ctx: RunContext,
  url: string,
) => {
  const mobilePage = await browserCtx.newPage();
  await mobilePage.setViewportSize({ width: 375, height: 812 });

  try {
    await mobilePage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await mobilePage.waitForTimeout(3_000);

    const issues = await mobilePage.evaluate(() => {
      const problems: string[] = [];
      const vw = 375;

      if (document.documentElement.scrollWidth > vw + 10) {
        problems.push(
          `Mobile: page is ${document.documentElement.scrollWidth}px wide on 375px viewport — horizontal scroll`,
        );
      }

      // Small text on mobile
      let tinyText = 0;
      document.querySelectorAll('p, span, a, li, td, th, label').forEach(el => {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs > 0 && fs < 12 && el.textContent?.trim()) tinyText++;
      });
      if (tinyText > 5) problems.push(`Mobile: ${tinyText} text element(s) with font-size < 12px`);

      // Elements overflowing
      let overflow = 0;
      document.querySelectorAll('body *').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > vw + 5) overflow++;
      });
      if (overflow > 0) problems.push(`Mobile: ${overflow} element(s) overflow the viewport`);

      return problems;
    });

    if (issues.length) {
      const shot = await takeScreenshot(mobilePage, ctx, 'responsive-mobile', true);
      const id = `BUG-${String(bugs.length + 1).padStart(3, '0')}`;
      bugs.push({
        id,
        title: `${issues.length} responsive design issue(s)`,
        severity: 'Medium',
        category: 'Layout',
        description: 'Page has layout problems at mobile viewport (375px).',
        steps: ['Open target URL on a 375px-wide viewport'],
        evidence: [shot],
        details: issues,
      });
      log(`${id} [Medium] ${issues.length} responsive design issue(s)`);
    }
  } catch {
    // mobile check is best-effort
  } finally {
    await mobilePage.close();
  }
};

// 12. Smart page exploration — scroll & trigger lazy loads ───────────────────

const explorePage = async (page: Page) => {
  log('Exploring page — scrolling to trigger lazy loads...');

  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportHeight = 720;
  const steps = Math.min(Math.ceil(scrollHeight / viewportHeight), 15);

  for (let i = 1; i <= steps; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * viewportHeight);
    await page.waitForTimeout(600);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1_000);
};

// 13. Web-app content issues ─────────────────────────────────────────────────

const checkWebAppIssues = async (page: Page, ctx: RunContext) => {
  const issues = await page.evaluate(() => {
    const problems: string[] = [];
    const bodyText = document.body.innerText.toLowerCase();

    // Error patterns in visible text
    const errorPatterns = [
      'something went wrong',
      'error occurred',
      'page not found',
      'internal server error',
      'undefined is not',
      'cannot read properties',
      'null reference',
      'loading failed',
      'network error',
      'connection refused',
      'oops',
      'sorry, something',
      'unexpected error',
      'an error has occurred',
      'failed to fetch',
      'module not found',
      'chunk load error',
    ];
    for (const pattern of errorPatterns) {
      if (bodyText.includes(pattern)) {
        const idx = bodyText.indexOf(pattern);
        const context = bodyText
          .slice(Math.max(0, idx - 40), idx + pattern.length + 40)
          .replace(/\n/g, ' ')
          .trim();
        problems.push(`Error text in page: "...${context}..."`);
      }
    }

    // Empty main content
    const main =
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('#root > div') ||
      document.querySelector('#app > div') ||
      document.querySelector('#__next > div');
    if (main) {
      const rect = main.getBoundingClientRect();
      const text = main.textContent?.trim() ?? '';
      if (rect.height < 50 && text.length < 10) {
        problems.push('Main content area appears empty or collapsed');
      }
    }

    // Visible spinners / loaders
    const spinnerSelectors = [
      '.spinner',
      '.loading',
      '.loader',
      '[class*="spin"]',
      '[class*="load"]',
      '[class*="skeleton"]',
    ];
    let visibleSpinners = 0;
    for (const sel of spinnerSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.display !== 'none' && cs.visibility !== 'hidden') visibleSpinners++;
      });
    }
    if (visibleSpinners > 0)
      problems.push(
        `${visibleSpinners} loading/spinner element(s) still visible after page settle`,
      );

    // Framework error overlays
    const overlay =
      document.querySelector('nextjs-portal') ||
      document.querySelector('[data-nextjs-toast]') ||
      document.querySelector('#webpack-dev-server-client-overlay');
    if (overlay) problems.push('Development error overlay is visible');

    // Almost blank page
    const allText = document.body.innerText.trim();
    if (allText.length < 20) {
      problems.push(
        'Page body has almost no visible text — possible blank screen or rendering failure',
      );
    }

    return problems;
  });

  if (issues.length) {
    await addBug(page, ctx, {
      title: `${issues.length} web-app content issue(s)`,
      severity: issues.some(i => i.includes('Error text') || i.includes('blank screen'))
        ? 'High'
        : 'Medium',
      category: 'Functional',
      description: 'Page content analysis detected error states or suspicious visual patterns.',
      steps: ['Open target URL', 'Observe page content'],
      evidenceLabel: 'webapp-issues',
      details: issues,
    });
  }
};

// 14. Click-through test ─────────────────────────────────────────────────────

const checkClickability = async (page: Page, ctx: RunContext, baseUrl: string) => {
  const clickTargets = await page.evaluate(() => {
    const targets: { selector: string; text: string }[] = [];
    const els = document.querySelectorAll(
      'nav a, header a, button:not([disabled]), [role="button"]',
    );
    const seen = new Set<string>();
    els.forEach(el => {
      if (targets.length >= 10) return;
      const text = el.textContent?.trim().slice(0, 40) ?? '';
      if (!text || seen.has(text)) return;
      seen.add(text);
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        targets.push({ selector: `${tag}${id}`, text });
      }
    });
    return targets;
  });

  const clickIssues: string[] = [];
  const startUrl = page.url();

  for (const target of clickTargets.slice(0, 8)) {
    try {
      const el = page.locator(`${target.selector}:has-text("${target.text.replace(/"/g, '\\"')}")`).first();
      const visible = await el.isVisible().catch(() => false);
      if (!visible) {
        clickIssues.push(`"${target.text}" — not visible/clickable`);
        continue;
      }
      const errorsBefore = pageErrors.length;
      await el.click({ timeout: 3_000 }).catch(() => {
        clickIssues.push(`"${target.text}" — click failed or blocked`);
      });
      await page.waitForTimeout(800);
      if (pageErrors.length > errorsBefore) {
        clickIssues.push(`"${target.text}" — clicking triggered a JS error`);
      }
      // Navigate back if needed
      const currentUrl = page.url();
      if (currentUrl !== startUrl) {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1_000);
      }
    } catch {
      // best-effort
    }
  }

  if (clickIssues.length) {
    await addBug(page, ctx, {
      title: `${clickIssues.length} click-through issue(s)`,
      severity: 'Medium',
      category: 'Functional',
      description: 'Some interactive elements could not be clicked or triggered errors.',
      steps: ['Open target URL', 'Click navigation links and buttons'],
      evidenceLabel: 'click-test',
      details: clickIssues,
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTONOMOUS WORKFLOW ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

type WorkflowStep = {
  action: string;
  target?: string;
  value?: string;
  expect?: string;
};

type WorkflowResult = {
  name: string;
  steps: WorkflowStep[];
  passed: boolean;
  error?: string;
};

const workflowResults: WorkflowResult[] = [];

// ── Helper: safe action wrapper ─────────────────────────────────────────────

const safeAction = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try { return await fn(); } catch { return fallback; }
};

const waitForStable = async (page: Page, ms = 1500) => {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined)))));
};

// ── 15. Site crawler — discover & test all internal pages ───────────────────

const crawlSitePages = async (page: Page, ctx: RunContext, baseUrl: string) => {
  log('Crawling site — discovering internal pages...');

  const origin = new URL(baseUrl).origin;

  // Discover all internal links from the landing page
  const internalLinks: string[] = await page.evaluate((orig) => {
    const links = new Set<string>();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = (a as HTMLAnchorElement).href;
      if (href.startsWith(orig) && !href.includes('#') && !href.includes('mailto:') && !href.includes('javascript:')) {
        links.add(href.split('?')[0]); // strip query params for uniqueness
      }
    });
    return [...links];
  }, origin);

  const uniquePages = [...new Set(internalLinks)].filter(u => u !== baseUrl).slice(0, 12);
  log(`Found ${uniquePages.length} internal page(s) to crawl`);

  const pageIssues: string[] = [];
  const visitedPages: { url: string; title: string; status: number; errors: number }[] = [];

  for (const pageUrl of uniquePages) {
    const errorsBefore = pageErrors.length;
    const consoleBefore = consoleErrors.length;
    const networkBefore = failedRequests.length;

    try {
      const res = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForStable(page, 2000);

      const status = res?.status() ?? 0;
      const title = await page.title();

      visitedPages.push({
        url: pageUrl,
        title,
        status,
        errors: (pageErrors.length - errorsBefore) + (consoleErrors.length - consoleBefore),
      });

      // Check each sub-page for problems
      if (status >= 400) {
        pageIssues.push(`${pageUrl} -> HTTP ${status}`);
        await takeScreenshot(page, ctx, `crawl-${status}-${slug(pageUrl)}`, true);
      }
      if (pageErrors.length > errorsBefore) {
        pageIssues.push(`${pageUrl} -> ${pageErrors.length - errorsBefore} JS error(s) on load`);
      }
      if (consoleErrors.length > consoleBefore) {
        pageIssues.push(`${pageUrl} -> ${consoleErrors.length - consoleBefore} console error(s)`);
      }

      // Quick content check
      const bodyText = await page.evaluate(() => document.body.innerText?.trim() ?? '');
      if (bodyText.length < 20) {
        pageIssues.push(`${pageUrl} -> blank or near-empty page`);
        await takeScreenshot(page, ctx, `crawl-blank-${slug(pageUrl)}`, true);
      }

      // Check for visible error messages on sub-pages
      const hasErrorText = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return ['something went wrong', 'error', '404', '500', 'not found', 'oops'].some(p => text.includes(p));
      });
      if (hasErrorText) {
        pageIssues.push(`${pageUrl} -> error message visible in page content`);
        await takeScreenshot(page, ctx, `crawl-error-${slug(pageUrl)}`, true);
      }

    } catch (err) {
      pageIssues.push(`${pageUrl} -> failed to load (timeout or crash)`);
    }
  }

  // Navigate back to base
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
  await waitForStable(page);

  if (pageIssues.length) {
    await addBug(page, ctx, {
      title: `${pageIssues.length} issue(s) across ${uniquePages.length} crawled pages`,
      severity: pageIssues.length > 3 ? 'High' : 'Medium',
      category: 'Navigation',
      description: `Site crawl visited ${uniquePages.length} internal pages and found issues.`,
      steps: ['Open target URL', 'Navigate through all internal links'],
      evidenceLabel: 'site-crawl',
      details: [
        `Pages visited: ${visitedPages.length}`,
        ...pageIssues,
      ],
    });
  }

  workflowResults.push({
    name: 'Site Page Crawl',
    steps: uniquePages.map(u => ({ action: 'navigate', target: u })),
    passed: pageIssues.length === 0,
    error: pageIssues.length ? `${pageIssues.length} issue(s) found` : undefined,
  });

  return visitedPages;
};

// ── 16. Form workflow testing ───────────────────────────────────────────────

const testFormWorkflows = async (page: Page, ctx: RunContext) => {
  log('Testing form workflows...');

  const forms = await page.evaluate(() => {
    const results: {
      index: number;
      action: string;
      method: string;
      inputCount: number;
      hasSubmit: boolean;
      inputs: { type: string; name: string; placeholder: string; required: boolean; selector: string }[];
    }[] = [];

    document.querySelectorAll('form').forEach((form, i) => {
      const inputs = Array.from(form.querySelectorAll('input, textarea, select')).map((inp, j) => {
        const el = inp as HTMLInputElement;
        return {
          type: el.type || 'text',
          name: el.name || el.id || `input-${j}`,
          placeholder: el.placeholder || '',
          required: el.required,
          selector: el.id ? `#${el.id}` : `form:nth-of-type(${i + 1}) input:nth-of-type(${j + 1})`,
        };
      });
      results.push({
        index: i,
        action: form.action || '',
        method: form.method || 'get',
        inputCount: inputs.length,
        hasSubmit: !!form.querySelector('button[type="submit"], input[type="submit"]'),
        inputs: inputs.filter(inp => inp.type !== 'hidden'),
      });
    });
    return results;
  });

  // Also find standalone inputs not inside forms (common in SPAs)
  const standaloneInputs = await page.evaluate(() => {
    const results: { type: string; placeholder: string; selector: string }[] = [];
    document.querySelectorAll('input:not(form input), textarea:not(form textarea)').forEach((inp, i) => {
      const el = inp as HTMLInputElement;
      if (el.type === 'hidden') return;
      results.push({
        type: el.type || 'text',
        placeholder: el.placeholder || '',
        selector: el.id ? `#${el.id}` : `input[placeholder="${el.placeholder}"]`,
      });
    });
    return results;
  });

  const formIssues: string[] = [];

  // Test formal <form> elements
  for (const form of forms) {
    const workflowSteps: WorkflowStep[] = [];

    for (const inp of form.inputs.slice(0, 6)) {
      const testValue = getTestValue(inp.type, inp.placeholder, inp.name);
      try {
        const locator = page.locator(inp.selector).first();
        if (await locator.isVisible().catch(() => false)) {
          await locator.click({ timeout: 2_000 }).catch(() => {});
          await locator.fill(testValue, { timeout: 2_000 }).catch(() => {});
          workflowSteps.push({ action: 'fill', target: inp.name, value: testValue });

          // Check for inline validation errors
          await page.waitForTimeout(500);
          const hasValidation = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const parent = el.parentElement;
            if (!parent) return false;
            const errorEl = parent.querySelector('.error, .invalid, [class*="error"], [class*="invalid"]');
            return !!errorEl;
          }, inp.selector);

          if (hasValidation) {
            formIssues.push(`Form input "${inp.name}" showed validation error for test value "${testValue}"`);
            workflowSteps.push({ action: 'observe', expect: 'validation error shown' });
          }
        }
      } catch { /* best-effort */ }
    }

    // Try submitting if there's a submit button
    if (form.hasSubmit) {
      const errorsBefore = pageErrors.length;
      try {
        const submitBtn = page.locator(`form:nth-of-type(${form.index + 1}) button[type="submit"], form:nth-of-type(${form.index + 1}) input[type="submit"]`).first();
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click({ timeout: 3_000 });
          await page.waitForTimeout(1500);
          workflowSteps.push({ action: 'click', target: 'submit button' });

          if (pageErrors.length > errorsBefore) {
            formIssues.push(`Form submission triggered ${pageErrors.length - errorsBefore} JS error(s)`);
          }
        }
      } catch { /* best-effort */ }
    }

    workflowResults.push({
      name: `Form Workflow (${form.inputs[0]?.name || `form-${form.index}`})`,
      steps: workflowSteps,
      passed: formIssues.length === 0,
      error: formIssues.length ? formIssues.join('; ') : undefined,
    });
  }

  // Test standalone inputs (SPA style)
  for (const inp of standaloneInputs.slice(0, 5)) {
    const testValue = getTestValue(inp.type, inp.placeholder, '');
    try {
      const locator = page.locator(inp.selector).first();
      if (await locator.isVisible().catch(() => false)) {
        const errorsBefore = pageErrors.length;
        await locator.click({ timeout: 2_000 });
        await locator.fill(testValue, { timeout: 2_000 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);

        if (pageErrors.length > errorsBefore) {
          formIssues.push(`Input "${inp.placeholder || inp.type}" triggered JS error on Enter`);
        }

        // Clear it
        await locator.fill('', { timeout: 1_000 }).catch(() => {});
      }
    } catch { /* best-effort */ }
  }

  if (formIssues.length) {
    await addBug(page, ctx, {
      title: `${formIssues.length} form workflow issue(s)`,
      severity: 'High',
      category: 'Functional',
      description: 'Form interaction testing found validation or submission problems.',
      steps: ['Open target URL', 'Fill in form fields', 'Submit'],
      evidenceLabel: 'form-workflow',
      details: formIssues,
    });
  }
};

// ── Test value generator ────────────────────────────────────────────────────

const getTestValue = (type: string, placeholder: string, name: string): string => {
  const hint = `${placeholder} ${name}`.toLowerCase();
  if (type === 'email' || hint.includes('email')) return 'test@example.com';
  if (type === 'password' || hint.includes('password')) return 'TestPass123!';
  if (type === 'number' || hint.includes('amount') || hint.includes('quantity') || hint.includes('price')) return '100';
  if (type === 'tel' || hint.includes('phone')) return '+1234567890';
  if (type === 'url' || hint.includes('url') || hint.includes('website')) return 'https://example.com';
  if (hint.includes('search') || hint.includes('find')) return 'test search query';
  if (hint.includes('address') || hint.includes('wallet')) return '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  if (hint.includes('name') || hint.includes('user')) return 'Test User';
  if (hint.includes('token') || hint.includes('coin') || hint.includes('sol')) return 'SOL';
  if (type === 'date') return '2026-01-15';
  return '42';
};

// ── 17. Modal & dialog testing ──────────────────────────────────────────────

const testModals = async (page: Page, ctx: RunContext) => {
  log('Testing modals and dialogs...');

  const modalIssues: string[] = [];

  // Find triggers that commonly open modals
  const modalTriggers = await page.evaluate(() => {
    const triggers: { text: string; tag: string; index: number }[] = [];
    const candidates = document.querySelectorAll(
      'button, [role="button"], a[href="#"], [data-toggle="modal"], [data-bs-toggle="modal"], ' +
      '[class*="modal"], [class*="dialog"], [class*="popup"], [class*="connect"], [class*="wallet"]'
    );
    const seen = new Set<string>();
    candidates.forEach((el, i) => {
      const text = el.textContent?.trim().slice(0, 50) ?? '';
      if (!text || seen.has(text)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      seen.add(text);
      const lowerText = text.toLowerCase();
      // Prioritize things that look like modal triggers
      if (
        lowerText.includes('connect') || lowerText.includes('wallet') ||
        lowerText.includes('settings') || lowerText.includes('menu') ||
        lowerText.includes('open') || lowerText.includes('sign') ||
        lowerText.includes('login') || lowerText.includes('select') ||
        lowerText.includes('choose') || lowerText.includes('filter') ||
        lowerText.includes('more') || lowerText.includes('detail') ||
        el.getAttribute('data-toggle') || el.getAttribute('data-bs-toggle') ||
        el.getAttribute('aria-haspopup')
      ) {
        triggers.push({ text, tag: el.tagName.toLowerCase(), index: i });
      }
    });
    return triggers.slice(0, 8);
  });

  for (const trigger of modalTriggers) {
    try {
      // Click the trigger
      const locator = page.getByText(trigger.text, { exact: false }).first();
      if (!(await locator.isVisible().catch(() => false))) continue;

      const errorsBefore = pageErrors.length;
      await locator.click({ timeout: 3_000 });
      await page.waitForTimeout(1200);

      // Detect if a modal/dialog/overlay appeared
      const modalInfo = await page.evaluate(() => {
        // Check for common modal patterns
        const selectors = [
          '[role="dialog"]', '[role="alertdialog"]',
          '.modal.show', '.modal[style*="display: block"]',
          '[class*="modal"][class*="open"]', '[class*="modal"][class*="active"]',
          '[class*="overlay"][class*="open"]', '[class*="overlay"][class*="active"]',
          '[class*="popup"][class*="open"]', '[class*="popup"][class*="visible"]',
          '[class*="dialog"][class*="open"]', '.ReactModal__Content',
          '[data-state="open"]', '[aria-modal="true"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            return {
              found: true,
              selector: sel,
              hasCloseBtn: !!el.querySelector('button[aria-label="Close"], button[class*="close"], .close, [class*="dismiss"]'),
              text: el.textContent?.trim().slice(0, 100) ?? '',
              width: rect.width,
              height: rect.height,
            };
          }
        }
        return { found: false, selector: '', hasCloseBtn: false, text: '', width: 0, height: 0 };
      });

      if (modalInfo.found) {
        await takeScreenshot(page, ctx, `modal-${slug(trigger.text)}`, false);

        // Test: modal should be dismissible
        if (!modalInfo.hasCloseBtn) {
          modalIssues.push(`Modal opened by "${trigger.text}" has no visible close button`);
        }

        // Test: modal should have content
        if (!modalInfo.text || modalInfo.text.length < 5) {
          modalIssues.push(`Modal opened by "${trigger.text}" appears empty`);
        }

        // Test: Escape key should close it
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        const stillOpen = await page.evaluate((sel) => !!document.querySelector(sel), modalInfo.selector);
        if (stillOpen) {
          // Try clicking a close button
          const closed = await page.evaluate(() => {
            const btn = document.querySelector('[role="dialog"] button[aria-label="Close"], .modal button.close, [class*="close"]') as HTMLElement;
            if (btn) { btn.click(); return true; }
            return false;
          });
          await page.waitForTimeout(500);
          if (!closed) {
            modalIssues.push(`Modal opened by "${trigger.text}" cannot be dismissed with Escape key`);
          }
        }

        // Check for errors triggered by modal
        if (pageErrors.length > errorsBefore) {
          modalIssues.push(`Modal "${trigger.text}" triggered ${pageErrors.length - errorsBefore} JS error(s)`);
        }

        workflowResults.push({
          name: `Modal: "${trigger.text}"`,
          steps: [
            { action: 'click', target: trigger.text },
            { action: 'observe', expect: 'modal opens' },
            { action: 'press', target: 'Escape' },
            { action: 'observe', expect: 'modal closes' },
          ],
          passed: !modalIssues.some(i => i.includes(trigger.text)),
        });

      } else {
        // Still navigate back if we left
        const currentUrl = page.url();
        const btn = page.url();
        await page.waitForTimeout(300);
      }

      // Cleanup: try to close any remaining overlays
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);

    } catch { /* best-effort */ }
  }

  if (modalIssues.length) {
    await addBug(page, ctx, {
      title: `${modalIssues.length} modal/dialog issue(s)`,
      severity: 'Medium',
      category: 'Functional',
      description: 'Modal and dialog interactions have usability problems.',
      steps: ['Open target URL', 'Click buttons that open modals', 'Try to dismiss them'],
      evidenceLabel: 'modal-issues',
      details: modalIssues,
    });
  }
};

// ── 18. Dropdown & tab/panel testing ────────────────────────────────────────

const testDropdownsAndTabs = async (page: Page, ctx: RunContext) => {
  log('Testing dropdowns and tab panels...');

  const issues: string[] = [];

  // Find tab-like elements
  const tabs = await page.evaluate(() => {
    const results: { text: string; selector: string; isActive: boolean }[] = [];
    const tabEls = document.querySelectorAll(
      '[role="tab"], [role="tablist"] > *, .tab, [class*="tab-item"], [class*="tab-btn"], ' +
      '[class*="TabItem"], [class*="TabBtn"], [data-tab], .nav-tab, .nav-pill'
    );
    const seen = new Set<string>();
    tabEls.forEach((el, i) => {
      const text = el.textContent?.trim().slice(0, 30) ?? '';
      if (!text || seen.has(text)) return;
      seen.add(text);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const isActive =
        el.classList.contains('active') ||
        el.getAttribute('aria-selected') === 'true' ||
        el.getAttribute('data-state') === 'active';
      results.push({ text, selector: el.id ? `#${el.id}` : `[role="tab"]:nth-of-type(${i + 1})`, isActive });
    });
    return results.slice(0, 8);
  });

  for (const tab of tabs) {
    if (tab.isActive) continue; // skip already-active tab
    try {
      const locator = page.getByText(tab.text, { exact: false }).first();
      if (!(await locator.isVisible().catch(() => false))) continue;

      const errorsBefore = pageErrors.length;
      await locator.click({ timeout: 2_000 });
      await page.waitForTimeout(800);

      // Check if tab became active
      const becameActive = await page.evaluate((txt) => {
        const els = document.querySelectorAll('[role="tab"], [class*="tab"]');
        for (const el of els) {
          if (el.textContent?.trim().startsWith(txt)) {
            return el.classList.contains('active') ||
              el.getAttribute('aria-selected') === 'true' ||
              el.getAttribute('data-state') === 'active';
          }
        }
        return null; // can't determine
      }, tab.text);

      if (becameActive === false) {
        issues.push(`Tab "${tab.text}" did not become active after click`);
      }

      if (pageErrors.length > errorsBefore) {
        issues.push(`Tab "${tab.text}" triggered ${pageErrors.length - errorsBefore} JS error(s)`);
      }

      workflowResults.push({
        name: `Tab switch: "${tab.text}"`,
        steps: [
          { action: 'click', target: tab.text },
          { action: 'observe', expect: 'tab content changes' },
        ],
        passed: becameActive !== false && pageErrors.length === errorsBefore,
      });

    } catch { /* best-effort */ }
  }

  // Find dropdowns
  const dropdowns = await page.evaluate(() => {
    const results: { text: string; hasPopup: boolean }[] = [];
    const ddEls = document.querySelectorAll(
      'select, [role="listbox"], [role="combobox"], [role="menu"], ' +
      '[class*="dropdown"], [class*="select"], [class*="Dropdown"], [class*="Select"], ' +
      '[aria-haspopup="listbox"], [aria-haspopup="menu"], [aria-haspopup="true"]'
    );
    const seen = new Set<string>();
    ddEls.forEach(el => {
      const text = el.textContent?.trim().slice(0, 40) ?? '';
      if (!text || seen.has(text)) return;
      seen.add(text);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      results.push({
        text,
        hasPopup: el.tagName === 'SELECT' || !!el.getAttribute('aria-haspopup'),
      });
    });
    return results.slice(0, 8);
  });

  for (const dd of dropdowns) {
    try {
      const locator = page.getByText(dd.text, { exact: false }).first();
      if (!(await locator.isVisible().catch(() => false))) continue;

      const errorsBefore = pageErrors.length;
      await locator.click({ timeout: 2_000 });
      await page.waitForTimeout(600);

      // Check if dropdown opened
      const menuOpened = await page.evaluate(() => {
        const menus = document.querySelectorAll(
          '[role="listbox"], [role="menu"], [class*="dropdown-menu"], ' +
          '[class*="options"], [class*="menu-list"], [data-state="open"], ' +
          '[class*="DropdownMenu"], [class*="SelectMenu"]'
        );
        for (const m of menus) {
          const cs = getComputedStyle(m);
          if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
        }
        return false;
      });

      if (dd.hasPopup && !menuOpened) {
        issues.push(`Dropdown "${dd.text.slice(0, 30)}" did not open on click`);
      }

      if (pageErrors.length > errorsBefore) {
        issues.push(`Dropdown "${dd.text.slice(0, 30)}" triggered JS error`);
      }

      // Close dropdown
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      workflowResults.push({
        name: `Dropdown: "${dd.text.slice(0, 30)}"`,
        steps: [
          { action: 'click', target: dd.text.slice(0, 30) },
          { action: 'observe', expect: 'dropdown opens' },
        ],
        passed: pageErrors.length === errorsBefore,
      });

    } catch { /* best-effort */ }
  }

  if (issues.length) {
    await addBug(page, ctx, {
      title: `${issues.length} dropdown/tab issue(s)`,
      severity: 'Medium',
      category: 'Functional',
      description: 'Tab panel or dropdown interactions failed or triggered errors.',
      steps: ['Open target URL', 'Click tabs and dropdowns'],
      evidenceLabel: 'dropdown-tab-issues',
      details: issues,
    });
  }
};

// ── 19. Wallet / Connect flow testing (DeFi/Web3) ──────────────────────────

const testWalletFlow = async (page: Page, ctx: RunContext) => {
  log('Testing wallet connection flows...');

  const walletIssues: string[] = [];

  // Find wallet/connect buttons
  const connectBtns = await page.evaluate(() => {
    const results: { text: string }[] = [];
    const allBtns = document.querySelectorAll('button, [role="button"], a');
    allBtns.forEach(btn => {
      const text = btn.textContent?.trim().toLowerCase() ?? '';
      if (
        text.includes('connect') || text.includes('wallet') ||
        text.includes('sign in') || text.includes('login') ||
        text.includes('authenticate') || text.includes('phantom') ||
        text.includes('solflare') || text.includes('metamask')
      ) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          results.push({ text: btn.textContent?.trim().slice(0, 50) ?? '' });
        }
      }
    });
    return results.slice(0, 4);
  });

  for (const btn of connectBtns) {
    try {
      const locator = page.getByText(btn.text, { exact: false }).first();
      if (!(await locator.isVisible().catch(() => false))) continue;

      const errorsBefore = pageErrors.length;
      await locator.click({ timeout: 3_000 });
      await page.waitForTimeout(1500);

      // Capture what happened
      await takeScreenshot(page, ctx, `wallet-${slug(btn.text)}`, false);

      // Check for wallet adapter modal
      const adapterInfo = await page.evaluate(() => {
        const walletIndicators = [
          '[class*="wallet"]', '[class*="Wallet"]',
          '[class*="adapter"]', '[class*="Adapter"]',
          '[class*="connect"]', '[class*="Connect"]',
          '[role="dialog"]', '.modal',
        ];
        for (const sel of walletIndicators) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 50) {
              return {
                found: true,
                text: el.textContent?.trim().slice(0, 200) ?? '',
                hasWalletOptions: !!el.querySelector('li, button, [class*="option"], [class*="item"]'),
              };
            }
          }
        }
        return { found: false, text: '', hasWalletOptions: false };
      });

      if (adapterInfo.found) {
        if (!adapterInfo.hasWalletOptions) {
          walletIssues.push(`"${btn.text}" opened but shows no wallet options`);
        }
      }

      if (pageErrors.length > errorsBefore) {
        walletIssues.push(`"${btn.text}" triggered ${pageErrors.length - errorsBefore} JS error(s)`);
      }

      // Dismiss
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      workflowResults.push({
        name: `Wallet/Connect: "${btn.text}"`,
        steps: [
          { action: 'click', target: btn.text },
          { action: 'observe', expect: 'wallet modal or prompt appears' },
          { action: 'press', target: 'Escape' },
        ],
        passed: pageErrors.length === errorsBefore,
        error: walletIssues.length ? walletIssues.join('; ') : undefined,
      });

    } catch { /* best-effort */ }
  }

  if (walletIssues.length) {
    await addBug(page, ctx, {
      title: `${walletIssues.length} wallet/connect flow issue(s)`,
      severity: 'High',
      category: 'Functional',
      description: 'Wallet connection workflow encountered errors or UX problems.',
      steps: ['Open target URL', 'Click Connect Wallet / Sign In'],
      evidenceLabel: 'wallet-flow',
      details: walletIssues,
    });
  }
};

// ── 20. Navigation workflow testing ─────────────────────────────────────────

const testNavigationWorkflows = async (page: Page, ctx: RunContext, baseUrl: string) => {
  log('Testing navigation workflows...');

  const navIssues: string[] = [];

  // Discover nav items
  const navItems = await page.evaluate(() => {
    const items: { text: string; href: string }[] = [];
    const navLinks = document.querySelectorAll('nav a, header a, [role="navigation"] a');
    const seen = new Set<string>();
    navLinks.forEach(a => {
      const text = a.textContent?.trim().slice(0, 40) ?? '';
      const href = (a as HTMLAnchorElement).href;
      if (!text || seen.has(text)) return;
      const rect = a.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      seen.add(text);
      items.push({ text, href });
    });
    return items.slice(0, 10);
  });

  log(`Found ${navItems.length} navigation items to test`);

  for (const item of navItems) {
    const steps: WorkflowStep[] = [];
    try {
      const errorsBefore = pageErrors.length;
      const locator = page.getByText(item.text, { exact: false }).first();

      if (!(await locator.isVisible().catch(() => false))) {
        navIssues.push(`Nav item "${item.text}" is not visible`);
        continue;
      }

      await locator.click({ timeout: 3_000 });
      steps.push({ action: 'click', target: item.text });
      await page.waitForTimeout(2000);

      const newUrl = page.url();
      const pageTitle = await page.title();

      // Check: did the URL change?
      steps.push({ action: 'observe', expect: `navigate to ${newUrl}` });

      // Check for errors
      if (pageErrors.length > errorsBefore) {
        navIssues.push(`Navigating to "${item.text}" triggered ${pageErrors.length - errorsBefore} JS error(s)`);
        await takeScreenshot(page, ctx, `nav-error-${slug(item.text)}`, true);
      }

      // Check: does the page have content?
      const bodyLen = await page.evaluate(() => document.body.innerText.trim().length);
      if (bodyLen < 20) {
        navIssues.push(`"${item.text}" leads to a blank/empty page (${newUrl})`);
        await takeScreenshot(page, ctx, `nav-blank-${slug(item.text)}`, true);
      }

      // Check: did any error text appear?
      const errorText = await page.evaluate(() => {
        const t = document.body.innerText.toLowerCase();
        const patterns = ['not found', '404', 'error', 'something went wrong', 'oops'];
        return patterns.find(p => t.includes(p)) || null;
      });
      if (errorText) {
        navIssues.push(`"${item.text}" -> page shows "${errorText}" text`);
        await takeScreenshot(page, ctx, `nav-errtext-${slug(item.text)}`, true);
      }

      // Test browser back
      await page.goBack({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(800);
      steps.push({ action: 'goBack' });

      const backUrl = page.url();
      const backBodyLen = await page.evaluate(() => document.body.innerText.trim().length);
      if (backBodyLen < 20 && backUrl !== baseUrl) {
        navIssues.push(`Back button after "${item.text}" leads to blank page`);
      }

      workflowResults.push({
        name: `Navigation: "${item.text}"`,
        steps,
        passed: !navIssues.some(i => i.includes(item.text)),
      });

    } catch {
      navIssues.push(`"${item.text}" — navigation interaction failed`);
    }
  }

  // Return to base
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
  await waitForStable(page);

  if (navIssues.length) {
    await addBug(page, ctx, {
      title: `${navIssues.length} navigation workflow issue(s)`,
      severity: navIssues.some(i => i.includes('JS error') || i.includes('blank')) ? 'High' : 'Medium',
      category: 'Navigation',
      description: 'Testing navigation links found broken flows or errors.',
      steps: ['Open target URL', 'Click through each navigation link'],
      evidenceLabel: 'nav-workflow',
      details: navIssues,
    });
  }
};

// ── 21. Hover / tooltip testing ─────────────────────────────────────────────

const testHoverInteractions = async (page: Page, ctx: RunContext) => {
  log('Testing hover / tooltip interactions...');

  const issues: string[] = [];

  const hoverTargets = await page.evaluate(() => {
    const targets: { text: string; hasTitle: boolean }[] = [];
    const els = document.querySelectorAll(
      '[title], [data-tooltip], [data-tip], [aria-describedby], ' +
      '[class*="tooltip"], [class*="Tooltip"], [class*="hover"]'
    );
    const seen = new Set<string>();
    els.forEach(el => {
      const text = el.textContent?.trim().slice(0, 30) ?? '';
      if (!text || seen.has(text)) return;
      seen.add(text);
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        targets.push({
          text,
          hasTitle: !!el.getAttribute('title') || !!el.getAttribute('data-tooltip'),
        });
      }
    });
    return targets.slice(0, 6);
  });

  for (const target of hoverTargets) {
    try {
      const locator = page.getByText(target.text, { exact: false }).first();
      if (!(await locator.isVisible().catch(() => false))) continue;

      const errorsBefore = pageErrors.length;
      await locator.hover({ timeout: 2_000 });
      await page.waitForTimeout(800);

      if (pageErrors.length > errorsBefore) {
        issues.push(`Hovering "${target.text}" triggered JS error`);
      }

      // Check if tooltip appeared
      const tooltipVisible = await page.evaluate(() => {
        const tips = document.querySelectorAll(
          '[role="tooltip"], [class*="tooltip"][class*="show"], [class*="tooltip"][class*="visible"], ' +
          '[class*="Tooltip"][class*="open"], [data-state="open"]'
        );
        for (const t of tips) {
          const cs = getComputedStyle(t);
          if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') return true;
        }
        return false;
      });

      workflowResults.push({
        name: `Hover: "${target.text}"`,
        steps: [
          { action: 'hover', target: target.text },
          { action: 'observe', expect: 'tooltip appears' },
        ],
        passed: pageErrors.length === errorsBefore,
      });

    } catch { /* best-effort */ }
  }

  if (issues.length) {
    await addBug(page, ctx, {
      title: `${issues.length} hover interaction issue(s)`,
      severity: 'Low',
      category: 'Functional',
      description: 'Hover interactions triggered errors.',
      steps: ['Open target URL', 'Hover over interactive elements'],
      evidenceLabel: 'hover-issues',
      details: issues,
    });
  }
};

// ── 22. Keyboard navigation test ────────────────────────────────────────────

const testKeyboardNav = async (page: Page, ctx: RunContext) => {
  log('Testing keyboard navigation...');

  const issues: string[] = [];

  // Tab through the first N focusable elements
  const errorsBefore = pageErrors.length;
  const focusedElements: string[] = [];

  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);

    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return {
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim().slice(0, 30) ?? '',
        hasOutline: getComputedStyle(el).outlineStyle !== 'none',
        role: el.getAttribute('role') ?? '',
      };
    });

    if (focused) {
      focusedElements.push(`${focused.tag}${focused.role ? `[${focused.role}]` : ''}: "${focused.text}"`);
      if (!focused.hasOutline) {
        issues.push(`No visible focus indicator on ${focused.tag}: "${focused.text}"`);
      }
    }
  }

  // Check if focus got stuck (no movement)
  const uniqueFocused = new Set(focusedElements);
  if (uniqueFocused.size < 3 && focusedElements.length > 5) {
    issues.push('Focus appears stuck — Tab key does not move through elements properly');
  }

  if (pageErrors.length > errorsBefore) {
    issues.push(`Keyboard navigation triggered ${pageErrors.length - errorsBefore} JS error(s)`);
  }

  workflowResults.push({
    name: 'Keyboard Navigation',
    steps: [
      { action: 'press', target: 'Tab x15' },
      { action: 'observe', expect: 'focus moves through interactive elements' },
    ],
    passed: issues.length === 0,
    error: issues.length ? issues.join('; ') : undefined,
  });

  if (issues.length) {
    await addBug(page, ctx, {
      title: `${issues.length} keyboard navigation issue(s)`,
      severity: 'Medium',
      category: 'Accessibility',
      description: 'Keyboard-only navigation found focus management problems.',
      steps: ['Open target URL', 'Press Tab repeatedly'],
      evidenceLabel: 'keyboard-nav',
      details: issues.slice(0, 15),
    });
  }
};

// ── 23. Scroll-based interaction testing ────────────────────────────────────

const testScrollInteractions = async (page: Page, ctx: RunContext) => {
  log('Testing scroll-based interactions...');

  const issues: string[] = [];
  const errorsBefore = pageErrors.length;

  // Scroll to bottom quickly
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  // Check for infinite scroll / load-more functionality
  const infiniteScroll = await page.evaluate(() => {
    const bodyHeight1 = document.body.scrollHeight;
    window.scrollTo(0, bodyHeight1);
    return { firstHeight: bodyHeight1 };
  });
  await page.waitForTimeout(2000);
  const newHeight = await page.evaluate(() => document.body.scrollHeight);
  const hasInfiniteScroll = newHeight > infiniteScroll.firstHeight;

  // Check for back-to-top button
  const hasBackToTop = await page.evaluate(() => {
    const btns = document.querySelectorAll(
      '[class*="back-to-top"], [class*="scroll-top"], [class*="BackToTop"], [class*="ScrollTop"], [aria-label*="top"]'
    );
    for (const btn of btns) {
      const cs = getComputedStyle(btn);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
    }
    return false;
  });

  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // Check for sticky/fixed header
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(500);
  const stickyHeader = await page.evaluate(() => {
    const header = document.querySelector('header, nav, [role="navigation"]');
    if (!header) return false;
    const cs = getComputedStyle(header);
    return cs.position === 'fixed' || cs.position === 'sticky';
  });

  if (pageErrors.length > errorsBefore) {
    issues.push(`Scrolling triggered ${pageErrors.length - errorsBefore} JS error(s)`);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  workflowResults.push({
    name: 'Scroll Interactions',
    steps: [
      { action: 'scroll', target: 'bottom' },
      { action: 'observe', expect: `infinite scroll: ${hasInfiniteScroll}, sticky header: ${stickyHeader}` },
      { action: 'scroll', target: 'top' },
    ],
    passed: issues.length === 0,
    error: issues.length ? issues.join('; ') : undefined,
  });

  if (issues.length) {
    await addBug(page, ctx, {
      title: `${issues.length} scroll interaction issue(s)`,
      severity: 'Medium',
      category: 'Functional',
      description: 'Scroll-based interactions triggered problems.',
      steps: ['Open target URL', 'Scroll to bottom and back'],
      evidenceLabel: 'scroll-issues',
      details: issues,
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  REPORT WRITER
// ═══════════════════════════════════════════════════════════════════════════════

const writeReport = async (ctx: RunContext, url: string, scope: string) => {
  const L: string[] = [];

  L.push(`# QA Test Report`);
  L.push('');
  L.push(`| Field | Value |`);
  L.push(`|-------|-------|`);
  L.push(`| URL | ${url} |`);
  L.push(`| Run | ${ctx.runId} |`);
  L.push(`| Date | ${new Date().toISOString()} |`);
  L.push(`| Browser | Chromium (Playwright, headless) |`);
  L.push(`| Scope | ${scope} |`);
  L.push(`| Bugs Found | **${bugs.length}** |`);
  L.push('');

  // Summary by severity
  const bySev = (s: Severity) => bugs.filter(b => b.severity === s).length;
  L.push(`## Summary`);
  L.push('');
  L.push(`| Severity | Count |`);
  L.push(`|----------|-------|`);
  L.push(`| Critical | ${bySev('Critical')} |`);
  L.push(`| High | ${bySev('High')} |`);
  L.push(`| Medium | ${bySev('Medium')} |`);
  L.push(`| Low | ${bySev('Low')} |`);
  L.push('');

  // Categories
  const cats = [...new Set(bugs.map(b => b.category))];
  if (cats.length) {
    L.push(`| Category | Count |`);
    L.push(`|----------|-------|`);
    for (const c of cats) L.push(`| ${c} | ${bugs.filter(b => b.category === c).length} |`);
    L.push('');
  }

  // Runtime signals
  if (consoleErrors.length || pageErrors.length || consoleWarnings.length) {
    L.push(`## Runtime Signals`);
    L.push('');
    if (consoleErrors.length) {
      L.push(`### Console Errors (${consoleErrors.length})`);
      consoleErrors.slice(0, 25).forEach(e => L.push(`- \`${e}\``));
      L.push('');
    }
    if (pageErrors.length) {
      L.push(`### Uncaught Exceptions (${pageErrors.length})`);
      pageErrors.slice(0, 25).forEach(e => L.push(`- \`${e}\``));
      L.push('');
    }
    if (consoleWarnings.length) {
      L.push(`### Console Warnings (${consoleWarnings.length})`);
      consoleWarnings.slice(0, 10).forEach(e => L.push(`- \`${e}\``));
      L.push('');
    }
  }

  // Failed network requests
  if (failedRequests.length) {
    L.push(`## Failed Network Requests (${failedRequests.length})`);
    L.push('');
    failedRequests.slice(0, 30).forEach(r => {
      L.push(`- \`${r.method} ${r.url}\` -> ${r.status ?? r.failure} (${r.resourceType})`);
    });
    L.push('');
  }

  // Workflow test results
  if (workflowResults.length) {
    L.push(`## Workflow Test Results`);
    L.push('');
    const passed = workflowResults.filter(w => w.passed).length;
    const failed = workflowResults.filter(w => !w.passed).length;
    L.push(`| Metric | Count |`);
    L.push(`|--------|-------|`);
    L.push(`| Total Workflows | ${workflowResults.length} |`);
    L.push(`| Passed | ${passed} |`);
    L.push(`| Failed | ${failed} |`);
    L.push('');

    for (const wf of workflowResults) {
      const icon = wf.passed ? 'PASS' : 'FAIL';
      L.push(`#### [${icon}] ${wf.name}`);
      L.push('');
      if (wf.steps.length) {
        L.push('| Step | Action | Target | Expected |');
        L.push('|------|--------|--------|----------|');
        wf.steps.forEach((s, i) => {
          L.push(`| ${i + 1} | ${s.action} | ${s.target ?? '-'} | ${s.expect ?? '-'} |`);
        });
        L.push('');
      }
      if (wf.error) {
        L.push(`> **Error:** ${wf.error}`);
        L.push('');
      }
    }
  }

  // Bug entries
  L.push(`## Bug Entries`);
  L.push('');

  if (!bugs.length) {
    L.push('No issues detected in this pass.');
  } else {
    const order: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    const sorted = [...bugs].sort((a, b) => order[a.severity] - order[b.severity]);

    for (const bug of sorted) {
      L.push(`### ${bug.id}: ${bug.title}`);
      L.push('');
      L.push(`| Field | Value |`);
      L.push(`|-------|-------|`);
      L.push(`| Severity | **${bug.severity}** |`);
      L.push(`| Category | ${bug.category} |`);
      L.push(`| Description | ${bug.description} |`);
      L.push('');
      L.push(`**Steps to reproduce:**`);
      bug.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
      L.push('');
      if (bug.details?.length) {
        L.push(`**Details:**`);
        bug.details.forEach(d => L.push(`- ${d}`));
        L.push('');
      }
      L.push(`**Evidence:**`);
      bug.evidence.forEach(e => L.push(`- ![${bug.id}](${e})`));
      L.push('');
      L.push('---');
      L.push('');
    }
  }

  await ensureDir(path.dirname(ctx.reportPath));
  await fs.writeFile(ctx.reportPath, L.join('\n'), 'utf-8');
};

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

const main = async () => {
  console.log('\n============================================');
  console.log('     Playwright QA Agent  --  Deep Scan      ');
  console.log('============================================\n');

  try {
    const url = await ask('Target URL');
    if (!url) throw new Error('A target URL is required.');
    const scope = await ask('Scope / notes', 'Full QA scan');

    const ctx = buildCtx();
    await ensureDir(ctx.screenshotDir);

    console.log(`\n  Run ID : ${ctx.runId}`);
    console.log(`  Output : ${ctx.outputRoot}\n`);

    // Launch browser
    log('Launching Chromium...');
    const browser = await chromium.launch({ headless: true });
    const browserCtx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await browserCtx.newPage();

    // Wire up listeners
    attachConsoleListeners(page);
    attachNetworkListeners(page);

    // Navigate
    log(`Navigating to ${url}...`);
    let response: Response | null = null;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch {
      await addBug(page, ctx, {
        title: 'Navigation timeout',
        severity: 'Critical',
        category: 'Navigation',
        description: `Page did not load within ${NAV_TIMEOUT / 1000}s.`,
        steps: ['Open target URL'],
        evidenceLabel: 'nav-timeout',
      });
    }

    if (response && response.status() >= 400) {
      await addBug(page, ctx, {
        title: `HTTP ${response.status()} on navigation`,
        severity: response.status() >= 500 ? 'Critical' : 'High',
        category: 'Navigation',
        description: `Server returned status ${response.status()}.`,
        steps: ['Open target URL'],
        evidenceLabel: `http-${response.status()}`,
      });
    }

    // Wait for SPA to settle
    log('Waiting for page to settle...');
    await page.waitForTimeout(SETTLE_DELAY);

    // Baseline screenshot
    await takeScreenshot(page, ctx, 'baseline-desktop', true);

    // Explore page
    await explorePage(page);

    // Run all checks
    log('Running SEO & meta checks...');
    await checkSEO(page, ctx);

    log('Running accessibility audit...');
    await checkAccessibility(page, ctx);

    log('Checking for broken images...');
    await checkBrokenImages(page, ctx);

    log('Scanning for broken links...');
    await checkBrokenLinks(page, ctx);

    if (response) {
      log('Checking security headers...');
      await checkSecurityHeaders(response, page, ctx);
    }

    log('Measuring performance...');
    await checkPerformance(page, ctx);

    log('Inspecting layout & overflow...');
    await checkLayout(page, ctx);

    log('Testing interactive elements...');
    await checkInteractiveElements(page, ctx);

    log('Checking web-app content for error states...');
    await checkWebAppIssues(page, ctx);

    log('Click-through test on nav & buttons...');
    await checkClickability(page, ctx, url);

    log('Testing responsive (mobile viewport)...');
    await checkResponsive(browserCtx, ctx, url);

    // ── Autonomous Workflow Tests ────────────────────────────────────────
    console.log('\n  ── Autonomous Workflow Tests ──\n');

    log('Crawling site pages...');
    await crawlSitePages(page, ctx, url);

    // Return to base for subsequent workflow tests
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(SETTLE_DELAY);

    log('Testing navigation workflows...');
    await testNavigationWorkflows(page, ctx, url);

    // Return to base
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2000);

    log('Testing form workflows...');
    await testFormWorkflows(page, ctx);

    log('Testing modals & dialogs...');
    await testModals(page, ctx);

    log('Testing dropdowns & tabs...');
    await testDropdownsAndTabs(page, ctx);

    log('Testing wallet/connect flows...');
    await testWalletFlow(page, ctx);

    log('Testing hover interactions...');
    await testHoverInteractions(page, ctx);

    log('Testing keyboard navigation...');
    await testKeyboardNav(page, ctx);

    log('Testing scroll interactions...');
    await testScrollInteractions(page, ctx);

    // ── Accumulated errors ───────────────────────────────────────────────
    console.log('\n  ── Final Collection ──\n');

    log('Checking accumulated console errors...');
    await checkConsoleErrors(page, ctx);

    log('Checking accumulated network failures...');
    await checkNetworkFailures(page, ctx);

    // Write report
    log('Writing report...');
    await writeReport(ctx, url, scope);

    await browser.close();

    // Summary
    const wfPassed = workflowResults.filter(w => w.passed).length;
    const wfFailed = workflowResults.filter(w => !w.passed).length;
    console.log('\n============================================');
    console.log(`  Scan complete -- ${bugs.length} bug(s) found`);
    console.log(`  Workflows: ${workflowResults.length} total, ${wfPassed} passed, ${wfFailed} failed`);
    console.log('============================================');
    console.log(`\n  Report      : ${path.relative(process.cwd(), ctx.reportPath)}`);
    console.log(`  Screenshots : ${path.relative(process.cwd(), ctx.screenshotDir)}`);
    console.log('');
  } catch (err) {
    console.error('\nQA agent failed:', err);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
};

main();
