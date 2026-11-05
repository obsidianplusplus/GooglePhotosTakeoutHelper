/**
 * UI 行为验收：日期修复、取消、选项校验、预览失效重扫、对话框 Promise 语义。
 * 测试数据通过 --takeout-source / --fix-source 传入，只操作临时副本。
 *
 * 前置：Web 服务已运行（例如 node src/cli.js web --no-open）。
 * 用法：node tools/ui-flow-tests.mjs --takeout-source "D:\\Takeout-merged" --fix-source "D:\\Photos" [--url http://127.0.0.1:8788]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const argv = process.argv.slice(2);
const options = {
  url: "http://127.0.0.1:8788/",
  outDir: "shots/flows",
  takeoutSource: null,
  fixSource: null,
  scratch: path.join(os.tmpdir(), "gpth-ui-flow"),
};
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--url") options.url = argv[++index];
  else if (arg === "--takeout-source") options.takeoutSource = argv[++index];
  else if (arg === "--fix-source") options.fixSource = argv[++index];
}
fs.mkdirSync(options.outDir, { recursive: true });
const runStamp = Date.now().toString(36);

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  } catch {
    // Windows 上偶发文件占用（杀毒/索引）不应中断验收，可留待下次清理。
  }
}

function requireSource(label, value, flag) {
  if (!value) {
    console.error(`缺少测试数据：请用 ${flag} 指定${label}。`);
    console.error(
      '示例：node tools/ui-flow-tests.mjs --takeout-source "D:\\Takeout-merged" --fix-source "D:\\Photos"',
    );
    process.exit(2);
  }
  if (!fs.existsSync(value)) {
    console.error(`${label}不存在：${value}`);
    process.exit(2);
  }
  return value;
}

const scratch = options.scratch;
const takeoutSource = requireSource("已合并的 Takeout 测试目录", options.takeoutSource, "--takeout-source");
const fixSourcePath = requireSource("待修复媒体测试目录", options.fixSource, "--fix-source");

const results = [];
const record = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--disable-gpu", "--hide-scrollbars", "--no-first-run"],
  defaultViewport: { width: 1560, height: 980, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error?.stack ?? error)));
page.on("console", (message) => {
  if (message.type() === "error") pageErrors.push(`[console] ${message.text()}`);
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = async (name) => {
  await sleep(350);
  await page.screenshot({ path: `${options.outDir}/${name}.png` });
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
const waitFor = async (predicate, timeout = 120000) =>
  page.waitForFunction(predicate, { timeout, polling: 300 });

await page.goto(options.url, { waitUntil: "networkidle2" });
await sleep(1800);

/* --------------------- 0. 警告/确认对话框 Promise 语义 --------------------- */
const dialogCase = async (action) =>
  page.evaluate(async (kind) => {
    const { alertDialog } = await import("/js/confirm.js");
    const promise = alertDialog({ title: `对话框测试-${kind}`, message: "x", confirmText: "确定" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (kind === "escape") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else if (kind === "backdrop") {
      document.querySelector("#modal-alert .g-modal__backdrop")?.click();
    } else {
      document.getElementById("alert-confirm")?.click();
    }
    const result = await Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 2500)),
    ]);
    return { result, open: document.getElementById("modal-alert")?.classList.contains("is-open") };
  }, action);

const escCase = await dialogCase("escape");
record(
  "Esc 关闭警告框并结算 Promise",
  escCase.result === false && !escCase.open,
  JSON.stringify(escCase),
);
const backdropCase = await dialogCase("backdrop");
record(
  "点击遮罩关闭警告框并结算 Promise",
  backdropCase.result === false && !backdropCase.open,
  JSON.stringify(backdropCase),
);
const confirmCase = await dialogCase("confirm");
record(
  "确认按钮结算 Promise 为 true",
  confirmCase.result === true && !confirmCase.open,
  JSON.stringify(confirmCase),
);
await sleep(300);

/* ------------------------- 1. 空目录选项校验 ------------------------- */
await page.click("#btn-analyze");
await sleep(700);
let alertState = await page.evaluate(() => ({
  open: document.getElementById("modal-alert")?.classList.contains("is-open"),
  title: document.getElementById("alert-title")?.textContent,
}));
record("空目录时提示“目录不完整”", alertState.open && alertState.title === "目录不完整", JSON.stringify(alertState));
await page.keyboard.press("Escape");
await sleep(400);

/* ------------------------- 2. 日期修复（仅预演） ------------------------- */
const fixInput = path.join(scratch, `fix-input-${runStamp}`);
removeTree(fixInput);
fs.cpSync(fixSourcePath, fixInput, { recursive: true });
const fixCountBefore = fs.readdirSync(fixInput, { recursive: true }).length;

await page.click('.glass-nav-item[data-page="fix"]');
await sleep(500);
await setInput("#fix-dir", fixInput);
// 打开“仅预演”
await page.$eval("#fix-dry-run", (element) => {
  if (!element.checked) {
    element.checked = true;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
});
await sleep(300);
await page.click("#btn-start-fix");
try {
  await waitFor(
    () =>
      document.getElementById("modal-alert")?.classList.contains("is-open") ||
      /任务失败/.test(document.getElementById("fix-status")?.textContent ?? ""),
    120000,
  );
} catch (error) {
  pageErrors.push(`修复任务等待超时：${error.message}`);
}
await sleep(1000);
const fixState = await page.evaluate(() => ({
  alertTitle: document.getElementById("alert-title")?.textContent,
  status: document.getElementById("fix-status")?.textContent,
  summary: document.getElementById("fix-summary")?.textContent,
  hint: document.getElementById("fix-hint")?.textContent,
}));
const fixCountAfter = fs.readdirSync(fixInput, { recursive: true }).length;
record(
  "日期修复预演完成且未改动文件",
  fixState.alertTitle === "日期修复完成" &&
    /扫描文件：\d+/.test(fixState.summary ?? "") &&
    fixCountBefore === fixCountAfter,
  JSON.stringify({ ...fixState, fixCountBefore, fixCountAfter }).slice(0, 400),
);
await shot("fix-dry-run-result");
await page.keyboard.press("Escape");
await sleep(400);

/* --------------------- 3. 预览失效后自动重扫 --------------------- */
const input = path.join(scratch, `ui-input-${runStamp}`);
const output = path.join(scratch, `ui-out-flow-${runStamp}`);
removeTree(input);
removeTree(output);
fs.cpSync(takeoutSource, input, { recursive: true });
await page.click('.glass-nav-item[data-page="organize"]');
await sleep(500);
// 显式切回复制模式，避免上次运行持久化的“移动”选项引发额外的确认对话框。
const copySegment = await page.$('#seg-operation .g-segment[data-value="copy"]');
if (copySegment && !(await copySegment.evaluate((node) => node.classList.contains("is-selected")))) {
  await copySegment.click();
  await sleep(300);
}
await setInput("#input-dir", input);
await setInput("#output-dir", output);
await page.click("#btn-analyze");
await waitFor(() => /已全部载入/.test(document.getElementById("preview-hint")?.textContent ?? ""));
await sleep(500);
// 修改选项使预览失效（在两个相册模式之间切换，确保与上次保存的设置不同）
await page.$eval("#sel-album", (element) => {
  element.value = element.value === "json" ? "shortcut" : "json";
  element.dispatchEvent(new Event("change", { bubbles: true }));
});
await sleep(400);
await page.click("#btn-execute");
await sleep(900);
alertState = await page.evaluate(() => ({
  open: document.getElementById("modal-alert")?.classList.contains("is-open"),
  title: document.getElementById("alert-title")?.textContent,
  message: document.getElementById("alert-message")?.innerText?.slice(0, 160),
}));
record(
  "修改选项后执行提示需要最新预览",
  alertState.open && alertState.title === "需要最新预览",
  JSON.stringify(alertState),
);
await shot("stale-preview-prompt");
// 确认后应自动重新扫描
await page.click("#alert-confirm");
try {
  await waitFor(() => /已全部载入/.test(document.getElementById("preview-hint")?.textContent ?? ""));
  await sleep(600);
} catch (error) {
  pageErrors.push(`自动重扫等待超时：${error.message}`);
}
const rescanState = await page.evaluate(() => ({
  status: document.getElementById("organize-status")?.textContent,
  hint: document.getElementById("preview-hint")?.textContent,
}));
record(
  "确认后自动重新扫描完成",
  /已全部载入/.test(rescanState.hint ?? "") && /预览完成/.test(rescanState.status ?? ""),
  JSON.stringify(rescanState),
);
await shot("rescan-complete");

/* ---------------------------- 4. 取消任务 ---------------------------- */
// 用重复的 Takeout 结构扩大扫描量，确保取消按钮在任务结束前可用。
const bigInput = path.join(scratch, `ui-cancel-input-${runStamp}`);
const bigOutput = path.join(scratch, `ui-cancel-out-${runStamp}`);
removeTree(bigInput);
removeTree(bigOutput);
for (let copy = 0; copy < 12; copy += 1) {
  fs.cpSync(input, path.join(bigInput, `batch-${copy}`), { recursive: true });
}
await setInput("#input-dir", bigInput);
await setInput("#output-dir", bigOutput);
await page.click("#btn-analyze");
let cancelClicked = false;
try {
  await waitFor(() => document.getElementById("btn-cancel") && !document.getElementById("btn-cancel").disabled, 20000);
  await page.click("#btn-cancel");
  cancelClicked = true;
  await waitFor(
    () =>
      document.getElementById("modal-alert")?.classList.contains("is-open") &&
      document.getElementById("alert-title")?.textContent === "任务已取消",
    120000,
  );
} catch (error) {
  pageErrors.push(`取消任务等待超时：${error.message}`);
}
const cancelState = await page.evaluate(() => ({
  alertTitle: document.getElementById("alert-title")?.textContent,
  status: document.getElementById("organize-status")?.textContent,
}));
record("取消任务显示已取消", cancelClicked && cancelState.alertTitle === "任务已取消", JSON.stringify(cancelState));
await shot("cancel-result");

record("无页面脚本错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
console.log("\nSUMMARY", JSON.stringify({ results, pageErrors }, null, 2));
await browser.close();
if (results.some((item) => !item.pass) || pageErrors.length) {
  process.exitCode = 1;
}
