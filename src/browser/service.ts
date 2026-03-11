/**
 * BrowserService
 *
 * Manages a single Playwright/Chromium instance.
 * Singleton per Galvin process — call startBrowser() once, then newPage() for tabs.
 * All browser tools use _currentPage for "last opened tab" semantics.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("browser");

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _currentPage: Page | null = null;

export async function startBrowser(): Promise<void> {
  if (_browser) return;
  _browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  _context = await _browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    viewport: { width: 1280, height: 800 },
  });
  logger.info("Browser started");
}

export async function stopBrowser(): Promise<void> {
  if (_browser) {
    _currentPage = null;
    await _browser.close().catch(() => {});
    _browser = null;
    _context = null;
    logger.info("Browser stopped");
  }
}

/**
 * Opens a new page and sets it as the current (active) tab.
 */
export async function newPage(): Promise<Page> {
  if (!_context) throw new Error("Browser not started. Call startBrowser() first.");
  const page = await _context.newPage();
  _currentPage = page;
  return page;
}

/**
 * Returns the current active page, or throws if none is open.
 */
export function getCurrentPage(): Page {
  if (!_currentPage || _currentPage.isClosed()) {
    throw new Error(
      "No browser tab is open. Call browser_navigate first to open a page.",
    );
  }
  return _currentPage;
}

export function isBrowserRunning(): boolean {
  return _browser !== null && _browser.isConnected();
}
