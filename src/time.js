/**
 * 本地时间工具。
 *
 * Python 版本使用“不带时区的本地 datetime”；浏览器/Node 的 Date 内部是
 * UTC 时间戳，但 getFullYear()/getMonth()/... 读取的是本地墙上时间，因此
 * 本移植统一约定：
 *
 *   - 所有拍摄日期都是本地墙上时间的 Date 对象；
 *   - 从不使用 toISOString() 做业务序列化（它会转成 UTC）；
 *   - 需要文本时使用 formatLocalIso() 或 formatDate()。
 *
 * 这样与 Python 的 datetime.fromtimestamp()/isoformat() 行为一致。
 */

/** 两位补零。 */
export function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

/** 由本地时间各字段构造 Date。 */
export function dateFromLocalParts(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(year, month - 1, day, hour, minute, second, ms);
}

/** 读取 Date 的本地时间字段（月份从 1 开始，与 Python 相同）。 */
export function dateToParts(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    ms: date.getMilliseconds(),
  };
}

/** 判断 Date 有效。 */
export function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * 按 strftime 的常用标记格式化本地时间。
 * 支持 %Y %y %m %d %H %M %S %j %% （其余字符原样输出）。
 */
export function formatDate(date, pattern) {
  if (!isValidDate(date)) {
    return "";
  }
  const parts = dateToParts(date);
  return pattern.replace(/%(.)/g, (match, token) => {
    switch (token) {
      case "Y":
        return pad(parts.year, 4);
      case "y":
        return pad(parts.year % 100, 2);
      case "m":
        return pad(parts.month, 2);
      case "d":
        return pad(parts.day, 2);
      case "H":
        return pad(parts.hour, 2);
      case "M":
        return pad(parts.minute, 2);
      case "S":
        return pad(parts.second, 2);
      case "%":
        return "%";
      default:
        return match;
    }
  });
}

/**
 * Python datetime.isoformat() 的无时区版本。
 *
 * Python 在 microsecond != 0 时输出 6 位小数（例如 `2023-01-15T08:00:00.123000`），
 * JS Date 只有毫秒精度，因此这里把毫秒补成 `mmm000` 以保持与参考实现逐字节一致；
 * 毫秒为 0 时不输出小数部分（与 Python 相同）。用于运行报告 JSON。
 */
export function formatLocalIso(date) {
  if (!isValidDate(date)) {
    return null;
  }
  const p = dateToParts(date);
  const fraction = p.ms ? `.${pad(p.ms, 3)}000` : "";
  return (
    `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}` +
    `T${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}${fraction}`
  );
}

/** 表格/日志中使用的 YYYY-MM-DD HH:MM:SS。 */
export function formatDateTime(date) {
  return formatDate(date, "%Y-%m-%d %H:%M:%S");
}

/** 仅时间部分 HH:MM:SS（日志行前缀）。 */
export function formatTime(date) {
  return formatDate(date, "%H:%M:%S");
}

const PATTERN_TO_REGEX = {
  Y: String.raw`\d{4}`,
  y: String.raw`\d{2}`,
  m: String.raw`\d{1,2}`,
  d: String.raw`\d{1,2}`,
  H: String.raw`\d{1,2}`,
  M: String.raw`\d{1,2}`,
  S: String.raw`\d{1,2}`,
};

const PATTERN_READERS = {
  Y: (text) => Number.parseInt(text, 10),
  y: (text) => 2000 + Number.parseInt(text, 10),
  m: (text) => Number.parseInt(text, 10),
  d: (text) => Number.parseInt(text, 10),
  H: (text) => Number.parseInt(text, 10),
  M: (text) => Number.parseInt(text, 10),
  S: (text) => Number.parseInt(text, 10),
};

/**
 * 严格解析固定格式的日期文本（对应 Python datetime.strptime）。
 *
 * - 要求整体匹配，不做前后缀搜索；
 * - 解析完成后通过“本地字段回读”校验，拒绝 2024-02-31 这类自动进位的日期；
 * - 解析失败返回 null，不抛异常。
 */
export function parseDateTimeStrict(text, pattern) {
  const tokens = [];
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "%") {
      const token = pattern[index + 1];
      if (token === undefined) {
        return null;
      }
      if (token === "%") {
        source += "%";
      } else if (PATTERN_TO_REGEX[token]) {
        source += `(${PATTERN_TO_REGEX[token]})`;
        tokens.push(token);
      } else {
        return null;
      }
      index += 1;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  source += "$";
  let match;
  try {
    match = new RegExp(source, "u").exec(String(text));
  } catch {
    return null;
  }
  if (match === null) {
    return null;
  }
  const values = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const raw = match[index + 1];
    const parsed = PATTERN_READERS[token](raw);
    if (token === "Y") values.year = parsed;
    else if (token === "y") values.year = parsed;
    else if (token === "m") values.month = parsed;
    else if (token === "d") values.day = parsed;
    else if (token === "H") values.hour = parsed;
    else if (token === "M") values.minute = parsed;
    else if (token === "S") values.second = parsed;
  }
  const date = dateFromLocalParts(
    values.year,
    values.month,
    values.day,
    values.hour,
    values.minute,
    values.second,
  );
  if (!isValidDate(date)) {
    return null;
  }
  const check = dateToParts(date);
  if (
    check.year !== values.year ||
    check.month !== values.month ||
    check.day !== values.day ||
    check.hour !== values.hour ||
    check.minute !== values.minute ||
    check.second !== values.second
  ) {
    return null;
  }
  return date;
}

/** 把 Unix 秒（可带小数、毫秒兼容）转换为本地 Date；无效时返回 null。 */
export function timestampToLocalDate(value) {
  const number = typeof value === "string" ? Number.parseFloat(value.trim()) : Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  try {
    const date = new Date(number * 1000);
    return isValidDate(date) ? date : null;
  } catch {
    return null;
  }
}

/** 返回当前本地时间（用于统计 startedAt/finishedAt）。 */
export function nowLocal() {
  return new Date();
}
