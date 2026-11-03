# OpenCode TPS Overlay

[English](README.en.md) | 简体中文

[![CI](https://github.com/GarrulousSparrow/opencode-tps-overlay/actions/workflows/ci.yml/badge.svg)](https://github.com/GarrulousSparrow/opencode-tps-overlay/actions/workflows/ci.yml)
![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D6)
![python](https://img.shields.io/badge/python-3.8%2B-3776AB)
![license](https://img.shields.io/badge/license-MIT-green)

一个给 **OpenCode V2 Desktop** 用的独立 TPS 悬浮窗。

- OpenCode 侧的插件负责监听 V2 事件流、计算指标，并写入 `state.json`。
- Python + tkinter 悬浮窗负责读取 `state.json`，始终置顶显示实时指标。
- 不修改 OpenCode Desktop 的界面，也不用把 UI 注入 Electron。

## 功能

- 实时估算 TPS、真实解码 TPS、端到端 TPS、平均 TPS、峰值 TPS、TTFT、输出 token 数
- 最近 60 秒 sparkline，并用亮度区分「估算点」与「usage 回填点」
- 链路诊断：delta 到达间隔、突发比例、停顿次数、`streamHealth`
- 中英 CJK / 非 CJK 双比例在线校准
- 空闲时保留上一次完成的指标，并显示为 `LAST` / `上次`
- 中文界面默认启用，可在右键菜单切换 English
- 多会话忙碌计数
- 始终置顶、无边框、可拖动、不占任务栏
- 位置、透明度、紧凑模式自动保存
- 自动启动悬浮窗（可关闭）
- 可选注册 `tps` 工具，让模型或命令查询当前指标

## 目录结构

仓库根目录（安装后即 `%USERPROFILE%\.config\opencode\plugins\tps-overlay`）：

```
tps-overlay\
├─ index.js          # OpenCode V2 插件
├─ overlay.py        # Python tkinter 悬浮窗
├─ locales\
│  ├─ zh-CN.json     # 中文界面
│  └─ en.json        # English UI
├─ package.json      # ESM 包入口与元数据
├─ install.ps1       # 安装脚本（快捷方式 / 启动器）
├─ deploy.ps1        # 开发用：把源码部署到 OpenCode 插件目录
├─ test-metrics.mjs  # 合成事件指标测试（不连接 provider）
├─ .github\workflows\ci.yml  # CI：语法检查 + 指标测试
├─ .editorconfig
├─ .gitattributes
├─ .gitignore
├─ CHANGELOG.md      # 版本变更记录
├─ LICENSE           # MIT
├─ README.md         # 中文说明
└─ README.en.md      # English README
```

悬浮窗默认使用中文界面。右键菜单里的「语言」可以在中文和 English 之间切换，
选择会保存到 `window.json`。也可以用环境变量 `TPS_OVERLAY_LANG=en` 强制英文。

运行时文件默认位于：

```
%LOCALAPPDATA%\opencode-tps-overlay\
├─ state.json      # 插件写入的实时状态
├─ window.json     # 悬浮窗位置 / 透明度 / 紧凑模式 / 语言
├─ overlay.pid     # 当前悬浮窗进程号
├─ launch-overlay.cmd  # install.ps1 创建的启动器
├─ plugin.log      # 插件日志
├─ overlay.log     # 悬浮窗日志
└─ events.jsonl    # 仅在 TPS_OVERLAY_DEBUG=1 时产生
```

`install.ps1` 还会在开始菜单创建 `OpenCode TPS Overlay` 快捷方式；使用 `-Startup`
时会再加入当前用户的开机启动目录。

## 前置条件

- Windows 10 / 11
- OpenCode V2 Desktop
- Python 3.8 或更高版本，并且包含 tkinter（官方 Windows 安装包默认包含）
- OpenCode V2 桌面端的 CLI 可执行文件：

```
C:\Users\<用户名>\AppData\Local\Programs\@opencodedesktop\resources\opencode-cli.exe
```

> **注意**：不要用 PATH 里的 `opencode` 验证 V2 插件。那通常是 V1 的 CLI，不会加载 V2 插件。
> 验证插件时应直接使用上面的 `opencode-cli.exe`，或直接看 OpenCode Desktop 的日志。

## 安装

### 方式一：从 GitHub 克隆（推荐）

```powershell
git clone https://github.com/GarrulousSparrow/opencode-tps-overlay.git "$env:USERPROFILE\.config\opencode\plugins\tps-overlay"
cd "$env:USERPROFILE\.config\opencode\plugins\tps-overlay"
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Launch
```

不用 `git` 时，下载仓库 ZIP 并解压到同一目录即可，目录名保持 `tps-overlay`（更新时用同一方式覆盖）。

克隆后重启 OpenCode Desktop，插件会自动发现并加载。

### 方式二：手动复制

把整个仓库目录放到：

```
%USERPROFILE%\.config\opencode\plugins\tps-overlay
```

然后继续下面的步骤：

1. 检查 Python 和 tkinter：

   ```powershell
   python -c "import tkinter; print(tkinter.TkVersion)"
   ```

2. 运行安装脚本（可选，用于创建启动器 / 开始菜单快捷方式）：

   ```powershell
   cd "$env:USERPROFILE\.config\opencode\plugins\tps-overlay"
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. 重启 OpenCode Desktop。插件会自动被发现、加载，并尝试启动悬浮窗。

4. 确认插件已加载：

   ```powershell
   Get-Content "$env:LOCALAPPDATA\opencode-tps-overlay\plugin.log" -Tail 20
   ```

   正常应看到 `starting`，并看到 `overlay spawned` 或 `overlay already running`。

## 安装脚本参数

```powershell
# 只检查环境并创建开始菜单快捷方式
.\install.ps1

# 同时加入当前用户的开机启动目录
.\install.ps1 -Startup

# 安装后立即启动悬浮窗
.\install.ps1 -Launch

# 指定 Python（例如虚拟环境或非标准安装路径）
.\install.ps1 -Python "C:\Python311\python.exe"

# 移除快捷方式并关闭悬浮窗（不会删除插件文件）
.\install.ps1 -Uninstall
```

如果没有使用 `install.ps1`，也可以直接启动：

```powershell
pythonw "$env:USERPROFILE\.config\opencode\plugins\tps-overlay\overlay.py"
```

## 使用

| 操作 | 效果 |
| --- | --- |
| 左键拖动 | 移动悬浮窗，松开后保存位置 |
| 双击 | 切换紧凑 / 普通模式 |
| 右键 | 菜单：紧凑模式、透明度、语言、重置位置、刷新状态、关闭 |
| `Close overlay` / `关闭悬浮窗` | 关闭悬浮窗；OpenCode 下次启动时会再次拉起 |

紧凑模式只显示标题、模型、大号速度（`DECODE` 或 `TPS`）、sparkline 和输出 token 数，适合放在屏幕角落。
普通模式额外显示 `平均`、`峰值`、`首字延迟`、`输出`（English UI 下为 `AVG`、`PEAK`、`TTFT`、`OUT`）。

## 指标定义

从 schema 2 开始，「估算速度」和「真实解码速度」分开输出。悬浮窗的大号数字优先显示
`decodeTps`，并在旁边标 `DECODE` / `解码`；还没有真实 usage 时退回显示 `liveTps`，
旁边标 `TPS`。

| 指标 | 含义 |
| --- | --- |
| `decodeTps` | **模型真实解码速度** = usage tokens / 纯解码时长；纯解码时长 = step 时长 − 该 step 自己的 TTFT。只有时长 ≥ 500ms 的 step 才会更新它，纯解码时长下限 250ms |
| `e2eTps` | 用户实际感受到的吞吐 = usage tokens / (`session.step.ended` − `session.execution.started`)，包含排队、prefill、TTFT 和工具间隔 |
| `liveTps` / `tps` | 实时估算。最近约 5 秒的流式 delta 按字符折算，按 step 起点量出的实际时间窗计算，`liveTpsSource` 固定为 `"estimated"` |
| `avgTps` / `平均` | **含 TTFT 的 step 级吞吐** = 可测量 step（时长 ≥ 500ms）的 usage tokens / 这些 step 的总时长。过短的 step 只计入 `OUT`，不计入时长，避免把工具调用 step 当成高速解码 |
| `peakTps` / `峰值` | 只统计同时满足 `tokens >= 32` 且 `durationMs >= 500` 的 step；本次执行尚未完成任何 step 时才回退到实时估算峰值。`peakSource` 为 `"usage"` 或 `"estimated"` |
| `TTFT` / `首字延迟` | 从 `session.execution.started` 到第一个文本 / 推理 delta 的毫秒数 |
| `OUT` / `输出` | 本次执行的实际输出 token 数 |
| `LAST` / `上次` | 空闲状态，显示上一次完成执行的指标 |

所有对外输出的速度（`liveTps`、`decodeTps`、`e2eTps`、`avgTps`、`peakTps`、
sparkline）都会 clamp 到 0–2000 tok/s，避免异常样本把数字推到几万、几十万。

`avgTps` 包含 TTFT，所以通常会明显低于 `decodeTps`。TTFT 很长时二者差距最大，
这是口径不同，不是统计错误。

### 字符估算与校准

实时估算把文本拆成两类：

- `cjkRatio`：CJK 字符（汉字、假名、韩文）的 token/字比例，默认 `0.65`，clamp 到 `0.4 ~ 1.0`
- `nonCjkRatio`：其他字符的比例，默认 `0.30`，clamp 到 `0.1 ~ 0.6`

每个带真实 usage 的 step 结束后，插件把该 step 的 `cjk` 字符数、非 CJK 字符数和
`tokens.output` 加入最近 16 个样本，用最小二乘同时拟合两个比例。
样本少于 3 个 step 时不做校准，避免单步噪声。

### sparkline 口径

`spark` 仍然保存最近 60 秒每秒峰值，但每个点新增来源标记：

- `sparkSource[i] = 0`：字符估算值
- `sparkSource[i] = 1`：step 结束后用真实 usage 回填的值

悬浮窗里亮绿色是 usage 回填点，暗绿色是估算点。step 结束时，插件会按该 step 覆盖的
时间段把估算点覆盖为真实 usage 派生的值，避免两条曲线口径互相矛盾。

同时输出：

- `sparkMaxUsage`：当前窗口内 usage 回填点的最大值
- `sparkMaxEstimated`：当前窗口内估算器实际达到过的最大值（即使该点随后被 usage 覆盖）

两者差距越大，说明估算器受突发流 / CJK 比例影响越明显。

## 链路诊断

插件在 `onDelta` 里记录相邻 delta 的到达间隔，只在内存中滚动保留最近 200 个，
不写日志、不产生每个 delta 的磁盘 IO。`state.json` 的 session 对象会输出：

| 字段 | 含义 |
| --- | --- |
| `gapP50Ms` / `gapP95Ms` / `gapMaxMs` | delta 到达间隔的中位数 / P95 / 最大值 |
| `burstRatio` | 间隔小于 30ms 的 delta 占比 |
| `stallCount` | 间隔大于 500ms 的次数 |
| `streamHealth` | `smooth` / `bursty` / `stalled` |

判定规则：

- `burstRatio > 0.6` 且 `stallCount > 2` → `bursty`
- 否则 `gapP95Ms > 800` → `stalled`
- 否则 `smooth`

怎么读：

- `bursty` / `stalled`：delta 成批到达或长时间断流，通常是 SSE / 代理 / 网络缓冲，
  此时 `liveTps` 的瞬时高点不可信
- `smooth` 但 `decodeTps` 低：链路没有明显缓冲，是 provider 侧本身解码慢
- `smooth` 且 `decodeTps` 高：模型速度和链路都正常

悬浮窗在 busy 时会把 `streamHealth`、P95 间隔和停顿次数显示在底部。

## 配置

通过环境变量调整行为。插件和悬浮窗都会读取这些变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TPS_OVERLAY_DATA_DIR` | `%LOCALAPPDATA%\opencode-tps-overlay` | 状态和日志目录 |
| `TPS_OVERLAY_LANG` | `zh-CN` | 界面语言：`zh-CN` 或 `en`；优先级高于已保存的选择 |
| `TPS_OVERLAY_AUTOSTART` | `1` | 设为 `0` 时插件不自动启动悬浮窗 |
| `TPS_OVERLAY_DEBUG` | `0` | 设为 `1` 时写 `events.jsonl`，并记录 step 校准信息 |
| `TPS_OVERLAY_PYTHON` | 自动查找 `pythonw.exe` / `python.exe` | 指定 Python 可执行文件 |
| `TPS_OVERLAY_POLL_MS` | `200` | 悬浮窗读取 `state.json` 的间隔，范围 100–2000 |
| `TPS_OVERLAY_ALPHA` | 已保存值或 `0.92` | 初始透明度，范围 0.28–1.0 |

示例（仅对当前 PowerShell 会话生效）：

```powershell
$env:TPS_OVERLAY_DEBUG = "1"
$env:TPS_OVERLAY_POLL_MS = "150"
$env:TPS_OVERLAY_LANG = "en"   # 临时切换为英文界面
```

如果希望 OpenCode Desktop 启动时也带上这些变量，需要在启动 OpenCode 前设置，
或使用系统「环境变量」设置用户级变量。

## tps 工具

插件会尝试注册一个名为 `tps` 的工具。它的输出类似：

```
OpenCode TPS (live)
- BUSY 当前会话 (deepseek-v4.1-flash-free): tps=514.9 avg=116.9 peak=1408.3 ttft=102ms out=20610 decode=132.4 e2e=98.7 link=smooth/p95:24ms/stall:0
State file: C:\Users\...\AppData\Local\opencode-tps-overlay\state.json
```

可以传入 `sessionID` 只看某个会话；不传时列出最近 6 个会话。
1.1.0 起在原有字段后追加 `decode=`、`e2e=`、`link=`，原有字段名和顺序保持不变。

## 状态文件与性能

- `state.json` 的 `schema` 升到 `2`；新增字段全部是追加，旧版 `overlay.py` 仍可读取。
- 新版 `overlay.py` 在缺少 `decodeTps`、`sparkSource`、`streamHealth` 时会自动退化：
  主数字显示 `tps`，sparkline 使用旧的单色曲线，不显示链路行。
- 状态文件仍然每 `TICK_MS = 300ms` 生成一次内容，但改为异步原子写；内容未变化时跳过，
  空闲时最多每 1 秒写一次心跳，避免悬浮窗误判离线。
- 每个 delta 只做内存计数和滑动裁剪，不做同步磁盘 IO，也不做 O(n²) 操作。

## 测试

`test-metrics.mjs` 使用合成事件序列，不连接真实 provider，也不写真实 `state.json`：

```powershell
cd "$env:USERPROFILE\.config\opencode\plugins\tps-overlay"
node .\test-metrics.mjs
```

覆盖平滑流、突发流、短 step、TTFT 分离、CJK 校准和 reasoning/text 去重。

## 开发

仓库本身就是插件的完整源码，没有构建步骤。修改后按下面的流程验证和部署：

```powershell
# 语法检查 + 指标测试（CI 也执行这两步）
node --check index.js
npm test              # 等价于 node .\test-metrics.mjs

# 部署到 OpenCode 全局插件目录
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

- `deploy.ps1` 只复制文件，不删除目标目录中的内容；默认目标是
  `%USERPROFILE%\.config\opencode\plugins\tps-overlay`，可用 `-Destination` 覆盖。
- 修改 `index.js` 后需要重载插件或重启 OpenCode Desktop。
- 修改 `overlay.py` 后需要关闭并重新打开悬浮窗。
- 提交前确认 `.gitignore` 已排除 `state.json`、`window.json`、`*.log` 等运行时文件。
- 版本变更请同步更新 `package.json`、`index.js` 里的 `VERSION` 和 `CHANGELOG.md`。

欢迎提交 Issue 和 PR；请先跑通 `npm test`。

## 故障排查

### 悬浮窗没有出现

1. 查看 `plugin.log`：
   - `overlay script missing`：`overlay.py` 不在插件目录，或插件加载时文件还没放好。重启 OpenCode 即可。
   - `unable to start overlay: no Python executable found`：设置 `TPS_OVERLAY_PYTHON`，或把 Python 加入 PATH。
   - `overlay already running`：已有实例在运行，检查任务管理器里的 `pythonw.exe`。
2. 查看 `overlay.log`：
   - `tkinter could not create a window`：Python 缺少 tkinter，重新安装官方 Python。
   - `another overlay instance is already running`：命名 mutex 阻止了第二个实例，属正常行为。

### 显示 `OFFLINE`

`state.json` 超过 `staleAfterMs`（默认 5 秒）没有更新。通常是 OpenCode 已退出、插件停止，
或插件事件流异常。查看 `plugin.log` 是否有 `event stream error`。

### 一直显示 `WAITING`

插件已加载但还没有收到任何会话事件。先在 OpenCode 里发一条消息。
如果仍然没有，检查 `state.json` 是否在更新。

### TPS 明显偏高或偏低

先看大号数字旁边是 `DECODE` 还是 `TPS`：

- `DECODE`：来自真实 usage，只排除 TTFT，是模型解码速度
- `TPS`：字符估算，会受 CJK 比例和链路缓冲影响

`liveTps` 与 `sparkMaxEstimated` 偏高时，对照 `streamHealth`：

- `bursty` / `stalled`：是链路缓冲，不是模型真的变快
- `smooth` 但 `decodeTps` 仍低：provider 侧解码慢
- 连续几个 step 后 `cjkRatio` / `nonCjkRatio` 会自动校准

如果数字达到几万、几十万（例如 `120000.0`），那是 1.1.0 及更早版本的
「工具调用 step 复用整轮 TTFT」bug：该 step 没有自己的首字时间，
纯解码时长被压到 1ms。1.1.1 起过短的 step 不再参与测速，且所有速度都有
2000 tok/s 上限。

### 悬浮窗挡住内容 / 关不掉

右键选择 `Close overlay`。如果窗口无响应，可在任务管理器结束对应的 `pythonw.exe`，
或删除 `overlay.pid` 后重新启动。

### 重复的悬浮窗

悬浮窗使用命名 mutex，只允许一个实例。若出现多个，通常是不同 Windows 登录会话
（`Local\` 命名空间按登录会话隔离）导致的，属预期行为。

## 隐私说明

- 默认只写指标和会话标题，不写提示词或模型输出。
- 设置 `TPS_OVERLAY_DEBUG=1` 后，`events.jsonl` 会记录完整事件 payload，
  其中可能包含提示词、模型输出、工具参数等敏感内容。
- 调试结束后请关闭该变量，并删除 `events.jsonl`。

## 卸载

1. 右键悬浮窗选择 `Close overlay`。
2. 运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
   ```

3. 删除插件目录：

   ```powershell
   Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\plugins\tps-overlay"
   ```

4. 可选：删除运行时数据：

   ```powershell
   Remove-Item -Recurse -Force "$env:LOCALAPPDATA\opencode-tps-overlay"
   ```

## 已知限制

- 依赖 OpenCode V2 的事件名和 payload。V2 仍在演进，升级后若事件结构变化，
  可能需要更新 `index.js`。
- `liveTps` 是估算值；`decodeTps` / `e2eTps` / `AVG` / `PEAK` / `OUT` 来自实际 usage。
- `streamHealth` 只观察 delta 到达节奏，不能区分是代理、SSE 还是下游网络造成的缓冲。
- 悬浮窗是独立的 Python 进程，不使用 OpenCode Desktop 的渲染进程。

## 许可证

本项目基于 [MIT License](LICENSE) 发布。
