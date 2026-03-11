/**
 * Browser Actions
 *
 * Core browser interactions that operate on a Playwright Page.
 * All functions return descriptive strings so the agent can read results directly.
 */

import type { Page } from "playwright-core";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("browser.actions");

export async function navigateTo(
  page: Page,
  url: string,
  timeoutMs = 30_000,
): Promise<string> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const title = await page.title();
    logger.info(`Navigated to ${url}`);
    return `Navigated to ${url} — title: "${title}"`;
  } catch (err: any) {
    return `Error navigating to ${url}: ${err?.message}`;
  }
}

export async function clickElement(
  page: Page,
  selector: string,
): Promise<string> {
  try {
    await page.click(selector, { timeout: 10_000 });
    logger.info(`Clicked: ${selector}`);
    return `Clicked: ${selector}`;
  } catch (err: any) {
    return `Error clicking ${selector}: ${err?.message}`;
  }
}

export async function fillInput(
  page: Page,
  selector: string,
  value: string,
): Promise<string> {
  try {
    await page.fill(selector, value, { timeout: 10_000 });
    logger.info(`Filled "${selector}"`);
    return `Filled "${selector}" with value`;
  } catch (err: any) {
    return `Error filling ${selector}: ${err?.message}`;
  }
}

export async function takeScreenshot(page: Page): Promise<string> {
  try {
    const buffer = await page.screenshot({ type: "png", fullPage: false });
    const title = await page.title();
    return `Screenshot taken (${buffer.length} bytes). Page title: "${title}", URL: ${page.url()}`;
  } catch (err: any) {
    return `Error taking screenshot: ${err?.message}`;
  }
}

export async function getPageText(page: Page): Promise<string> {
  try {
    const text = (await page.evaluate(() => document.body?.innerText ?? "")) as string;
    const truncated =
      text.length > 20_000 ? text.slice(0, 20_000) + "\n[TRUNCATED]" : text;
    return `Page text (${page.url()}):\n\n${truncated}`;
  } catch (err: any) {
    return `Error getting page text: ${err?.message}`;
  }
}

export async function evalJS(page: Page, jsCode: string): Promise<string> {
  try {
    const result = await page.evaluate(jsCode);
    return `Result: ${JSON.stringify(result)}`;
  } catch (err: any) {
    return `Error: ${err?.message}`;
  }
}
