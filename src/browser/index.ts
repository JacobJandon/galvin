/**
 * Browser module public API
 */
export { startBrowser, stopBrowser, newPage, getCurrentPage, isBrowserRunning } from "./service.js";
export { navigateTo, clickElement, fillInput, takeScreenshot, getPageText, evalJS } from "./actions.js";
