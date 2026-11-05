/**
 * 端到端 UI 验收：真实扫描 Takeout 目录 → 预览 → 重复项对比 → 执行整理。
 *
 * 安全约定：执行阶段只操作从 --source 复制出的临时输入目录，绝不修改原始测试数据。
 * 测试数据由调用方提供（任意已解压合并的 Takeout 目录）；本脚本不内置夹具。
 *
 * 前置：Web 服务已运行（例如 node src/cli.js web --no-open）。
 * 用法：node tools/ui-e2e.mjs --source "D:\\Takeout-merged" [--url http://127.0.0.1:8788] [--theme light]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const argv = process.argv.slice(2);
const options = {
  url: "http://127.0.0.1:8788/",
  theme: "light",
  outDir: "shots/e2e",
  source: null,
  scratchRoot: path.join(os.tmpdir(), "gpth-ui-e2e"),
};
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--url") options.url = argv[++index];
  else if (argv[index] === "--theme") options.theme = argv[++index];
  else if (argv[index] === "--source") options.source = argv[++index];
}
const input = path.join(options.scratchRoot, `ui-input-${Date.now().toString(36)}`);
const output = path.join(options.scratchRoot, `ui-out-${Date.now().toString(36)}`);
fs.mkdirSync(options.outDir, { recursive: true });

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  } catch {
    // Windows 偶发文件占用不应中断验收。
  }
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) {
    return 0;
  }
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

// 每次从调用方提供的 Takeout 目录复制一份隔离输入，执行阶段不会破坏原始数据。
removeTree(input);
removeTree(output);
if (!options.source) {
  console.error("缺少测试数据：请用 --source 指定一个已解压合并的 Google Takeout 目录。");
  console.error('示例：node tools/ui-e2e.mjs --source "D:\\Takeout-merged" --url http://127.0.0.1:8788');
  process.exit(2);
}
if (!fs.existsSync(options.source)) {
  console.error(`测试数据目录不存在：${options.source}`);
  process.exit(2);
}
fs.cpSync(options.source, input, { recursive: true });
const inputFiles = countFiles(input);
console.log("isolated input files", inputFiles);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--disable-gpu", "--hide-scrollbars", "--no-first-run"],
  defaultViewport: { width: 1560, height: 980, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error?.stack ?? error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`[console] ${message.text()}`);
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = async (name) => {
  await sleep(500);
  const file = `${options.outDir}/${options.theme}-${name}.png`;
  await page.screenshot({ path: file });
  console.log("shot", file);
};
const setInput = async (selector, value) => {
  await page.$eval(
    selector,
    (element, next) => {
      element.value = next;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
};
const setSelect = async (selector, value) => {
  await page.$eval(
    selector,
    (element, next) => {
      element.value = next;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
};

await page.goto(`${options.url}?theme=${options.theme}`, { waitUntil: "networkidle2" });
await sleep(1800);
// 固定验收使用与 CLI 默认值一致的关键选项，避免上次测试持久化的选项影响结果。
await setSelect("#sel-album", "shortcut");
await setSelect("#sel-division", "year-month");
await setSelect("#sel-conflict", "rename");
await setSelect("#sel-unknown", "folder");
// 强制使用复制模式，避免验收运行改变隔离输入目录。
const copySegment = await page.$('#seg-operation .g-segment[data-value="copy"]');
if (copySegment && !(await copySegment.evaluate((node) => node.classList.contains("is-selected")))) {
  await copySegment.click();
  await sleep(300);
}
await setInput("#input-dir", input);
await setInput("#output-dir", output);
await sleep(400);
await shot("e2e-before-scan");

await page.click("#btn-analyze");
console.log("scan started");
try {
  await page.waitForFunction(
    () => /已全部载入|载入失败/.test(document.getElementById("preview-hint")?.textContent ?? ""),
    { timeout: 180000, polling: 500 },
  );
} catch (error) {
  errors.push(`扫描等待超时：${error.message}`);
}
await sleep(800);
const scanState = await page.evaluate(() => ({
  status: document.getElementById("organize-status")?.textContent,
  hint: document.getElementById("preview-hint")?.textContent,
  stats: [...document.querySelectorAll("[data-stat]")].map((node) => `${node.dataset.stat}=${node.textContent}`),
  duplicateButton: document.getElementById("btn-duplicates")?.textContent,
  duplicateDisabled: document.getElementById("btn-duplicates")?.disabled,
  rows: document.querySelectorAll("#preview-tbody tr").length,
}));
console.log("scanState", JSON.stringify(scanState, null, 2));
if (scanState.stats.some((item) => item.startsWith("discovered=") && item.endsWith("=0"))) {
  errors.push("扫描未发现任何媒体，夹具可能不完整");
}
await shot("e2e-after-scan");

// 重复项对比
await page.click("#btn-duplicates");
await sleep(2400);
const dupState = await page.evaluate(() => ({
  open: document.getElementById("modal-duplicates")?.classList.contains("is-open"),
  groups: document.getElementById("dup-summary-groups")?.textContent,
  position: document.getElementById("dup-group-position")?.textContent,
  summary: document.getElementById("dup-group-summary")?.textContent,
  primaryThumb: Boolean(document.querySelector("#dup-primary-thumb img")),
  compareThumb: Boolean(document.querySelector("#dup-compare-thumb img")),
  primaryDetails: document.querySelectorAll("#dup-primary-details .g-detail-row").length,
  primaryFreshness: document.getElementById("dup-primary-freshness")?.textContent,
  primaryRect: document.getElementById("dup-side-primary")?.getBoundingClientRect().toJSON(),
  compareRect: document.getElementById("dup-side-compare")?.getBoundingClientRect().toJSON(),
}));
console.log("dupState", JSON.stringify(dupState, null, 2));
if (dupState.primaryRect && dupState.compareRect && dupState.primaryRect.width < 200) {
  errors.push("重复项左右两栏布局异常（主文件侧过窄）");
}
await shot("e2e-duplicates");
await page.click("#dup-next-member").catch(() => {});
await sleep(1400);
await shot("e2e-duplicates-member2");
await page.keyboard.press("Escape");
await sleep(600);

// 执行整理
await page.click("#btn-execute");
console.log("execute clicked");
try {
  await page.waitForFunction(
    () =>
      document.getElementById("modal-alert")?.classList.contains("is-open") ||
      /完成|失败|取消/.test(document.getElementById("organize-status")?.textContent ?? ""),
    { timeout: 180000, polling: 500 },
  );
} catch (error) {
  errors.push(`执行等待超时：${error.message}`);
}
await sleep(1200);
const resultState = await page.evaluate(() => ({
  alertOpen: document.getElementById("modal-alert")?.classList.contains("is-open"),
  alertTitle: document.getElementById("alert-title")?.textContent,
  alertMessage: document.getElementById("alert-message")?.innerText?.slice(0, 400),
  status: document.getElementById("organize-status")?.textContent,
}));
console.log("resultState", JSON.stringify(resultState, null, 2));
await shot("e2e-result");

// 日志页
await page.evaluate(() => window.showPage?.("logs"));
await sleep(800);
await shot("e2e-logs");

const logCount = await page.evaluate(() => document.getElementById("log-count")?.textContent);
const outputFiles = countFiles(output);
const reportExists = fs.existsSync(path.join(output, "gpth-run-report.json"));
const inputFilesAfter = countFiles(input);
console.log(
  JSON.stringify({ inputFiles, inputFilesAfter, outputFiles, reportExists, logCount, errors }, null, 2),
);
await browser.close();
if (errors.length) {
  process.exitCode = 1;
}
