import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';

/** Playwright Core does not bundle browsers. The Playwright installer uses a
 * shared cache; reuse downloaded browsers instead of keeping a project copy. */
const CACHE_DIRS = [
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  path.join(os.homedir(), 'Library/Caches/ms-playwright'),
  path.join(os.homedir(), '.cache/ms-playwright'),
].filter(Boolean);

const EXEC_PATTERNS = [
  // Full Chromium is needed for WebGL and representative screenshots.
  ['chromium-', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
  ['chromium-', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
  ['chromium-', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'],
  ['chromium-', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'],
  ['chromium-', 'chrome-linux/chrome'],
  ['chromium-', 'chrome-linux64/chrome'],
  // The lighter headless shell is faster but lacks the GPU path; useful for simulations.
  ['chromium_headless_shell-', 'chrome-headless-shell-mac-arm64/chrome-headless-shell'],
  ['chromium_headless_shell-', 'chrome-headless-shell-mac/chrome-headless-shell'],
  ['chromium_headless_shell-', 'chrome-headless-shell-linux64/chrome-headless-shell'],
];

/** @param {{shell?: boolean}} opts shell:true prefers the lightweight headless shell. */
export function findChromium({ shell = false } = {}) {
  const found = [];
  for (const cache of CACHE_DIRS) {
    if (!fs.existsSync(cache)) continue;
    const entries = fs.readdirSync(cache).sort().reverse(); // newest build first
    for (const entry of entries) {
      for (const [prefix, tail] of EXEC_PATTERNS) {
        if (!entry.startsWith(prefix)) continue;
        const exec = path.join(cache, entry, tail);
        if (fs.existsSync(exec)) found.push({ exec, isShell: prefix.includes('headless_shell') });
      }
    }
  }
  if (!found.length) return null;
  const preferred = found.filter((f) => f.isShell === shell);
  return (preferred[0] || found[0]).exec;
}

export function chromiumOrDie(opts) {
  const exec = findChromium(opts);
  if (!exec) {
    throw new Error(
      'Chromium not found. Install Playwright browsers:\n  npx playwright install chromium',
    );
  }
  return exec;
}

/** @param {{headless?: boolean, shell?: boolean, swiftshader?: boolean, slowMo?: number}} opts
 * swiftshader:true enables software WebGL only to avoid black headless WebGL frames.
 * Keep it off for 2D canvas: Brick Breaker measured 7.6 fps versus 93 without it,
 * which would make the measurement and performance critique misleading. */
export async function launch(opts = {}) {
  const { headless = true, shell = false, swiftshader = false, slowMo = 0 } = opts;
  const args = [
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (swiftshader) args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  return chromium.launch({ executablePath: chromiumOrDie({ shell }), headless, args, slowMo });
}

/** Viewport presets approximate how players see the game on each device class. */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  wide: { width: 1600, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  portrait: { width: 520, height: 760, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  phoneLandscape: { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

export function viewport(name = 'desktop') {
  const vp = VIEWPORTS[name];
  if (!vp) throw new Error(`Unknown viewport "${name}". Available: ${Object.keys(VIEWPORTS).join(', ')}`);
  return vp;
}

/** Precedence: explicit flag, scenario, config. A phone scenario measured at
 * 1280 pixels is a different layout. Keep probe and shots/play consistent
 * so reports do not mix phone metrics with desktop screenshots. */
export function resolveViewport(explicit, sc, cfg = {}) {
  return explicit || sc?.viewport || cfg.viewport || 'desktop';
}

/** Create a page with console warnings/errors, unhandled rejections and failed
 * HTTP requests collected from the start. Screenshots can hide these failures. */
export async function newPage(browser, vpName = 'desktop') {
  const vp = viewport(vpName);
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      errors.push({ kind: `console.${type}`, text: msg.text().slice(0, 500) });
    }
  });
  page.on('pageerror', (err) => errors.push({ kind: 'pageerror', text: String(err).slice(0, 500) }));
  page.on('requestfailed', (req) => {
    errors.push({ kind: 'requestfailed', text: `${req.url()} — ${req.failure()?.errorText ?? '?'}` });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) errors.push({ kind: 'http', text: `${res.status()} ${res.url()}` });
  });
  page.__forgeErrors = errors;
  // A real phone click is a touch. Games listening only to touchstart or
  // pointerType may ignore mouse input.
  page.__forgeTouch = !!vp.hasTouch;
  return page;
}
