/**
 * 多场景 UI 验收脚本：逐页、逐弹窗截图并收集页面错误。
 * 用法：node tools/ui-scenes.mjs [--url http://127.0.0.1:8788] [--theme light|dark]
 */

import fs from "node:fs";
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const argv = process.argv.slice(2);
const options = { url: "http://127.0.0.1:8788/", theme: "light", outDir: "shots/scenes" };
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--url") options.url = argv[++index];
  else if (argv[index] === "--theme") options.theme = argv[++index];
  else if (argv[index] === "--out") options.outDir = argv[++index];
}
fs.mkdirSync(options.outDir, { recursive: true });

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

async function shot(name) {
  await sleep(450);
  const file = `${options.outDir}/${options.theme}-${name}.png`;
  await page.screenshot({ path: file });
  console.log("shot", file);
}

async function goto(pageName = null) {
  const url = `${options.url}?theme=${options.theme}`;
  await page.goto(url, { waitUntil: "networkidle2" });
  await sleep(1800);
  if (pageName) {
    await page.click(`.glass-nav-item[data-page="${pageName}"]`);
    await sleep(600);
  }
}

await goto();
await shot("organize-basic");

// 高级选项
await page.click('.g-tab[data-tab="advanced"]');
await shot("organize-advanced");

// 目录选择器
await page.click("#btn-browse-input");
await sleep(900);
await shot("dir-picker");
await page.keyboard.press("Escape");
await sleep(500);

// 未选择目录时的警告对话框
await page.click("#btn-execute");
await sleep(700);
await shot("alert-empty-dirs");
await page.keyboard.press("Escape");
await sleep(400);

// 修复页 / 日志页 / 设置页
await goto("fix");
await shot("fix");

await goto("logs");
await shot("logs");

await goto("settings");
await shot("settings");

// 窄屏响应式
await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 1 });
await goto();
await shot("organize-narrow");

// 目录选择器在窄屏
await page.click("#btn-browse-output");
await sleep(900);
await shot("dir-picker-narrow");
await page.keyboard.press("Escape");

await browser.close();
console.log(JSON.stringify({ errors }, null, 2));
if (errors.length) {
  process.exitCode = 1;
}
