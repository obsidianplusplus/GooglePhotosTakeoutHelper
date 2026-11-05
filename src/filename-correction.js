/**
 * 按可靠拍摄日期修正 Google Takeout 生成的错误日期型文件名
 * （历史 Python v4.1 参考实现 的 Node.js 移植）。
 */

import fs from "node:fs";
import path from "node:path";

import { formatDate, isValidDate } from "./time.js";

// 只接受“完整日期 + 可选 Takeout 冲突编号”。范围刻意很窄，避免把
// IMG_2025-11-09_trip、相机流水号或用户自定义名称误改。
const DATE_STEM_PATTERN =
  /^((?:18|19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))(\(\d+\))?$/;

/** 拆出文件名的主名与扩展名（对应 Python pathlib 的 .stem / .suffix）。 */
function splitStemSuffix(name) {
  const parsed = path.parse(name);
  return { stem: parsed.name, suffix: parsed.ext };
}

/**
 * 返回修正后的文件主名；不符合严格日期型规则时原样返回。
 *
 * @param {string} stem
 * @param {Date|null} dateTaken 本地墙上时间的 Date
 * @returns {string}
 */
export function correctedDateStem(stem, dateTaken) {
  if (dateTaken === null || dateTaken === undefined || !isValidDate(dateTaken)) {
    return stem;
  }
  const match = DATE_STEM_PATTERN.exec(stem);
  if (match === null) {
    return stem;
  }
  const actualDate = formatDate(dateTaken, "%Y-%m-%d");
  if (match[1] === actualDate) {
    return stem;
  }
  return `${actualDate}${match[2] ?? ""}`;
}

/**
 * 修正一个文件名中的完整日期主名，并保留扩展名大小写。
 *
 * @param {string} name
 * @param {Date|null} dateTaken
 * @returns {string}
 */
export function correctedDateName(name, dateTaken) {
  const { stem, suffix } = splitStemSuffix(name);
  const correctedStem = correctedDateStem(stem, dateTaken);
  return correctedStem === stem ? name : `${correctedStem}${suffix}`;
}

/**
 * 返回与源文件同目录的安全候选名；函数本身不改动文件。
 *
 * @param {string} filePath
 * @param {Date|null} dateTaken
 * @returns {string}
 */
export function correctedDateTarget(filePath, dateTaken) {
  const target = String(filePath);
  return path.join(path.dirname(target), correctedDateName(path.basename(target), dateTaken));
}

/**
 * 在 ``YYYY/MM`` 目录与 mtime 相互印证时返回本地修改时间。
 *
 * 该证据只供已整理目录中的严格日期型错误名修正使用；任一条件不符就返回
 * ``null``，不会在普通目录里擅自把复制时间当成拍摄日期。
 *
 * @param {string} filePath
 * @returns {Date|null}
 */
export function organizedFolderMtime(filePath) {
  try {
    const target = String(filePath);
    const monthText = path.basename(path.dirname(target));
    const yearText = path.basename(path.dirname(path.dirname(target)));
    if (!/^(?:18|19|20)\d{2}$/.test(yearText)) {
      return null;
    }
    if (!/^(?:0[1-9]|1[0-2])$/.test(monthText)) {
      return null;
    }
    // Node 的 mtimeMs 与 Python st_mtime 一样是“本地修改时间”的 Unix 时间戳；
    // new Date(ms) 的本地 getter 即 Python datetime.fromtimestamp() 的本地字段。
    const value = new Date(fs.statSync(target).mtimeMs);
    if (!isValidDate(value)) {
      return null;
    }
    if (value.getFullYear() !== Number.parseInt(yearText, 10) ||
        value.getMonth() + 1 !== Number.parseInt(monthText, 10)) {
      return null;
    }
    // 只有 mtime 确实会改变严格日期型文件名时才把它作为修正证据。
    return correctedDateTarget(target, value) !== target ? value : null;
  } catch {
    // 对应 Python 捕获 (OSError, OverflowError, ValueError)。
    return null;
  }
}
