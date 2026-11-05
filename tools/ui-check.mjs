/**
 * 开发/验收用浏览器脚本：打开本机 Web UI，输出控制台错误并截图。
 *
 * 用法：
 *   node tools/ui-check.mjs [url] [--theme dark] [--page fix] [--shot shots/ui.png]
 */

import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function parseArgs(argv) {
  const options = {
    url: "http://127.0.0.1:8788/",
    theme: null,
    page: null,
    shot: "shots/ui-check.png",
    wait: 2500,
    width: 1560,
    height: 980,
  };
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--theme") options.theme = argv[++index];
    else if (value === "--page") options.page = argv[++index];
    else if (value === "--shot") options.shot = argv[++index];
    else if (value === "--wait") options.wait = Number(argv[++index]);
    else if (value === "--width") options.width = Number(argv[++index]);
    else if (value === "--height") options.height = Number(argv[++index]);
    else if (value === "--click") options.click = argv[++index];
    else rest.push(value);
  }
  if (rest[0]) {
    options.url = rest[0];
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!fs.existsSync(path.dirname(options.shot))) {
  fs.mkdirSync(path.dirname(options.shot), { recursive: true });
}
let url = options.url;
if (options.theme) {
  url += `${url.includes("?") ? "&" : "?"}theme=${options.theme}`;
}
if (options.page) {
  url += `${url.includes("?") ? "&" : "?"}page=${options.page}`;
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check"],
  defaultViewport: { width: options.width, height: options.height, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") {
    consoleErrors.push(`[${message.type()}] ${message.text()}`);
  }
});
page.on("pageerror", (error) => {
  pageErrors.push(String(error?.stack ?? error));
});
page.on("requestfailed", (request) => {
  consoleErrors.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`);
});
await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
await new Promise((resolve) => setTimeout(resolve, options.wait));

if (options.page) {
  await page.evaluate((key) => {
    if (window.showPage) window.showPage(key);
    else {
      document.querySelector(`.glass-nav-item[data-page="${key}"]`)?.click();
    }
  }, options.page);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (options.click) {
  const handles = await page.$$(options.click);
  if (handles[0]) {
    await handles[0].click();
    await new Promise((resolve) => setTimeout(resolve, 900));
  } else {
    consoleErrors.push(`[click] 未找到元素 ${options.click}`);
  }
}

await page.screenshot({ path: options.shot });
const title = await page.title();
const state = await page.evaluate(() => ({
  ready: Boolean(window.Glass),
  theme: document.documentElement.dataset.theme,
  page: window.location.hash,
  bodyText: document.body.innerText.slice(0, 400),
  hasPageContent: Boolean(document.querySelector("#page-organize .glass-title")),
  modalsOpen: [...document.querySelectorAll(".g-modal.is-open")].map((node) => node.id),
}));

console.log(JSON.stringify({ title, url, shot: options.shot, state, pageErrors, consoleErrors }, null, 2));
await browser.close();
if (pageErrors.length) {
  process.exitCode = 1;
}
