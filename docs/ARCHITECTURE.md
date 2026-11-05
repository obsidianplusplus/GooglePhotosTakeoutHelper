# 架构与模块接口

本文件说明 PhotoTakeout Studio 的 Node.js 架构、模块职责与主要接口约定，供二次开发与维护参考。用户文档见 [README.md](../README.md)。

## 分层

```
浏览器 UI (Liquid Glass)
      │  HTTP / SSE
src/web/  — HTTP 服务、会话管理、worker_threads、缩略图、目录浏览
      │  import
src/engine.js + src/cli.js — 业务编排 / 命令行
      │
扫描 → 去重 → 日期提取 → 相册合并 → 计划 → 执行
scanner / grouping / date-extractors / planner / executor
      │
src/file-utils.js、src/live-photos.js、src/duplicates.js 等基础能力
```

CLI 与 Web 共用同一套引擎；Web 端的扫描/执行/修复在 `worker_threads` 中运行，避免阻塞 HTTP/SSE。

## 全局约定

1. **路径**：一律使用 `string`；`OrganizeOptions.normalized()` 之后为绝对路径。
2. **日期**：拍摄日期是“本地墙上时间”的 `Date`；序列化使用 `src/time.js` 的 `formatLocalIso()`（Python `datetime.isoformat()` 兼容：仅毫秒非零时输出 `.mmm000`），禁止用 `toISOString()` 做业务序列化。
3. **枚举**：`src/models.js` 导出冻结的字符串常量表（如 `OperationMode.COPY`、`Phase.SCANNING`），比较用 `===`。
4. **错误**：`CancelledError`（用户取消）、`ValidationError`（配置错误 → CLI 11）、`InputNotFoundError`（无媒体 → CLI 13）；文件系统错误保留 Node 原生 `code`（如 `ENOENT`/`EXDEV`）。
5. **取消**：`TaskContext.checkCancelled()` 在长循环/复制分块/目录枚举中抛出 `CancelledError`，调用方必须让它越过逐文件隔离。
6. **日志**：`context.log(level, message)`；`context.progress(phase, current, total, message)`；回调异常必须吞掉。
7. **异步**：文件 I/O 与引擎方法为 `async`；纯计算与同步判断（`availableTarget`、`buildPlan`、`isHidden` 等）保持同步。
8. **Map 语义**：`MediaRecord.locations` 等使用 `Map`，键为相册名或 `null`（主时间线），遍历顺序即插入顺序。

## 核心模块

| 模块 | 职责 | 主要导出 |
| --- | --- | --- |
| `src/models.js` | 配置/记录/计划/统计/任务上下文与枚举 | `OrganizeOptions`、`MediaRecord`、`DuplicateGroup`、`PlanAction`、`TaskContext`、`CancelledError` |
| `src/constants.js` | 扩展名、默认目录名、设置/缓存路径 | `MEDIA_EXTENSIONS`、`settingsPath()`、`scanCachePath()` |
| `src/time.js` | 本地时间解析/格式化 | `formatLocalIso`、`formatDate`、`parseDateTimeStrict` |
| `src/async-utils.js` | 并发与取消 | `mapConcurrent` |
| `src/settings.js` | 设置持久化（原子写、旧字段迁移） | `loadSettings`、`saveSettings` |
| `src/exif.js` | JPEG/PNG/WebP/TIFF/HEIC/AVIF 的 EXIF 日期与方向 | `readExifDate`、`readExifOrientation` |
| `src/image-support.js` | HEIF 文件头识别、解码能力诊断 | `inspectHeifSignature`、`decoderUnavailableReason` |
| `src/date-extractors.js` | JSON/EXIF/文件名/深度 JSON/mtime 日期提取 | `extractDate`、`jsonSidecarCandidates` |
| `src/filename-correction.js` | 严格日期型文件名修正 | `correctedDateTarget`、`organizedFolderMtime` |
| `src/scanner.js` | Takeout 年份/相册目录发现、媒体扫描 | `discoverTakeout`、`scanMediaFolder` |
| `src/file-utils.js` | SHA-256、原子复制、成组事务、MOVE 降级、输出锁、快捷方式、mtime | `atomicCopy`、`atomicCopyBundle`、`availableTarget`、`OutputDirectoryLock` |
| `src/live-photos.js` | 实况照片容器探测、Apple 元数据校验、成组目标规划 | `discoverLivePhotoPairs`、`availableLivePhotoTargets` |
| `src/scan-cache.js` | 可持久化 SHA-256 扫描缓存（LRU、交叉校验） | `HashCache` |
| `src/grouping.js` | 去重、编辑副本过滤、相册合并、重复组快照/处置 | `findDuplicateRecords`、`mergeAlbums`、`finalizeDuplicateGroups` |
| `src/planner.js` | 生成无副作用执行计划 | `buildPlan` |
| `src/duplicates.js` | 重复项详情与安全缩略图 | `inspectDuplicateFile`、`buildThumbnail` |
| `src/executor.js` | 执行计划、相册索引、运行报告 | `executePlan` |
| `src/engine.js` | 对外业务入口 | `TakeoutEngine`（`analyze/buildPlan/execute/run/fixDates`） |
| `src/cli.js` | 命令行入口 | `main`、`launchGui` |

## Web 架构

- `src/web/server.js`：HTTP 路由、静态文件、同源校验、JSON body 限制、统一错误响应。
- `src/web/jobs.js`：一个会话对应一个 `worker_threads` 工作线程；事件有界缓冲并在 SSE 重连时回放；支持取消、执行、删除、2 小时空闲回收、worker 崩溃处理。
- `src/web/job-worker.js`：在 worker 内调用 `TakeoutEngine`；分析结果与执行计划保留在 worker 内存中，执行时不重新扫描。
- `src/web/thumbnails.js`：缩略图内存 LRU（200 条 / 64 MB）+ 并发限制。
- `src/web/fs-browse.js`：盘符/常用目录枚举与目录浏览。
- `src/web/start.js`：端口选择（默认 8788，占用时顺延）、启动服务、可选打开浏览器。

主要接口：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health`、`GET /api/system` | 应用信息、缓存与图像能力 |
| `GET/PUT /api/settings` | 读取/合并保存设置 |
| `GET /api/fs/roots`、`GET /api/fs/list` | 目录浏览 |
| `POST /api/session` | 创建整理/修复会话并开始分析 |
| `GET /api/session/:id/events` | SSE：progress、log、analysis、execution、fix、cancelled、error、state |
| `GET /api/session/:id/preview` | 分页拉取计划动作（虚拟滚动） |
| `GET /api/session/:id/duplicates` | 分页拉取重复组 |
| `POST /api/session/:id/execute` | 执行已生成计划（选项必须与扫描一致，否则 409） |
| `POST /api/session/:id/cancel`、`DELETE /api/session/:id` | 取消 / 释放会话 |
| `GET /api/thumb`、`GET /api/preview-info` | 缩略图与重复项详情 |

服务只监听 `127.0.0.1`；POST/PUT/DELETE 校验同源。

## 文件安全语义

- 单文件复制：先写同目录 `.<name>.<uuid>.gpth-part`，`fsync` 后原子替换；目标被占用时按冲突策略处理。
- 实况照片成组复制：先完整暂存两半，再以无覆盖占位（hardlink / O_EXCL）共同提交；失败时回滚并报告未恢复路径。
- 移动：同卷 `rename`；跨卷退化为“复制落盘后删除源文件”，删除失败时尽力恢复并降级为复制。
- 输出目录锁：`.gpth-task.lock`（pid + token + 时间戳），只删除自己的锁，残留锁按进程存活情况清理。
- MOVE 源文件退役：先成组改名为保留名，全部成功后才删除；失败恢复原路径。
- 运行报告与相册索引使用同目录临时文件 + 原子替换写入。

## 测试与验收

```bash
node --test                    # 159 项 node:test（单元 + 引擎/CLI/Web API 集成）
```

`tests/` 覆盖日期来源、EXIF/HEIC 解析、扫描与实况照片、去重/计划、执行事务、CLI 参数与退出码、Web API/SSE/端到端会话。可选的 `tools/ui-*.mjs` 使用 `puppeteer-core` + 本机 Edge 做界面截图与端到端验收，测试媒体目录通过参数传入。
