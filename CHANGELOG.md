# Changelog

本文件记录 OpenCode TPS Overlay 的版本变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.1.1]

### Fixed

- 工具调用 step 没有自己的首字时间，却复用了整轮 TTFT，导致纯解码时长被压到 1ms，
  `decodeTps` / `avgTps` / `peakTps` 出现几万甚至几十万的异常值。
- 所有对外速度（`liveTps`、`decodeTps`、`e2eTps`、`avgTps`、`peakTps`、sparkline）
  统一 clamp 到 0–2000 tok/s。

### Changed

- 只有时长 ≥ 500ms 的 step 参与测速；更短的 step 仍然计入 `OUT`，但不再产生速率。
- 纯解码时长（step 时长 − TTFT）下限为 250ms；实时估算窗口下限为 1000ms。

## [1.1.0]

### Added

- `decodeTps`：真实解码速度（usage tokens / 纯解码时长）。
- `e2eTps`：端到端吞吐（含排队、prefill、TTFT 和工具间隔）。
- `sparkSource`：sparkline 每点标记来源（`0` 估算 / `1` usage 回填），配合
  `sparkMaxUsage`、`sparkMaxEstimated` 对比估算偏差。
- 链路诊断字段：`gapP50Ms`、`gapP95Ms`、`gapMaxMs`、`burstRatio`、`stallCount`、
  `streamHealth`（`smooth` / `bursty` / `stalled`）。
- `tps` 工具输出追加 `decode=`、`e2e=`、`link=`，原有字段顺序不变。
- `state.json` 升级到 `schema: 2`，新增字段全部为追加，旧版 `overlay.py` 仍可读取。

### Changed

- 悬浮窗主数字优先显示 `decodeTps`（标记 `DECODE` / `解码`），没有真实 usage 时退回 `liveTps`（`TPS`）。
- `state.json` 改为异步原子写：内容未变化时跳过，空闲时每秒一次心跳，避免悬浮窗误判离线。
- 每个 delta 只做内存计数与滑动裁剪，不产生同步磁盘 IO。

### Fixed

- `avgTps` 不再把工具调用 step 当成高速解码。

## [1.0.0]

### Added

- OpenCode V2 插件 + Python tkinter 悬浮窗的初始版本。
- 实时 TPS、平均 TPS、峰值 TPS、TTFT、输出 token 数。
- 60 秒 sparkline、CJK / 非 CJK 字符比例在线校准。
- 中英双语界面、紧凑模式、透明度、位置保存、始终置顶。
- `install.ps1` 安装脚本（启动器、开始菜单 / 开机启动快捷方式）。
- `test-metrics.mjs` 合成事件指标测试。

[1.1.1]: https://github.com/GarrulousSparrow/opencode-tps-overlay/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/GarrulousSparrow/opencode-tps-overlay/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/GarrulousSparrow/opencode-tps-overlay/releases/tag/v1.0.0
