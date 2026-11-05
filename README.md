# Google Photos Takeout Helper · Node.js v5.0

**PhotoTakeout Studio** 是整理 Google Photos Takeout 导出的照片与视频的本机工具。仓库已全面迁移为 **纯 Node.js（ESM）项目**：扫描、日期提取、去重、相册合并、执行计划、实况照片处理、日期修复、CLI 全部由 Node.js 实现，并附带 **Liquid Glass（仿 iOS）风格的网页界面**。

- 网页界面：`npm start`（或 `node src/cli.js web`），浏览器访问本机地址，中文 Liquid Glass UI。
- 命令行：`node src/cli.js organize …` / `node src/cli.js fix …`。
- 程序不会上传照片，也不需要联网处理媒体；所有扫描、哈希、复制均在本机执行。
- 本程序**不会自动解压** Google Takeout 压缩包。请保留原始压缩包，手工解压合并后再使用。

> 版本 5.0.0 起仓库不再包含 Python 实现。行为基线来自历史 Python v4.1 版本，迁移期间已完成逐场景差分验证；详见 [CHANGELOG.md](CHANGELOG.md)。

---

## 主要功能

- **Liquid Glass 网页界面**：iOS 26 风格的半透明玻璃材质、动态光影背景、指针跟随高光、弹簧动效、深浅色主题、完整中文界面、响应式布局。
- 识别 Google Takeout 年份目录、普通相册、Archive 与 Trash 中的媒体；支持 `.mts`、HEIC、常见相机 RAW 等扩展名；Windows 上同时识别点号隐藏项与资源管理器隐藏属性（每个扫描根目录一次批量枚举）。
- 通过文件大小 + 完整 SHA-256 识别真正重复的媒体；网页版提供双栏只读对比、缩略图、陈旧检测与处理原因。
- 本机 SHA-256 扫描指纹缓存，再次扫描大型 Takeout 时显著加速；缓存只保存路径、文件状态与摘要。
- 可选识别并成组保留 Apple 实况照片（Live Photo）：内容级容器探测、Apple 内容标识校验、歧义与冲突拒绝、错误后缀恢复（真 MP3 不会被误改）。
- 日期来源按可靠性组合：Takeout JSON → EXIF → 文件名 → 深度 JSON 匹配 → 原文件 mtime（可选）。
- 可选按可靠拍摄日期修正完整 `YYYY-MM-DD(编号)` 型错误文件名（保留编号与扩展名）。
- 输出结构：不分目录 / 按年份 / 按年份+月；未知日期可放入专用目录、输出根目录或跳过。
- 重名策略：自动重命名 / 跳过 / 覆盖（覆盖有确认警告）。
- 相册方案：相对快捷方式或符号链接、实体副本、`albums-info.json` 索引、忽略相册。
- 先扫描预览再执行；执行中可取消；完成后生成 `gpth-run-report.json`。
- 独立的「修复文件日期」模式：递归推断日期并修正 mtime（支持仅预演）。
- 所有文件写入使用安全事务：临时文件 + 原子替换、成组实况照片事务回滚、MOVE 降级保护、输出目录锁。

## 系统要求

- **Node.js ≥ 20.19**（推荐 Node 22/24；支持 Windows / macOS / Linux）。
- npm 或 pnpm（仓库包含 `pnpm-lock.yaml`）。
- 运行依赖：`sharp`（图像解码与缩略图）、`heic-decode`（HEIC/HEIF 解码）。
- 浏览器：Chrome / Edge / Safari / Firefox 近两年版本（需要 `backdrop-filter` 以获得完整玻璃效果；降级模式下仍可使用）。

## 安装

```bash
# 在仓库根目录
npm install        # 或 pnpm install
```

## 启动网页界面

```bash
npm start                          # 等价 node src/cli.js web
node src/cli.js web --no-open      # 不自动打开浏览器
node src/cli.js web --port 9000    # 指定端口（被占用时自动 +1 顺延）
node src/cli.js                    # 无参数同样启动网页界面
```

启动后终端输出：

```text
PhotoTakeout Studio 已启动：http://127.0.0.1:8788
按 Ctrl+C 停止服务。
```

Windows 可直接双击 [start_web.bat](start_web.bat)（首次会自动安装依赖）。服务只监听 `127.0.0.1`，不对外网开放；POST/PUT/DELETE 带同源校验。任务在后台 worker 线程中运行，扫描/执行期间界面保持响应；刷新页面会重新连接本机服务。

### 网页界面使用步骤

1. **整理 Takeout** 页选择已合并解压的 Takeout 输入目录与整理结果输出目录。
2. 选择处理方式（默认**复制**）、相册方案、目录结构、同名策略、未知日期策略。
3. 「高级选项」调整日期来源、深度 JSON 匹配、文件 mtime、隐藏文件、回退扫描、并发线程数、指纹缓存等；如含实况照片，勾选「识别并配对实况照片」并选择后续导入方式。
4. 点击 **扫描预览**：显示发现媒体、去重后、重复组、日期未知、计划动作数量，并以虚拟滚动分批载入全部计划行。
5. 如存在重复组，点击 **重复项对比**：左栏重复组列表，右栏固定显示主文件与可切换副本，包含缩略图、完整路径、相册、大小、格式/分辨率、修改时间、拍摄日期来源、SHA-256、处理状态与陈旧检测。该窗口只读。
6. 确认无误后点击 **开始整理**。移动/覆盖模式会弹出额外确认；若预览后修改了选项，会先提示需要重新扫描。
7. 执行中可点击 **取消**；程序在安全检查点停止，已完成的独立文件保留。
8. 完成后查看结果摘要、**运行日志**页与输出目录中的 `gpth-run-report.json`。

**修复文件日期** 页适用于已整理好的媒体目录：选择目录与日期来源，勾选「仅预演」先核对；需要修正错误日期型文件名时再勾选对应选项。该操作只修改文件 mtime（以及严格限定的文件名），不重组目录。

**设置与关于** 页可切换外观模式、界面缩放比例、每批预览行数、清理扫描指纹缓存、是否记住最近目录，并查看版本与安全建议。

## 命令行使用

```bash
node src/cli.js --help
node src/cli.js organize --help
node src/cli.js fix --help
node src/cli.js --version
```

安装为命令（可选）：

```bash
npm link           # 之后可直接使用 gpth
gpth organize -i "/path/to/merged-takeout" -o "/path/to/output" --operation copy
```

### 整理 Takeout

```bash
node src/cli.js organize \
  --input "/path/to/merged-takeout" \
  --output "/path/to/output" \
  --operation copy \
  --albums shortcut \
  --divide year-month \
  --conflict rename \
  --unknown folder \
  --recognize-live-photos \
  --live-photo-target apple \
  --workers 4
```

Windows PowerShell 单行示例：

```powershell
node src/cli.js organize -i "D:\Takeout-merged" -o "E:\Photos" --operation copy --albums shortcut --divide year-month --conflict rename --unknown folder
```

| 参数 | 作用 |
| --- | --- |
| `-i, --input DIR` | 已解压并合并的 Takeout 输入目录 |
| `-o, --output DIR` | 整理结果目录（不能与输入相同） |
| `--operation copy\|move` | 复制或移动（默认 copy） |
| `--albums MODE` | `shortcut`、`duplicate-copy`、`json`、`nothing` |
| `--divide MODE` | `flat`、`year`、`year-month` |
| `--conflict MODE` | `rename`、`skip`、`overwrite` |
| `--unknown MODE` | `folder`、`root`、`skip` |
| `--skip-extras` | 跳过常见编辑后副本 |
| `--no-json` / `--no-exif` / `--no-filename` | 关闭对应日期来源 |
| `--no-aggressive-json` | 禁用深度 JSON 文件名匹配 |
| `--use-mtime` | 把输入文件 mtime 作为最后日期来源 |
| `--no-set-mtime` | 不修改输出文件的 mtime |
| `--correct-date-filenames` | 按拍摄日期修正 `YYYY-MM-DD(编号)` 型文件名 |
| `--no-fallback-scan` | 找不到标准 Takeout 目录时不扫描全部媒体 |
| `--include-hidden` | 扫描隐藏文件和目录 |
| `--no-report` | 不生成运行报告 |
| `--no-hash-cache` | 不读取或写入本机 SHA-256 扫描缓存 |
| `--recognize-live-photos` | 识别静态图 + 动态片段并作为实况资产整理 |
| `--live-photo-target apple\|coloros16` | 选择后续导入方式并自动启用实况识别（两者输出均为 Apple 原始双文件） |
| `--all-photos-folder NAME` | 自定义主时间线目录名 |
| `--unknown-folder NAME` | 自定义未知日期目录名 |
| `--workers N` | 日期提取并发数（1–32） |
| `--dry-run` | 只分析并展示计划，不写入输出 |
| `--plan-json FILE` | 把执行计划写入 JSON 文件 |

自动化任务建议：

```bash
node src/cli.js organize -i INPUT -o OUTPUT --dry-run --plan-json plan.json
# 检查 plan.json 与预览后，再移除 --dry-run 执行
```

### 修复文件日期

```bash
node src/cli.js fix "/path/to/photos" --dry-run
node src/cli.js fix "/path/to/photos" --use-mtime
node src/cli.js fix "/path/to/photos" --dry-run --correct-date-filenames
```

`fix` 默认递归处理；`--no-recursive` 只处理当前层；`--include-hidden` 包含隐藏项。支持与整理模式相同的日期来源开关。建议先 `--dry-run`。

### 旧版命令兼容

```bash
node src/cli.js -i "/input" -o "/output" --copy --divide-to-dates --albums shortcut
node src/cli.js --fix "/path/to/photos"
node src/cli.js gui          # 启动网页界面
node src/cli.js --interactive
```

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功（含 `--dry-run` 预览） |
| `1` | 有文件操作错误，或未处理异常 |
| `11` | 配置/选项错误（输入输出相同、目录无效等） |
| `13` | 输入目录没有发现受支持的媒体 |
| `130` | 任务被用户取消（Ctrl+C 或界面取消） |

自动任务请检查进程退出码以及输出目录中的 `gpth-run-report.json`。

## 输出结构示例

按年份/月分组并使用快捷方式相册时：

```text
输出目录/
├─ ALL_PHOTOS/
│  ├─ 2023/
│  │  ├─ 01/
│  │  └─ 12/
│  ├─ 2024/
│  │  └─ 08/
│  └─ date-unknown/
├─ Vacation/
│  └─ 2024/
│     └─ 08/
└─ gpth-run-report.json
```

使用 JSON 相册模式时，根目录还会包含 `albums-info.json`。Windows 上相册快捷方式为 `.lnk` 文件，Unix 上为相对符号链接。

## 关键选项与行为说明

### 重复项对比

扫描只把「文件大小相同且完整 SHA-256 相同」的文件归入同一重复组。网页对比窗口是只读的：左栏选择重复组，右栏固定显示主文件，并可逐个切换其它成员。

- **主文件**：作为主来源进入整理计划。
- **相册来源**：内容相同，用于保留相册关系，不计入去重节省空间。
- **同来源跳过**：不会进入输出计划，源文件不会被删除。
- **规则过滤**：由「跳过编辑副本」等选项排除，源文件同样不会因此被删除。

如果文件在扫描后被修改或移走，详情区显示陈旧提示；重新扫描即可刷新。视觉相似但字节不同、重新压缩或重新导出的照片不会被自动判为重复项。

### 扫描指纹缓存

「高级选项」中的「复用未变化文件指纹」默认开启。首次扫描为同大小候选计算完整 SHA-256；以后扫描同一路径时，只有路径、大小和纳秒修改时间都与缓存一致才复用。缓存不保存照片内容、缩略图、EXIF 或 Google JSON。

缓存文件位于本机用户配置目录：

- Windows：`%APPDATA%\GooglePhotosTakeoutHelper\scan-cache-v1.json`
- macOS：`~/Library/Application Support/GooglePhotosTakeoutHelper/scan-cache-v1.json`
- Linux：`$XDG_CONFIG_HOME/GooglePhotosTakeoutHelper/scan-cache-v1.json`

可在「设置与关于」页清理；清理不会删除照片或已有扫描结果。CLI 使用 `--no-hash-cache` 关闭。

### 实况照片（Live Photo）

「识别并配对实况照片」默认关闭，勾选后：程序在同一真实目录内寻找同基名的 HEIC/HEIF/JPEG 静态图与 MOV/MP4/M4V 动态片段，并检查动态文件是否具有 ISO-BMFF `ftyp` 容器和视频轨。只有一图一视频且内容检查通过时才自动配对；一对多候选保留为普通媒体并写入警告日志。

Google Takeout 有时给动态片段错误或缺失的扩展名。若 `.mp3`、`.mp` 或无扩展名文件实际包含 MOV/MP4 容器和视频轨，输出副本会恢复 `.mov`/`.mp4` 后缀，但**媒体字节不会转码**；真正的 MP3 没有视频轨，不会被配对、改名或删除。

识别后的两半作为一个复合资产：

- 日期取自静态图并同时用于两半；
- 去重键包含两半 SHA-256，只有整对完全相同才会去重；
- 任一目标重名时两半共同改名，`skip` 整组跳过；
- 复制先完整暂存两半再提交；移动只在两个目标落盘后处理源文件；
- 即使选择快捷方式相册模式，实况照片仍使用同目录同基名的实体文件。

后续导入方式：

- **Apple 照片（原始双文件）**：保持原始媒体字节，并校验可读取的 Apple 内容标识与关键帧元数据。导入 Mac「照片」时应一次同时选择两半。
- **OPPO ColorOS 16（经 O+ 互联）**：输出同样是 Apple 原始双文件；建议先导入 Apple「照片」，再通过 OPPO 官方 O+ Connect 发送到 ColorOS 16。程序不会伪造未公开的 OPPO 单文件封装。

扫描摘要会显示元数据完整比例、不完整组、后缀恢复数、歧义候选数和标识冲突拒绝数；存在需检查项目时界面使用警告色。

### 复制与移动

- **复制**：保留输入文件，安全性最高；默认选项。
- **移动**：成功后输入文件离开原目录；速度/空间更好，但中断影响更大。务必保留 Takeout 原始压缩包。

输入与输出不能是同一目录。跨磁盘移动会自动退化为「复制完成后删除源文件」，并在失败时尽力保留源文件。

### 相册模式

- `shortcut`：主时间线只保存一份实体媒体，相册目录创建相对符号链接/Windows 快捷方式；创建失败时尽力退化为实体副本。
- `duplicate-copy`：主时间线与每个相册都保存实体文件；兼容性最好、最占空间。
- `json`：所有媒体放入 `ALL_PHOTOS`，并生成 `albums-info.json` 描述相册关系。
- `nothing`：忽略相册结构，只整理主时间线。

### 日期目录

- `flat`：媒体直接放在主目录/相册目录下。
- `year`：例如 `ALL_PHOTOS/2024/照片.jpg`。
- `year-month`：例如 `ALL_PHOTOS/2024/08/照片.jpg`（默认）。

无法确定日期时默认进入 `date-unknown`；目录名可在界面/参数中自定义。

### 日期来源

默认按以下顺序寻找第一条可用日期：

1. Google Takeout 旁车 JSON 的 `photoTakenTime`（支持秒、毫秒、ISO 8601、`.supplemental-metadata.json`、51 字符截断名、括号换位等命名）。
2. 图片 EXIF 的 `DateTime` / `DateTimeOriginal` / `DateTimeDigitized`（含 HEIC/HEIF）。
3. 手机、相机、截图和视频常见文件名中的日期（6 种格式）。
4. 更宽松的 JSON 文件名匹配（`-edited(1)`、截断名、未知编辑后缀、副本编号）。
5. 原文件 mtime（仅在用户明确启用时作为最后回退）。

文件名日期是推断值，应在预览中重点抽查。程序默认只设置输出文件 mtime，不把 JSON、GPS 或日期写回照片 EXIF。

### 重名策略

- `rename`：在文件名后追加编号，避免覆盖（推荐）。
- `skip`：保留已有文件，不写入冲突项。
- `overwrite`：替换已有目标，可能造成数据丢失；仅应在确认输出目录内容可恢复时使用。

## 已知限制

1. **图像格式覆盖**：缩略图由 `sharp`（JPEG/PNG/WebP/GIF/TIFF/AVIF）与 `heic-decode`（HEIC/HEIF）生成；RAW、BMP/ICO 等不支持的格式在对比窗口显示完整文件信息与说明卡，但不影响哈希比较与整理。
2. **亚毫秒时间戳**：运行报告中的日期沿用 Python `datetime.isoformat()` 兼容格式；JS `Date` 只有毫秒精度，因此 JSON 时间戳若带亚毫秒部分会按毫秒截断（Takeout 实际数据为整秒或整毫秒，不受影响）。
3. **视频缩略图**：内置预览不解码视频，显示信息卡。
4. Windows 快捷方式与 Unix 符号链接并不完全等价；跨系统迁移优先使用实体副本或 JSON 模式。
5. 部分云盘、NAS、FAT/exFAT 或只读文件系统无法保存全部时间范围和权限信息；设置 mtime 失败会记录警告。
6. Windows 对 1970 年以前的文件时间支持不一致，程序会使用兼容时间并在日志中提示。
7. 未知或损坏编码的 JSON、损坏图片和超大文件会尽量跳过并记录，不中断整个任务。

**安全提示**：保留全部原始 Takeout 压缩包，直到完成抽查和备份；本工具不是备份软件，重要照片至少保留两份独立副本。

## 项目结构

```text
src/
├─ cli.js                 # 命令行入口（organize / fix / web / 旧版兼容）
├─ engine.js              # 业务编排：扫描→去重→取日期→相册合并→计划→执行 / 日期修复
├─ scanner.js             # Takeout 目录发现与媒体扫描
├─ date-extractors.js     # JSON / EXIF / 文件名 / mtime 日期提取
├─ exif.js                # EXIF 日期与方向读取（含 HEIC 容器解析）
├─ image-support.js       # HEIF 识别与解码器诊断
├─ grouping.js            # 去重、编辑副本过滤、相册合并
├─ planner.js             # 生成可预览、无副作用的执行计划
├─ executor.js            # 执行计划（复制/移动/快捷方式/相册索引/运行报告）
├─ duplicates.js          # 重复项探测与缩略图
├─ live-photos.js         # 实况照片识别、Apple 元数据校验与成组目标规划
├─ file-utils.js          # 哈希、原子复制、事务回滚、锁、快捷方式、mtime
├─ scan-cache.js          # SHA-256 扫描指纹缓存
├─ settings.js            # 跨平台设置持久化
├─ models.js / constants.js / time.js / async-utils.js
├─ index.js               # 库入口（可 import 作为 Node.js 库使用）
└─ web/
   ├─ server.js           # HTTP 服务、REST API、静态文件
   ├─ jobs.js             # 会话管理、SSE 进度回放、取消、空闲回收
   ├─ job-worker.js       # worker_threads 中运行引擎（不阻塞界面）
   ├─ serialize.js        # 分析与计划序列化
   ├─ thumbnails.js       # 缩略图 LRU 缓存 + 并发限制
   ├─ fs-browse.js        # 目录浏览接口（网页目录选择器）
   ├─ start.js            # 启动 Web UI、端口选择、打开浏览器
   └─ public/             # Liquid Glass 前端（HTML/CSS/ES Modules）
docs/ARCHITECTURE.md      # 架构、模块接口与 Web API 说明
tools/                    # 可选的 UI 截图 / 端到端验收脚本（Node + Edge）
tests/                    # node:test 单元与集成测试
```

## 开发与测试

```bash
node --test                                # 全部 Node 测试（159 项全部通过）
```

可选 UI 验收脚本（需要本机 Microsoft Edge 与 `puppeteer-core`，并先启动 Web 服务；测试数据需通过参数传入，仓库不内置媒体夹具）：

```bash
node tools/ui-check.mjs --url http://127.0.0.1:8788      # 单页截图 + 控制台错误
node tools/ui-scenes.mjs                                 # 多页面/弹窗/深色截图
node tools/ui-e2e.mjs --source "D:\\Takeout-merged"      # 扫描→预览→重复项→执行 端到端
node tools/ui-flow-tests.mjs --takeout-source "D:\\Takeout-merged" --fix-source "D:\\Photos"
```

新增文件操作测试时必须使用临时目录，不要在仓库根目录创建或删除固定名称的照片。

## 版本与移植背景

- **v5.0.0**：全面迁移到 Node.js，新增 Liquid Glass 网页界面；移除 Python 实现、PyInstaller 构建脚本与 Python 依赖配置，仓库现为纯 Node.js 项目。详见 [CHANGELOG.md](CHANGELOG.md)。
- 行为基线来自本项目的 Python v4.1 版本（其本身以 Dart v3.4.3 行为为兼容基线）；迁移期间以 Python 参考实现完成逐场景差分验证，验证后参考实现已移除。
- 项目最初由 [TheLastGimbus](https://github.com/TheLastGimbus/GooglePhotosTakeoutHelper) 创建，许可证为 Apache License 2.0，见 [LICENSE](LICENSE)。
- 架构与模块接口说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

相关链接：[Google Takeout](https://takeout.google.com/) · [Apple Live Photo 元数据说明](https://developer.apple.com/documentation/avfoundation/avcapturephotosettings/livephotomoviemetadata) · [问题反馈](https://github.com/obsidianplusplus/GooglePhotosTakeoutHelper/issues)

Google Photos、Google Takeout 等名称及商标归其各自权利人所有，本项目与 Google 无隶属关系。
