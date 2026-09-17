# Google Photos Takeout Helper Python v4.1

Google Photos Takeout Helper（图形界面名：**PhotoTakeout Studio**）用于整理通过 Google Takeout 导出的照片与视频。它会识别 Takeout 的年份目录和相册目录，匹配旁车 JSON，读取 EXIF 或文件名中的拍摄日期，去除重复项，并按你选择的结构复制或移动到新的输出目录。

Python v4 在原版 v3.4.3 行为基础上重新实现，增加了中文图形界面、扫描预览、安全复制、冲突策略、任务取消、运行报告和更多可配置项。项目背景来自 [TheLastGimbus/GooglePhotosTakeoutHelper](https://github.com/TheLastGimbus/GooglePhotosTakeoutHelper)，许可证见 [LICENSE](LICENSE) 和原项目的 [Apache License 2.0](https://github.com/TheLastGimbus/GooglePhotosTakeoutHelper/blob/master/LICENSE)。

> 重要：本程序**不会自动解压** Google Takeout 压缩包。旧版曾提供交互式解压，但因存在丢失照片的风险而被停用。请保留原始压缩包，手工解压并合并后再使用本程序。

## 主要功能

- 中文深色/浅色图形界面，也保留适合 NAS、Synology 和自动化场景的 CLI。
- 识别 Google Takeout 年份目录、普通相册、Archive 和 Trash 中的媒体。
- 支持图片、视频及 `.mts`、HEIC、常见相机 RAW 等扩展名。
- 通过文件大小与 SHA-256 内容哈希识别真正重复的媒体，并可双栏预览对比。
- 在用户配置目录缓存未变化文件的 SHA-256，可显著加快再次扫描大型 Takeout。
- 可选识别并成组保留 Apple 实况照片；错误命名的 MOV/MP4 动态片段会按内容恢复后缀，真 MP3 不会被误改。
- 可选跳过 `-edited`、`-modifié` 等编辑后副本。
- 按可靠性组合 Takeout JSON、EXIF、文件名、激进 JSON 匹配和原文件 mtime。
- 可选按可靠拍摄日期修正完整的 `YYYY-MM-DD(编号)` 型错误文件名，保留编号和扩展名。
- 输出可选不分目录、按年份、按年份/月分组。
- 未知日期可放入专用目录、输出根目录，或直接跳过。
- 重名文件可自动改名、跳过或覆盖。
- 相册支持相对快捷方式/符号链接、实体副本、JSON 索引或忽略四种方案。
- 支持先扫描预览，再执行实际文件操作；运行中可取消并查看详细日志。
- 提供独立的“修复日期”模式，可修正现有媒体的文件最后修改时间及日期型错误文件名。
- 可生成 `gpth-run-report.json`，记录本次任务配置、统计和错误信息。

## 使用前准备

1. 打开 [Google Takeout](https://takeout.google.com/)。
2. 选择“取消全选”，然后只勾选 Google Photos。
3. 下载全部导出压缩包，并把原始压缩包保存到安全位置。
4. 手工解压所有压缩包。
5. 合并解压结果，使所有内容最终位于同一个输入目录中；通常该目录内只应有一个 `Takeout` 目录树。
6. 准备一个与输入目录不同的输出目录。第一次整理强烈建议使用“复制”模式。

程序不会上传照片，也不需要联网处理媒体。安装 Python 依赖或打开文档链接时才可能访问网络。

## 系统要求

- Python 3.10 或更高版本。
- Windows 10/11、macOS 或主流 Linux 桌面环境。
- 图形界面依赖 `customtkinter`；读取图片 EXIF 依赖 Pillow，HEIC/HEIF 由 `pillow-heif` 提供解码支持。
- CLI 可以在无图形桌面的 NAS 上使用，但仍建议安装 `requirements.txt` 中的依赖，以获得完整 EXIF 支持。
- 输出磁盘应预留足够空间。使用“实体相册副本”时，同一照片可能保存多份。

## 安装

### Windows

在 PowerShell 中执行：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

如果系统阻止激活脚本，可直接使用虚拟环境里的解释器：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m gpth
```

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

如果 Linux 提示缺少 Tk，请通过系统包管理器安装 Tk，例如 Debian/Ubuntu 的 `python3-tk`。

### 安装为命令

开发或源码使用可以执行：

```bash
python -m pip install -e .
```

安装后会得到两个入口：

- `gpth`：命令行入口，对应 `gpth.cli:main`。
- `gpth-gui`：图形界面入口，对应 `gpth.cli:launch_gui`；`python -m gpth` 仍由 `gpth.__main__:main` 进入统一调度。

## 启动图形界面

任选一种方式：

```bash
python -m gpth
python main.py
gpth-gui
gpth gui
```

不带参数运行 `gpth` 时也会启动 GUI。Windows 可以直接双击 `run_gui.bat`，它会优先使用项目的 `.venv`，然后依次尝试 `py` 和 `python`。

## 图形界面使用步骤

1. 在“整理照片”页选择已合并的 Takeout 输入目录和输出目录。
2. 选择复制或移动。Python v4 默认复制，确认结果无误后再考虑移动。
3. 选择相册处理方式、日期目录结构、重名策略和未知日期策略。
4. 在高级选项中调整日期来源、编辑副本、隐藏文件、回退扫描和工作线程数；如有 Live Photo，勾选“识别并配对实况照片”，再选择后续导入方式。
5. 先执行扫描/预览，检查发现的媒体数量、重复组、未知日期和计划操作。
6. 如发现重复组，点击“重复项对比”查看两侧缩略图、完整路径、相册、大小、格式、分辨率、修改时间、拍摄日期来源、SHA-256 和处理原因。
7. 确认后开始执行。不要在运行期间移动输入目录或断开输出磁盘。
8. 完成后查看统计、日志和输出目录中的运行报告；抽查日期、相册和视频后再删除任何原始文件。

“日期修复”页适用于已经整理好的媒体目录。它会递归推断日期并修改文件的最后修改时间，不会重新组织目录；启用“按拍摄日期修正日期型文件名”后，还可修正严格符合 `YYYY-MM-DD(编号)` 的错误名称。该选项默认关闭，建议先启用试运行。

## 关键选项说明

### 重复项对比

扫描只把“文件大小相同且完整 SHA-256 相同”的文件归入同一重复组。对比窗口是只读的：左侧选择重复组，右侧固定显示本次采用的主文件，并可逐个切换其它成员。视频、RAW、HEIC、损坏图片或当前环境无法解码的格式仍会显示完整文件信息，并以说明卡代替缩略图。

窗口会区分以下状态，避免误判：

- **主文件**：作为主来源进入整理计划。
- **相册来源**：内容相同，但用于保留相册关系；它不计入去重节省空间。
- **同来源跳过**：不会进入输出计划，但源文件不会因此被程序删除。
- **规则过滤**：由“跳过编辑副本”等选项排除，源文件同样不会因此被删除。

如果文件在扫描后被修改或移走，详情区会提示结果可能已过期。重新点击“扫描预览”即可刷新。视觉相似但字节不同、重新压缩或重新导出的照片不会被自动判为重复项。

### 扫描指纹缓存

“高级选项”中的“复用未变化文件指纹”默认开启。首次扫描仍会为同大小候选计算完整 SHA-256；以后扫描同一路径时，只有路径、文件大小和纳秒修改时间都与缓存一致才会复用。缓存不改变判重标准，也不缓存照片内容、缩略图、EXIF 或 Google JSON，只保存本地路径、文件状态和 SHA-256。

缓存文件位于本机用户配置目录中的 `scan-cache-v1.json`。损坏、旧版本或无法读写的缓存会自动降级为完整计算，不会中断扫描。可在“设置与关于”页清理；清理缓存不会删除照片或已有扫描预览。若不希望保存本地文件路径，可关闭该选项，CLI 则使用 `--no-hash-cache`。

### 实况照片（Live Photo）

“高级选项”中的“识别并配对实况照片”默认关闭，勾选后才改变旧有扫描行为。程序在同一个真实目录内寻找同基名的 HEIC/HEIF/JPEG 静态图和 MOV/MP4/M4V 动态片段，并进一步检查动态文件是否具有 ISO-BMFF `ftyp` 容器和视频轨。只有一图一视频且内容检查通过时才自动配对；一对多候选会保留为普通媒体并写入警告日志。

Google Takeout 有时会给动态片段错误或缺失的扩展名。如果名为 `.mp3`、`.mp` 或无扩展名的文件实际包含 MOV/MP4 容器和视频轨，输出副本会恢复为 `.mov` 或 `.mp4`，但媒体字节不会转码。程序只会读取同名可疑文件的少量头尾内容来确认容器；真正的 MP3 音频没有视频轨，不会作为媒体纳入整理，也不会被配对、改名或删除。

识别后的两半会作为一个复合媒体资产处理：

- 日期取自静态图并同时用于两半，避免落入不同年月目录。
- 去重键包含静态图和动态片段两个 SHA-256；只有整对完全相同才会去重。
- 任一目标重名时，两半共同改为相同编号；`skip` 会整组跳过。
- 复制先完整暂存两半再共同提交；任一半失败会尽力回滚并报告未恢复的精确路径，移动也只在两个目标都落盘后处理源文件。
- 即使选择快捷方式相册模式，实况照片仍使用同目录、同基名的实体文件，避免设备导入时丢失动态片段。

后续导入方式说明：两项均输出 Apple 原始双文件，不会生成不同的媒体封装。

- **Apple 照片（原始双文件）**：保持静态图和动态片段的原始媒体字节，并校验可读取的 Apple 内容标识与关键帧元数据。Apple 的配对依据是文件内部标识，不只是同名；只有显示“Apple 元数据完整”的组才能确认标识匹配。导入 Mac“照片”时应一次同时选择两半。[Apple Live Photo 元数据说明](https://developer.apple.com/documentation/avfoundation/avcapturephotosettings/livephotomoviemetadata)
- **OPPO ColorOS 16（经 O+ 互联）**：仍然输出相同的 Apple 原始双文件。建议先导入 Apple“照片”，再通过 OPPO 官方 O+ Connect 发送到 ColorOS 16。OPPO 官方公开支持此设备间 LivePhoto 传输路径，但没有公开 Windows/USB 本地导入的私有封装规范，因此程序不会伪造所谓“OPPO 单文件”。[ColorOS 16 官方说明](https://www.oppo.com/tw/coloros16/)

“Apple 元数据缺失”表示程序识别到了可靠的静态图与视频候选并会安全保留两半，但不能承诺 Apple“照片”将其恢复成可按压播放的 Live Photo；明确冲突的内容标识会拒绝自动配对。扫描摘要会同时显示元数据完整比例、不完整组、后缀恢复数、歧义候选数和标识冲突拒绝数；存在需检查项目时界面使用警告色。程序不会为了制造绿色状态而改写原始 MakerNote、视频轨或私有元数据。

### 复制与移动

- **复制**：保留输入文件，安全性最高，但需要额外磁盘空间；这是 v4 默认设置。
- **移动**：成功后输入文件会离开原目录，速度和空间占用更好，但中断或错误的影响更大。务必保留 Takeout 压缩包。

输入与输出不能是同一目录。输出位于不同磁盘时，建议选择复制。任何情况下都不要把唯一一份照片当作测试数据。

### 相册模式

- **`shortcut`**：主时间线只保存一份实体媒体，相册目录创建相对符号链接或 Windows 快捷方式。最节省空间，但复制到不支持链接的设备时可能失效。创建快捷方式失败时程序会尽量退化为实体副本。
- **`duplicate-copy`**：主时间线与每个相册都保存实体文件，兼容性最好，但最占空间。
- **`json`**：所有媒体统一放入 `ALL_PHOTOS`，并生成 `albums-info.json` 描述文件与相册的关系，适合后续程序化导入。
- **`nothing`**：忽略相册结构，只整理主时间线。仅存在于 Archive、Trash 或相册目录中的文件可能不会进入输出。

### 日期目录

- **`flat`**：媒体直接放在 `ALL_PHOTOS` 或相册目录下。
- **`year`**：例如 `ALL_PHOTOS/2024/照片.jpg`。
- **`year-month`**：例如 `ALL_PHOTOS/2024/08/照片.jpg`，这是 v4 默认设置。

无法确定日期时，默认进入 `date-unknown`。目录名称可在界面中自定义。

### 日期来源

默认按以下思路寻找第一条可用日期：

1. Google Takeout 旁车 JSON 中的 `photoTakenTime`。
2. 图片 EXIF 的 `DateTimeOriginal` 等字段。
3. 手机、相机、截图和视频常见文件名中的日期。
4. 更宽松的 JSON 文件名匹配，用于 `-edited(1)`、截断名等情况。
5. 原文件 mtime，仅在用户明确启用时作为最后回退。

文件名日期只是推断值，应在预览和报告中重点抽查。程序默认只设置输出文件的 mtime，不把 JSON、GPS 或日期写回照片 EXIF。

如启用“按拍摄日期修正日期型文件名”，程序会把名称本身就是完整日期格式的文件（例如 `2025-11-09.jpg`、`2025-11-09(85).heic`）修正为实际拍摄日期。编号和扩展名会原样保留，其他普通文件名不会改动。该选项默认关闭，建议先通过扫描预览或 `fix --dry-run` 核对结果。

### 重名策略

- **`rename`**：在文件名后增加编号，避免覆盖；推荐。
- **`skip`**：保留已有文件，不写入冲突项。
- **`overwrite`**：替换已有文件，可能造成数据丢失，只应在确认输出目录内容可恢复时使用。

未知日期策略分别为 `folder`（专用目录）、`root`（当前输出根目录）和 `skip`（跳过）。

## 命令行使用

安装项目后先查看完整帮助：

```bash
gpth --help
gpth organize --help
gpth fix --help
python -m gpth.cli --help
```

### 整理 Takeout

安全的首次运行示例：

```bash
gpth organize \
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

Windows PowerShell 可以写成一行：

```powershell
gpth organize -i "D:\Takeout-merged" -o "E:\Photos" --operation copy --albums shortcut --divide year-month --conflict rename --unknown folder
```

`organize` 常用参数：

| 参数 | 作用 |
| --- | --- |
| `-i, --input DIR` | 已解压并合并的 Takeout 输入目录 |
| `-o, --output DIR` | 整理结果目录 |
| `--operation copy\|move` | 复制或移动 |
| `--albums MODE` | `shortcut`、`duplicate-copy`、`json`、`nothing` |
| `--divide MODE` | `flat`、`year`、`year-month` |
| `--conflict MODE` | `rename`、`skip`、`overwrite` |
| `--unknown MODE` | `folder`、`root`、`skip` |
| `--skip-extras` | 跳过常见编辑后副本 |
| `--no-json` | 禁用 Takeout JSON 日期 |
| `--no-exif` | 禁用 EXIF 日期 |
| `--no-filename` | 禁用文件名日期猜测 |
| `--no-aggressive-json` | 禁用宽松 JSON 匹配 |
| `--use-mtime` | 把输入文件 mtime 作为最后日期来源 |
| `--no-set-mtime` | 不修改输出文件的 mtime |
| `--correct-date-filenames` | 按拍摄日期修正 `YYYY-MM-DD(编号)` 型名称，并保留编号和扩展名；默认关闭 |
| `--no-fallback-scan` | 找不到标准 Takeout 目录时不扫描全部媒体 |
| `--include-hidden` | 扫描隐藏文件和目录 |
| `--no-report` | 不生成运行报告 |
| `--no-hash-cache` | 不读取或写入本机 SHA-256 扫描缓存 |
| `--recognize-live-photos` | 识别静态图 + 动态片段，并作为一个实况资产整理 |
| `--live-photo-target apple\|coloros16` | 选择后续导入方式并自动启用实况识别；两项均输出 Apple 原始双文件，ColorOS 需经 O+ 互联 |
| `--all-photos-folder NAME` | 自定义主时间线目录名 |
| `--unknown-folder NAME` | 自定义未知日期目录名 |
| `--workers N` | 工作线程数，范围 1 到 32 |
| `--dry-run` | 只分析和规划，不执行文件写入 |
| `--plan-json FILE` | 把执行计划写入 JSON 文件 |

单独指定 `--live-photo-target` 会自动启用实况识别并在日志中说明；不提供实况相关参数时仍保持旧版的关闭行为。兼容 Dart v3 的顶层写法（如 `gpth -i INPUT -o OUTPUT`）也接受 `--recognize-live-photos` 和 `--live-photo-target`。

自动化任务建议先使用 `--dry-run --plan-json plan.json` 检查计划，再移除 `--dry-run` 执行。

### 修复文件日期

```bash
gpth fix "/path/to/photos" --dry-run
gpth fix "/path/to/photos" --use-mtime
gpth fix "/path/to/photos" --dry-run --correct-date-filenames
```

`fix` 默认递归处理，可用 `--no-recursive` 只处理当前层，也可用 `--include-hidden` 包含隐藏项。它支持与整理模式相同的日期源开关：`--no-json`、`--no-exif`、`--no-filename`、`--no-aggressive-json` 和 `--use-mtime`。另加 `--correct-date-filenames` 后，可修正已整理目录中完整的 `YYYY-MM-DD(编号)` 型文件名；编号和扩展名保持不变。建议先执行 `--dry-run`。

### 旧版命令兼容

为了便于已有脚本迁移，v4 仍接受旧式顶层参数：

```bash
gpth -i "/input" -o "/output" --copy --divide-to-dates --albums shortcut
gpth --fix "/path/to/photos"
```

新脚本推荐使用语义更完整的 `organize` 和 `fix` 子命令。自动化脚本应检查进程退出码及 `gpth-run-report.json`。

## 输出结构示例

按年份/月分组并使用快捷方式相册时，输出可能如下：

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

使用 JSON 相册模式时，根目录还会包含 `albums-info.json`。

## Windows 构建

先创建并激活虚拟环境，然后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_windows.ps1
```

默认生成兼容性更好的目录版：

```text
dist\PhotoTakeoutStudio\PhotoTakeoutStudio.exe
```

需要单文件版本时：

```powershell
.\scripts\build_windows.ps1 -OneFile
```

如果依赖已经安装，可加 `-SkipInstall`；如果当前环境的 Python 命令不是 `python`，可使用 `-Python py` 或传入解释器完整路径。

构建脚本使用 PyInstaller，并自动收集 CustomTkinter 主题资源与 Pillow 子模块。生成的 GUI 可执行程序默认不显示控制台；CLI 推荐通过 `pip install .` 安装后使用 `gpth`。

## 开发与测试

```bash
python -m pip install -r requirements-dev.txt
python -m pytest
python -m ruff check .
python -m mypy gpth
python -m build
```

新增文件操作测试时必须使用临时目录，不要在仓库根目录创建或删除固定名称的照片。跨平台相关功能应至少覆盖 Windows、macOS 和 Linux。

## 安全提示与已知限制

- 保留全部原始 Takeout 压缩包，直到完成抽查和备份。
- 本程序不会自动解压压缩包，也不会删除原始压缩包。
- 移动、覆盖、跳过未知日期和忽略相册都可能改变最终文件集合；执行前请确认预览。
- Windows 快捷方式与 Unix 符号链接并不完全等价；跨系统迁移优先使用实体副本或 JSON 模式。
- 视频通常没有可由 Pillow 读取的 EXIF，主要依赖 Takeout JSON、文件名或可选的原 mtime。
- 部分云盘、NAS、FAT/exFAT 或只读文件系统无法保存全部时间范围和权限信息；设置 mtime 失败会记录警告。
- Windows 对 1970 年以前的文件时间支持不一致，程序可能使用兼容时间并在日志中提示。
- 未知或损坏编码的 JSON、损坏的图片和超大文件会尽量跳过并记录，不应让整个任务崩溃。
- 本工具不是备份软件。重要照片至少保留两份独立副本。

## 与原版的关系

原项目最初使用 Python，v3 曾改写为 Dart，并形成了成熟的 JSON 配对、日期猜测、去重和相册逻辑。这里的 Python v4 以 v3.4.3 行为和历史修复为兼容基线，同时把桌面操作、安全默认值和可观测性作为主要改进方向。

当前仓库已清除旧版 Dart 源码、测试和工具链配置，仅维护 `gpth/`、`tests/` 及其 Python 构建与发布流程。

原项目与问题反馈入口：

- [GitHub 仓库](https://github.com/TheLastGimbus/GooglePhotosTakeoutHelper)
- [Issues](https://github.com/TheLastGimbus/GooglePhotosTakeoutHelper/issues)
- [Google Takeout](https://takeout.google.com/)
- [Apache License 2.0](LICENSE)

Google Photos、Google Takeout 等名称及商标归其各自权利人所有，本项目与 Google 无隶属关系。
