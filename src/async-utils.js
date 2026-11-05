/**
 * 并发与取消辅助。
 *
 * Python 版本用 ThreadPoolExecutor 并行执行日期提取；Node 版本使用
 * 事件循环并发（文件 I/O 本身异步，sharp/libvips 在原生线程池中执行），
 * 语义上等价于“固定并发、完成即回调进度、支持取消”。
 */

/** 抛出该错误表示用户主动取消任务；调用方必须让它越过逐文件隔离。 */
export class CancelledError extends Error {
  constructor(message = "任务已由用户取消") {
    super(message);
    this.name = "CancelledError";
  }
}

/**
 * 以固定并发度处理 items，并在每项完成后触发 onProgress。
 *
 * - 与 Python 的 as_completed 一致：进度顺序不保证与输入顺序相同，
 *   但所有结果都会写回各自对象；
 * - 任意一项抛出 CancelledError 时立即停止领取新任务，并等待在飞任务
 *   结束后把该错误抛给调用方；
 * - 其它错误同样停止领取新任务并抛出首个错误。
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit 并发数（至少 1，调用方负责限制到 32）
 * @param {(item: T, index: number) => Promise<any>|any} worker
 * @param {{onProgress?: (item: T, index: number, completed: number) => void, checkCancelled?: () => void}} [options]
 */
export async function mapConcurrent(items, limit, worker, options = {}) {
  const { onProgress = null, checkCancelled = null } = options;
  const total = items.length;
  if (total === 0) {
    return;
  }
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  let nextIndex = 0;
  let completed = 0;
  let failure = null;
  let aborting = false;

  async function run() {
    for (;;) {
      if (aborting) {
        return;
      }
      if (checkCancelled) {
        try {
          checkCancelled();
        } catch (error) {
          failure = failure || error;
          aborting = true;
          return;
        }
      }
      const index = nextIndex;
      if (index >= total) {
        return;
      }
      nextIndex += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        failure = failure || error;
        aborting = true;
        return;
      }
      completed += 1;
      if (onProgress) {
        try {
          onProgress(items[index], index, completed);
        } catch (error) {
          failure = failure || error;
          aborting = true;
          return;
        }
      }
    }
  }

  const runners = [];
  for (let index = 0; index < workers; index += 1) {
    runners.push(run());
  }
  await Promise.all(runners);
  if (failure) {
    throw failure;
  }
}

/** 可等待的延时（主要供“等待任务结束”或测试使用）。 */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
