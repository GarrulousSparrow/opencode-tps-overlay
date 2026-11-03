#!/usr/bin/env python3
"""Always-on-top Windows overlay for OpenCode V2 TPS metrics.

This file only uses the Python standard library. The OpenCode plugin writes
state.json; this window polls it and renders TPS, AVG, PEAK, TTFT, output token
count and a 60 second sparkline. UI strings live in locales/ and default to
Simplified Chinese.
"""

from __future__ import annotations

import ctypes
import json
import math
import os
import sys
import time
import traceback
import tkinter as tk
import tkinter.font as tkfont

APP_ID = "com.local.opencode-tps-overlay"
MUTEX_NAME = "Local\\OpenCodeTpsOverlay"
STATE_SCHEMA = 2

BG = "#0b1016"
PANEL = "#0f1720"
BORDER = "#223042"
GRID = "#17232f"
TEXT = "#e6edf3"
MUTED = "#7d8b9d"
DIM = "#4d5b6b"
GREEN = "#39d98a"
GREEN_DARK = "#1c6b4b"
GREEN_EST = "#2b8a64"
GREEN_FILL = "#123528"
YELLOW = "#ffcc66"
RED = "#ff6b6b"
BLUE = "#69b7ff"
GRAY = "#5c6b7c"

WIDTH_NORMAL = 360
HEIGHT_NORMAL = 286
WIDTH_COMPACT = 360
HEIGHT_COMPACT = 142


def _env_data_dir() -> str:
    override = os.environ.get("TPS_OVERLAY_DATA_DIR")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return os.path.join(local, "opencode-tps-overlay")
    return os.path.join(os.path.expanduser("~"), "AppData", "Local", "opencode-tps-overlay")


DATA_DIR = _env_data_dir()
STATE_FILE = os.path.join(DATA_DIR, "state.json")
WINDOW_FILE = os.path.join(DATA_DIR, "window.json")
PID_FILE = os.path.join(DATA_DIR, "overlay.pid")
LOG_FILE = os.path.join(DATA_DIR, "overlay.log")

POLL_MS = 200
try:
    POLL_MS = max(100, min(2000, int(os.environ.get("TPS_OVERLAY_POLL_MS", "200"))))
except ValueError:
    POLL_MS = 200

LOCALES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "locales")
DEFAULT_LANG = "zh-CN"
SUPPORTED_LANGS = ("zh-CN", "en")

# Built-in fallback so the overlay still works if the locales folder is missing.
# The JSON files in locales/ are the source of truth and are easy to translate.
FALLBACK_STRINGS = {
    "zh-CN": {
        "window_title": "OpenCode TPS 悬浮窗",
        "brand": "OpenCode TPS",
        "status_waiting": "等待中",
        "status_busy": "运行中",
        "status_busy_many": "运行中 ×{count}",
        "status_idle": "空闲",
        "status_retry": "重试中",
        "status_offline": "离线",
        "mode_tps": "TPS",
        "mode_decode": "解码",
        "mode_last": "上次",
        "mode_retry": "重试",
        "mode_offline": "离线",
        "metric_avg": "平均",
        "metric_peak": "峰值",
        "metric_ttft": "首字延迟",
        "metric_out": "输出",
        "footer_default": "拖动 · 双击切换紧凑 · 右键菜单",
        "footer_busy_many": "{count} 个会话运行中 · 右键菜单",
        "footer_idle": "上次完成 · 拖动 · 右键菜单",
        "meta_waiting": "等待插件",
        "meta_offline": "插件离线",
        "meta_retrying": "重试中",
        "meta_tokens": "{count} tok",
        "meta_live": "实时 {tps}",
        "health_smooth": "平滑",
        "health_bursty": "突发",
        "health_stalled": "卡顿",
        "footer_link": "{health} · p95 {p95}ms · 停顿 {stalls}",
        "menu_compact": "紧凑模式",
        "menu_normal": "普通模式",
        "menu_opacity": "透明度",
        "menu_language": "语言",
        "menu_lang_zh": "中文",
        "menu_lang_en": "English",
        "menu_reset": "重置位置",
        "menu_reload": "刷新状态",
        "menu_close": "关闭悬浮窗",
    },
    "en": {
        "window_title": "OpenCode TPS Overlay",
        "brand": "OpenCode TPS",
        "status_waiting": "WAITING",
        "status_busy": "BUSY",
        "status_busy_many": "BUSY x{count}",
        "status_idle": "IDLE",
        "status_retry": "RETRY",
        "status_offline": "OFFLINE",
        "mode_tps": "TPS",
        "mode_decode": "DECODE",
        "mode_last": "LAST",
        "mode_retry": "RETRY",
        "mode_offline": "OFFLINE",
        "metric_avg": "AVG",
        "metric_peak": "PEAK",
        "metric_ttft": "TTFT",
        "metric_out": "OUT",
        "footer_default": "drag · double-click compact · right-click menu",
        "footer_busy_many": "{count} sessions busy · right-click for menu",
        "footer_idle": "last completed · drag · right-click menu",
        "meta_waiting": "waiting for plugin",
        "meta_offline": "plugin offline",
        "meta_retrying": "retrying",
        "meta_tokens": "{count} tok",
        "meta_live": "est {tps}",
        "health_smooth": "smooth",
        "health_bursty": "bursty",
        "health_stalled": "stalled",
        "footer_link": "{health} · p95 {p95}ms · stalls {stalls}",
        "menu_compact": "Compact mode",
        "menu_normal": "Normal mode",
        "menu_opacity": "Opacity",
        "menu_language": "Language",
        "menu_lang_zh": "中文",
        "menu_lang_en": "English",
        "menu_reset": "Reset position",
        "menu_reload": "Reload state",
        "menu_close": "Close overlay",
    },
}


def normalize_lang(value) -> str:
    """Map common language names/codes to a supported locale."""
    if not value:
        return ""
    text = str(value).strip().lower().replace("_", "-")
    if text.startswith("zh") or text in ("cn", "chinese"):
        return "zh-CN"
    if text.startswith("en") or text == "english":
        return "en"
    return ""


def resolve_language(saved=None) -> str:
    """Priority: TPS_OVERLAY_LANG, saved window setting, then Chinese."""
    return (
        normalize_lang(os.environ.get("TPS_OVERLAY_LANG"))
        or normalize_lang(saved)
        or DEFAULT_LANG
    )


def load_strings(lang: str) -> dict:
    strings = dict(FALLBACK_STRINGS.get(lang) or FALLBACK_STRINGS[DEFAULT_LANG])
    try:
        data = read_json(os.path.join(LOCALES_DIR, f"{lang}.json"))
    except (OSError, ValueError, TypeError):
        data = None
    if isinstance(data, dict):
        strings.update(
            {
                key: value
                for key, value in data.items()
                if isinstance(key, str) and isinstance(value, str)
            }
        )
    return strings


_LAST_LOG_ERROR = 0.0
_MUTEX_HANDLE = None


def ensure_dir() -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except OSError:
        pass


def log(message: str) -> None:
    ensure_dir()
    try:
        if os.path.getsize(LOG_FILE) > 512 * 1024:
            try:
                os.replace(LOG_FILE, LOG_FILE + ".1")
            except OSError:
                pass
    except OSError:
        pass
    try:
        line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{os.getpid()}] {message}\n"
        with open(LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError:
        pass


def log_error(message: str) -> None:
    global _LAST_LOG_ERROR
    now = time.time()
    if now - _LAST_LOG_ERROR < 5:
        return
    _LAST_LOG_ERROR = now
    log(message)
    log(traceback.format_exc().rstrip())


def write_json_atomic(path: str, value) -> None:
    ensure_dir()
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        log_error(f"failed to write {path}")


def read_json(path: str):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def virtual_screen():
    """Return the virtual desktop rectangle on Windows, or the primary screen."""
    if os.name == "nt":
        try:
            user32 = ctypes.windll.user32
            x = int(user32.GetSystemMetrics(76))  # SM_XVIRTUALSCREEN
            y = int(user32.GetSystemMetrics(77))  # SM_YVIRTUALSCREEN
            w = int(user32.GetSystemMetrics(78))  # SM_CXVIRTUALSCREEN
            h = int(user32.GetSystemMetrics(79))  # SM_CYVIRTUALSCREEN
            if w > 0 and h > 0:
                return x, y, w, h
        except Exception:
            pass
    return 0, 0, 1920, 1080


def enable_dpi_awareness() -> None:
    if os.name != "nt":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def acquire_mutex():
    """Create a named mutex so only one overlay process can run."""
    global _MUTEX_HANDLE
    if os.name != "nt":
        return True
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        handle = kernel32.CreateMutexW(None, 0, MUTEX_NAME)
        if not handle:
            return True
        error = ctypes.get_last_error()
        if error == 183:  # ERROR_ALREADY_EXISTS
            try:
                kernel32.CloseHandle(ctypes.c_void_p(handle))
            except Exception:
                pass
            return False
        _MUTEX_HANDLE = handle
        return True
    except Exception:
        return True


def release_mutex() -> None:
    global _MUTEX_HANDLE
    if os.name == "nt" and _MUTEX_HANDLE:
        try:
            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(_MUTEX_HANDLE))
        except Exception:
            pass
        _MUTEX_HANDLE = None


def set_windows_style(root: tk.Tk) -> None:
    """Hide from the taskbar and ask Windows 11 for rounded corners."""
    if os.name != "nt":
        return
    try:
        root.update_idletasks()
        user32 = ctypes.windll.user32
        hwnd = 0
        try:
            hwnd = int(root.wm_frame(), 16)
        except Exception:
            hwnd = int(root.winfo_id())
        if not hwnd:
            return

        GWL_EXSTYLE = -20
        WS_EX_TOOLWINDOW = 0x00000080
        WS_EX_APPWINDOW = 0x00040000
        get_style = user32.GetWindowLongW
        set_style = user32.SetWindowLongW
        style = int(get_style(hwnd, GWL_EXSTYLE))
        style = (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
        set_style(hwnd, GWL_EXSTYLE, style)

        # DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2
        try:
            preference = ctypes.c_int(2)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd, 33, ctypes.byref(preference), ctypes.sizeof(preference)
            )
        except Exception:
            pass
        # DWMWA_USE_IMMERSIVE_DARK_MODE = 20
        try:
            dark = ctypes.c_int(1)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd, 20, ctypes.byref(dark), ctypes.sizeof(dark)
            )
        except Exception:
            pass
    except Exception:
        pass


def load_window_config() -> dict:
    defaults = {
        "x": None,
        "y": None,
        "alpha": 0.92,
        "compact": False,
        "lang": None,
    }
    try:
        data = read_json(WINDOW_FILE)
        if isinstance(data, dict):
            for key in defaults:
                if key in data:
                    defaults[key] = data[key]
    except (OSError, ValueError, TypeError):
        pass
    try:
        defaults["alpha"] = clamp(float(defaults["alpha"]), 0.28, 1.0)
    except (TypeError, ValueError):
        defaults["alpha"] = 0.92
    if os.environ.get("TPS_OVERLAY_ALPHA"):
        try:
            defaults["alpha"] = clamp(float(os.environ["TPS_OVERLAY_ALPHA"]), 0.28, 1.0)
        except ValueError:
            pass
    defaults["compact"] = bool(defaults.get("compact"))
    return defaults


class OverlayApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.window = load_window_config()
        self.alpha = float(self.window["alpha"])
        self.compact = bool(self.window["compact"])
        self.state = None
        self.state_key = None
        self.display_tps = 0.0
        self.last_spark_signature = None
        self.last_dot_color = None
        self.drag_offset = None
        self.closing = False
        self.menu = None
        self.lang = resolve_language(self.window.get("lang"))
        self.strings = load_strings(self.lang)
        self.lang_var = tk.StringVar(master=self.root, value=self.lang)

        self.root.overrideredirect(True)
        self.root.title(self.t("window_title"))
        self.root.configure(bg=BG)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", self.alpha)
        try:
            self.root.wm_attributes("-toolwindow", True)
        except tk.TclError:
            pass

        self._choose_fonts()
        self._build_ui()
        self._bind_tree(self.root)
        self._apply_compact(initial=True)
        self._write_pid()
        self.root.after(60, lambda: set_windows_style(self.root))
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        self.root.after(POLL_MS, self._tick)
        log(f"overlay started ({self.lang})")

    def t(self, key: str, **kwargs) -> str:
        text = self.strings.get(key, key)
        if kwargs:
            try:
                return text.format(**kwargs)
            except (KeyError, ValueError):
                return text
        return text

    def _choose_fonts(self) -> None:
        families = set(tkfont.families(self.root))

        def pick(candidates):
            for name in candidates:
                if name in families:
                    return name
            return "TkDefaultFont"

        if self.lang == "zh-CN":
            ui_candidates = [
                "Microsoft YaHei UI",
                "Microsoft YaHei",
                "Segoe UI Variable Text",
                "Segoe UI",
                "Arial",
            ]
        else:
            ui_candidates = [
                "Segoe UI Variable Text",
                "Segoe UI",
                "Microsoft YaHei UI",
                "Arial",
            ]
        self.font_ui = pick(ui_candidates)
        self.font_display = pick(
            ["Segoe UI Variable Display", "Segoe UI Semibold", "Segoe UI", "Arial"]
        )
        self.font_mono = pick(["Cascadia Mono", "Consolas", "Courier New"])
        self.title_font = tkfont.Font(
            root=self.root, family=self.font_ui, size=9, weight="bold"
        )
        self.model_font = tkfont.Font(
            root=self.root, family=self.font_mono, size=7
        )

    def _build_ui(self) -> None:
        shell = tk.Frame(self.root, bg=BG, highlightbackground=BORDER, highlightthickness=1)
        shell.pack(fill="both", expand=True)
        panel = tk.Frame(shell, bg=BG)
        panel.pack(fill="both", expand=True)
        self.panel = panel

        header = tk.Frame(panel, bg=BG)
        header.pack(fill="x", padx=12, pady=(9, 0))
        self.header = header

        self.dot = tk.Canvas(
            header, width=14, height=14, bg=BG, highlightthickness=0, bd=0
        )
        self.dot.pack(side="left", pady=(2, 0))

        self.title_label = tk.Label(
            header,
            text=self.t("brand"),
            bg=BG,
            fg=TEXT,
            font=self.title_font,
            anchor="w",
        )

        self.status_label = tk.Label(
            header,
            text=self.t("status_waiting"),
            bg=BG,
            fg=GRAY,
            font=(self.font_mono, 7, "bold"),
            anchor="e",
        )
        # Pack the status first so a long session title cannot push it out of
        # the window. The title then takes the remaining width and is clipped
        # by its own label instead of overlapping the status text.
        self.status_label.pack(side="right")
        self.title_label.pack(side="left", fill="x", expand=True, padx=(7, 4))

        subheader = tk.Frame(panel, bg=BG)
        subheader.pack(fill="x", padx=12, pady=(1, 0))
        self.subheader = subheader

        self.model_label = tk.Label(
            subheader,
            text="—",
            bg=BG,
            fg=MUTED,
            font=self.model_font,
            anchor="w",
        )

        self.meta_label = tk.Label(
            subheader,
            text="",
            bg=BG,
            fg=DIM,
            font=(self.font_mono, 7),
            anchor="e",
        )
        # Keep the compact-mode token count visible even when the model name
        # is long; the model label is clipped to the remaining width.
        self.meta_label.pack(side="right")
        self.model_label.pack(side="left", fill="x", expand=True)

        big = tk.Frame(panel, bg=BG)
        big.pack(fill="x", padx=12, pady=(2, 0))
        self.big_frame = big

        self.tps_label = tk.Label(
            big,
            text="--",
            bg=BG,
            fg=MUTED,
            font=(self.font_display, 30, "bold"),
            anchor="w",
        )
        self.tps_label.pack(side="left")

        mode_box = tk.Frame(big, bg=BG)
        mode_box.pack(side="left", padx=(7, 0), pady=(12, 0))
        self.mode_label = tk.Label(
            mode_box,
            text=self.t("mode_tps"),
            bg=BG,
            fg=GREEN,
            font=(self.font_mono, 8, "bold"),
            anchor="w",
        )
        self.mode_label.pack(anchor="w")
        self.elapsed_label = tk.Label(
            mode_box,
            text="",
            bg=BG,
            fg=DIM,
            font=(self.font_mono, 7),
            anchor="w",
        )
        self.elapsed_label.pack(anchor="w")

        metrics = tk.Frame(panel, bg=BG)
        self.metrics_frame = metrics
        for column in range(4):
            metrics.grid_columnconfigure(column, weight=1)
        self.values = {}
        self.caption_labels = {}
        captions = [
            ("avg", self.t("metric_avg")),
            ("peak", self.t("metric_peak")),
            ("ttft", self.t("metric_ttft")),
            ("out", self.t("metric_out")),
        ]
        for index, (key, caption) in enumerate(captions):
            cell = tk.Frame(metrics, bg=BG)
            cell.grid(row=0, column=index, sticky="ew", padx=(0, 6 if index < 3 else 0))
            value = tk.Label(
                cell,
                text="0.0" if key != "out" and key != "ttft" else "--",
                bg=BG,
                fg=TEXT,
                font=(self.font_mono, 10, "bold"),
                anchor="w",
            )
            value.pack(anchor="w")
            label = tk.Label(
                cell,
                text=caption,
                bg=BG,
                fg=MUTED,
                font=(self.font_mono, 6),
                anchor="w",
            )
            label.pack(anchor="w")
            self.caption_labels[key] = label
            self.values[key] = value

        spark_frame = tk.Frame(panel, bg=BG)
        self.spark_frame = spark_frame
        self.spark_canvas = tk.Canvas(
            spark_frame,
            height=42,
            bg=BG,
            highlightthickness=0,
            bd=0,
        )
        self.spark_canvas.pack(fill="x", expand=True)

        footer = tk.Frame(panel, bg=BG)
        self.footer = footer
        self.footer_label = tk.Label(
            footer,
            text=self.t("footer_default"),
            bg=BG,
            fg=DIM,
            font=(self.font_ui, 7),
            anchor="w",
        )
        self.footer_label.pack(fill="x")

        # Normal layout order: big, metrics, spark, footer. Pack spark before
        # metrics so the metrics frame can use pack(before=spark_frame).
        spark_frame.pack(fill="x", padx=12, pady=(1, 0))
        footer.pack(fill="x", padx=12, pady=(4, 8))
        metrics.pack(fill="x", padx=12, pady=(2, 0), before=spark_frame)

    def _bind_tree(self, widget) -> None:
        widget.bind("<ButtonPress-1>", self._on_press, add="+")
        widget.bind("<B1-Motion>", self._on_motion, add="+")
        widget.bind("<ButtonRelease-1>", self._on_release, add="+")
        widget.bind("<Double-Button-1>", self._on_double_click, add="+")
        widget.bind("<Button-3>", self._on_right_click, add="+")
        for child in widget.winfo_children():
            self._bind_tree(child)

    def _tick(self) -> None:
        if self.closing:
            return
        try:
            self.state = self._read_state()
            self._update_ui()
        except Exception:
            log_error("overlay update failed")
        self.root.after(POLL_MS, self._tick)

    def _read_state(self):
        try:
            stat = os.stat(STATE_FILE)
            key = (stat.st_mtime_ns, stat.st_size)
            if key == self.state_key:
                return self.state
            data = read_json(STATE_FILE)
            self.state_key = key
            return data if isinstance(data, dict) else None
        except FileNotFoundError:
            self.state_key = None
            return None
        except (OSError, ValueError):
            return self.state

    def _state_fresh(self) -> bool:
        if not self.state:
            return False
        try:
            updated = float(self.state.get("updatedAt") or 0)
            stale_after = float(self.state.get("staleAfterMs") or 5000)
            age = time.time() * 1000.0 - updated
            return age <= max(2000.0, stale_after)
        except (TypeError, ValueError):
            return False

    def _update_ui(self) -> None:
        state = self.state
        fresh = self._state_fresh()
        status_raw = state.get("status") if state else "waiting"
        if state and not fresh:
            status = "offline"
        elif not state:
            status = "waiting"
        else:
            status = str(status_raw or "waiting")

        session = (state or {}).get("session") or {}
        last_completed = (state or {}).get("lastCompleted") or {}
        busy_count = int((state or {}).get("busyCount") or 0)

        target, primary_is_decode = self._primary_tps(session, status)
        if status == "waiting":
            target = 0.0
        self.display_tps += (target - self.display_tps) * 0.35
        if abs(target - self.display_tps) < 0.05:
            self.display_tps = target

        if not state:
            tps_text = "--"
        else:
            tps_text = f"{self.display_tps:,.1f}"

        if status == "busy":
            mode = self.t("mode_decode") if primary_is_decode else self.t("mode_tps")
            color = GREEN
        elif status == "retry":
            mode = self.t("mode_retry")
            color = YELLOW
        elif status == "idle":
            if last_completed or session.get("lastCompletedAt"):
                mode = self.t("mode_last")
            else:
                mode = self.t("mode_tps")
            color = BLUE if last_completed else MUTED
        elif status == "offline":
            mode = self.t("mode_offline")
            color = RED
        else:
            mode = self.t("mode_tps")
            color = MUTED

        self.tps_label.configure(text=tps_text, fg=color)
        self.mode_label.configure(text=mode, fg=color)
        self.status_label.configure(
            text=self._status_text(status, busy_count),
            fg=self._status_color(status),
        )
        self._draw_dot(status)

        title = str(session.get("title") or "").strip()
        if not title:
            title = self.t("brand")
        self.title_label.configure(text=self._fit_title(title))

        model = str(session.get("model") or "").strip()
        self.model_label.configure(
            text=self._fit_model(model) if model else "—"
        )

        elapsed_ms = session.get("elapsedMs")
        if status == "busy" and elapsed_ms:
            self.elapsed_label.configure(text=self._format_duration(float(elapsed_ms)))
        elif status == "idle" and elapsed_ms:
            self.elapsed_label.configure(text=self._format_duration(float(elapsed_ms)))
        else:
            self.elapsed_label.configure(text="")

        self.meta_label.configure(text=self._meta_text(state, session, status))
        self._set_metric("avg", self._format_tps(session.get("avgTps")))
        self._set_metric("peak", self._format_tps(session.get("peakTps")))
        self._set_metric("ttft", self._format_ttft(session.get("ttftMs")))
        self._set_metric("out", self._format_int(session.get("outputTokens")))

        spark = (state or {}).get("spark") or []
        spark_sources = (state or {}).get("sparkSource") or []
        self._draw_spark(spark, status, spark_sources)

        health = str(session.get("streamHealth") or "")
        if health in ("smooth", "bursty", "stalled") and status == "busy":
            try:
                p95 = int(float(session.get("gapP95Ms") or 0))
                stalls = int(float(session.get("stallCount") or 0))
            except (TypeError, ValueError):
                p95, stalls = 0, 0
            footer = self.t(
                "footer_link",
                health=self.t(f"health_{health}"),
                p95=p95,
                stalls=stalls,
            )
        elif status in ("retry", "offline") and session.get("error"):
            footer = self._truncate(str(session.get("error")), 52)
        elif busy_count > 1:
            footer = self.t("footer_busy_many", count=busy_count)
        elif status == "idle":
            footer = self.t("footer_idle")
        else:
            footer = self.t("footer_default")
        self.footer_label.configure(text=footer)

    @staticmethod
    def _primary_tps(session, status: str):
        """Prefer real decode TPS; fall back to the live estimate.

        Older plugins (schema 1) only write ``tps``, so a missing or invalid
        ``decodeTps`` must keep the previous behaviour.
        """
        try:
            live = float(session.get("tps") or 0.0)
        except (TypeError, ValueError):
            live = 0.0
        raw = session.get("decodeTps")
        if raw is None:
            return live, False
        try:
            decode = float(raw)
        except (TypeError, ValueError):
            return live, False
        if decode > 0:
            return decode, True
        return live, False

    def _status_text(self, status: str, busy_count: int) -> str:
        if status == "busy":
            if busy_count <= 1:
                return self.t("status_busy")
            return self.t("status_busy_many", count=busy_count)
        if status == "idle":
            return self.t("status_idle")
        if status == "retry":
            return self.t("status_retry")
        if status == "offline":
            return self.t("status_offline")
        return self.t("status_waiting")

    @staticmethod
    def _status_color(status: str) -> str:
        if status == "busy":
            return GREEN
        if status == "idle":
            return BLUE
        if status == "retry":
            return YELLOW
        if status == "offline":
            return RED
        return GRAY

    def _draw_dot(self, status: str) -> None:
        color = self._status_color(status)
        if status == "busy":
            phase = (time.time() * 1.8) % 1.0
            size = 3.0 + 2.2 * (0.5 + 0.5 * math.sin(phase * math.pi * 2.0))
            if size > 4.6:
                color = GREEN
            else:
                color = GREEN_DARK
        else:
            size = 4.0
        signature = (color, round(size, 1))
        if signature == self.last_dot_color:
            return
        self.last_dot_color = signature
        self.dot.delete("all")
        center = 7.0
        self.dot.create_oval(
            center - size,
            center - size,
            center + size,
            center + size,
            fill=color,
            outline="",
        )

    def _set_metric(self, key: str, text: str) -> None:
        label = self.values.get(key)
        if label is not None and label.cget("text") != text:
            label.configure(text=text)

    @staticmethod
    def _format_tps(value) -> str:
        try:
            return f"{float(value):,.1f}"
        except (TypeError, ValueError):
            return "0.0"

    @staticmethod
    def _format_int(value) -> str:
        try:
            return f"{int(float(value)):,}"
        except (TypeError, ValueError):
            return "0"

    @staticmethod
    def _format_ttft(value) -> str:
        if value is None:
            return "--"
        try:
            ms = float(value)
        except (TypeError, ValueError):
            return "--"
        if ms >= 1000:
            return f"{ms / 1000.0:.2f}s"
        return f"{int(ms)}ms"

    @staticmethod
    def _format_duration(ms: float) -> str:
        seconds = max(0.0, ms / 1000.0)
        if seconds >= 60:
            return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"
        return f"{seconds:.1f}s"

    @staticmethod
    def _truncate(text: str, limit: int) -> str:
        text = " ".join(text.split())
        if len(text) <= limit:
            return text
        return text[: max(0, limit - 1)].rstrip() + "…"

    def _fit_title(self, text: str) -> str:
        """Ellipsize the header title to the width left over by the status."""
        try:
            width = self.title_label.winfo_width()
            if width <= 1:
                return self._truncate(text, 29)
            return self._ellipsize(text, self.title_font, max(12, width - 2))
        except Exception:
            return self._truncate(text, 29)

    def _fit_model(self, text: str) -> str:
        """Ellipsize the model caption to the width left over by the meta text."""
        try:
            width = self.model_label.winfo_width()
            if width <= 1:
                return self._truncate(text, 46)
            return self._ellipsize(text, self.model_font, max(10, width - 2))
        except Exception:
            return self._truncate(text, 46)

    @staticmethod
    def _ellipsize(text: str, font, width: int) -> str:
        text = " ".join(text.split())
        if font.measure(text) <= width:
            return text
        ellipsis = "…"
        low, high = 0, len(text)
        while low < high:
            mid = (low + high + 1) // 2
            candidate = text[:mid].rstrip() + ellipsis
            if font.measure(candidate) <= width:
                low = mid
            else:
                high = mid - 1
        return text[:low].rstrip() + ellipsis

    def _meta_text(self, state, session, status: str) -> str:
        if not state:
            return self.t("meta_waiting")
        if status == "offline":
            return self.t("meta_offline")
        if status == "retry":
            return self.t("meta_retrying")
        if self.compact:
            output = session.get("outputTokens")
            if output:
                return self.t("meta_tokens", count=f"{int(float(output)):,}")
            return ""
        if status == "busy":
            live = session.get("liveTps")
            if live is None:
                live = session.get("tps")
            try:
                live_value = float(live)
            except (TypeError, ValueError):
                live_value = 0.0
            if live_value > 0:
                return self.t("meta_live", tps=f"{live_value:,.1f}")
        return ""

    def _draw_spark(self, spark, status: str, spark_sources=None) -> None:
        values = []
        try:
            values = [max(0.0, float(v)) for v in spark][-60:]
        except (TypeError, ValueError):
            values = []
        while len(values) < 60:
            values.insert(0, 0.0)

        sources = []
        try:
            sources = [1 if int(v) == 1 else 0 for v in (spark_sources or [])][-60:]
        except (TypeError, ValueError):
            sources = []
        has_sources = len(sources) > 0
        while len(sources) < 60:
            sources.insert(0, 0)

        width = max(40, self.spark_canvas.winfo_width())
        height = max(20, self.spark_canvas.winfo_height())
        line_color = GREEN if status != "offline" else RED
        fill_color = GREEN_FILL if status != "offline" else "#3a1d22"
        signature = (
            tuple(round(v, 1) for v in values),
            tuple(sources) if has_sources else None,
            width,
            height,
            line_color,
        )
        if signature == self.last_spark_signature:
            return
        self.last_spark_signature = signature

        canvas = self.spark_canvas
        canvas.delete("all")
        left = 1.0
        right = width - 1.0
        top = 3.0
        bottom = height - 3.0
        for fraction in (0.25, 0.5, 0.75):
            y = top + (bottom - top) * fraction
            canvas.create_line(left, y, right, y, fill=GRID, width=1)

        peak = max(values) if values else 0.0
        scale = max(5.0, peak * 1.08)
        points = []
        for index, value in enumerate(values):
            x = left + (right - left) * index / max(1, len(values) - 1)
            y = bottom - (bottom - top) * min(1.0, value / scale)
            points.extend([x, y])

        if len(points) >= 4:
            polygon = [left, bottom] + points + [right, bottom]
            canvas.create_polygon(polygon, fill=fill_color, outline="")
            if not has_sources:
                # Schema 1 state has no source markers; keep the old look.
                canvas.create_line(
                    points,
                    fill=line_color,
                    width=2,
                    smooth=True,
                    splinesteps=12,
                )
            else:
                # Bright segments are backed by real usage tokens; dimmer
                # segments are character-based estimates.
                for index in range(1, len(values)):
                    color = line_color
                    if status != "offline":
                        color = GREEN if sources[index] == 1 else GREEN_EST
                    canvas.create_line(
                        points[(index - 1) * 2],
                        points[(index - 1) * 2 + 1],
                        points[index * 2],
                        points[index * 2 + 1],
                        fill=color,
                        width=2,
                    )
            if status == "busy":
                dot_color = line_color
                if has_sources and status != "offline":
                    dot_color = GREEN if sources[-1] == 1 else GREEN_EST
                canvas.create_oval(
                    points[-2] - 2.4,
                    points[-1] - 2.4,
                    points[-2] + 2.4,
                    points[-1] + 2.4,
                    fill=dot_color,
                    outline="",
                )
        canvas.create_line(left, bottom, right, bottom, fill=BORDER, width=1)

    def _on_press(self, event) -> None:
        self.drag_offset = (
            event.x_root - self.root.winfo_x(),
            event.y_root - self.root.winfo_y(),
        )

    def _on_motion(self, event) -> None:
        if not self.drag_offset:
            return
        x = event.x_root - self.drag_offset[0]
        y = event.y_root - self.drag_offset[1]
        self.root.geometry(f"+{int(x)}+{int(y)}")

    def _on_release(self, _event) -> None:
        if self.drag_offset:
            self.drag_offset = None
            self._save_window()

    def _on_double_click(self, _event) -> None:
        self._toggle_compact()

    def _on_right_click(self, event) -> None:
        if self.menu is not None:
            try:
                self.menu.destroy()
            except tk.TclError:
                pass
        menu = tk.Menu(
            self.root,
            tearoff=0,
            bg=PANEL,
            fg=TEXT,
            activebackground=BORDER,
            activeforeground=TEXT,
            bd=0,
        )
        menu.add_command(
            label=self.t("menu_compact") if not self.compact else self.t("menu_normal"),
            command=self._toggle_compact,
        )
        opacity = tk.Menu(
            self.root,
            tearoff=0,
            bg=PANEL,
            fg=TEXT,
            activebackground=BORDER,
            activeforeground=TEXT,
            bd=0,
        )
        for label, alpha in (
            ("100%", 1.0),
            ("92%", 0.92),
            ("80%", 0.80),
            ("65%", 0.65),
            ("45%", 0.45),
        ):
            opacity.add_command(
                label=label,
                command=lambda value=alpha: self._set_alpha(value),
            )
        menu.add_cascade(label=self.t("menu_opacity"), menu=opacity)
        language = tk.Menu(
            self.root,
            tearoff=0,
            bg=PANEL,
            fg=TEXT,
            activebackground=BORDER,
            activeforeground=TEXT,
            bd=0,
        )
        for code, key in (("zh-CN", "menu_lang_zh"), ("en", "menu_lang_en")):
            language.add_radiobutton(
                label=self.t(key),
                variable=self.lang_var,
                value=code,
                command=lambda value=code: self._set_language(value),
            )
        menu.add_cascade(label=self.t("menu_language"), menu=language)
        menu.add_command(label=self.t("menu_reset"), command=self._reset_position)
        menu.add_command(label=self.t("menu_reload"), command=self._reload_state)
        menu.add_separator()
        menu.add_command(label=self.t("menu_close"), command=self.close)
        self.menu = menu
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def _apply_static_text(self) -> None:
        self.root.title(self.t("window_title"))
        self.title_label.configure(text=self.t("brand"))
        for key, label in self.caption_labels.items():
            label.configure(text=self.t(f"metric_{key}"))
        self.footer_label.configure(text=self.t("footer_default"))

    def _set_language(self, lang: str) -> None:
        lang = normalize_lang(lang) or DEFAULT_LANG
        if lang == self.lang:
            return
        self.lang = lang
        self.lang_var.set(lang)
        self.strings = load_strings(lang)
        self._apply_static_text()
        self._save_window()
        self._update_ui()
        log(f"language changed ({lang})")

    def _toggle_compact(self) -> None:
        self.compact = not self.compact
        self._apply_compact()
        self._save_window()

    def _apply_compact(self, initial: bool = False) -> None:
        x = self.root.winfo_x()
        y = self.root.winfo_y()
        if self.compact:
            self.metrics_frame.pack_forget()
            self.footer.pack_forget()
            self.spark_canvas.configure(height=30)
            width = WIDTH_COMPACT
            min_height = HEIGHT_COMPACT
        else:
            if not self.metrics_frame.winfo_ismapped():
                self.metrics_frame.pack(
                    fill="x", padx=12, pady=(2, 0), before=self.spark_frame
                )
            if not self.footer.winfo_ismapped():
                self.footer.pack(fill="x", padx=12, pady=(4, 8))
            self.spark_canvas.configure(height=42)
            width = WIDTH_NORMAL
            min_height = HEIGHT_NORMAL
        # Size the window from the content that was actually laid out. Font
        # metrics grow with the display DPI, so a hard-coded height clips the
        # sparkline and footer on scaled displays.
        self.root.update_idletasks()
        height = max(min_height, self.panel.winfo_reqheight() + 2)
        if initial or (x <= 0 and y <= 0):
            x, y = self._initial_position(width, height)
        else:
            x, y = self._clamp_position(x, y, width, height)
        self.root.geometry(f"{width}x{height}+{int(x)}+{int(y)}")
        self.last_spark_signature = None
        self.root.update_idletasks()

    def _initial_position(self, width=None, height=None):
        if width is None:
            width = WIDTH_COMPACT if self.compact else WIDTH_NORMAL
        if height is None:
            height = HEIGHT_COMPACT if self.compact else HEIGHT_NORMAL
        vx, vy, vw, vh = virtual_screen()
        try:
            x = int(self.window.get("x"))
            y = int(self.window.get("y"))
        except (TypeError, ValueError):
            x = vx + vw - width - 28
            y = vy + vh - height - 80
        return self._clamp_position(x, y, width, height)

    @staticmethod
    def _clamp_position(x, y, width, height):
        vx, vy, vw, vh = virtual_screen()
        x = int(clamp(x, vx + 8, max(vx + 8, vx + vw - width - 8)))
        y = int(clamp(y, vy + 8, max(vy + 8, vy + vh - height - 8)))
        return x, y

    def _reset_position(self) -> None:
        self.window["x"] = None
        self.window["y"] = None
        x, y = self._initial_position(
            self.root.winfo_width(), self.root.winfo_height()
        )
        self.root.geometry(f"+{x}+{y}")
        self._save_window()

    def _set_alpha(self, value: float) -> None:
        self.alpha = clamp(float(value), 0.28, 1.0)
        self.root.attributes("-alpha", self.alpha)
        self._save_window()

    def _reload_state(self) -> None:
        self.state_key = None
        self.state = self._read_state()
        self._update_ui()

    def _save_window(self) -> None:
        try:
            data = {
                "x": int(self.root.winfo_x()),
                "y": int(self.root.winfo_y()),
                "alpha": round(float(self.alpha), 3),
                "compact": bool(self.compact),
                "lang": self.lang,
            }
            write_json_atomic(WINDOW_FILE, data)
            self.window.update(data)
        except Exception:
            log_error("failed to save window config")

    def _write_pid(self) -> None:
        write_json_atomic(
            PID_FILE,
            {"pid": os.getpid(), "startedAt": int(time.time() * 1000)},
        )

    def close(self) -> None:
        if self.closing:
            return
        self.closing = True
        try:
            self._save_window()
        except Exception:
            pass
        try:
            pid = None
            try:
                data = read_json(PID_FILE)
                pid = int(data.get("pid"))
            except (OSError, ValueError, TypeError, AttributeError):
                pid = None
            if pid == os.getpid():
                os.unlink(PID_FILE)
        except OSError:
            pass
        log("overlay closed")
        release_mutex()
        try:
            self.root.destroy()
        except tk.TclError:
            pass


def main() -> int:
    ensure_dir()
    if not acquire_mutex():
        log("another overlay instance is already running; exiting")
        return 0
    enable_dpi_awareness()
    try:
        root = tk.Tk()
    except tk.TclError:
        log_error("tkinter could not create a window")
        release_mutex()
        return 1
    try:
        OverlayApp(root)
        root.mainloop()
    except Exception:
        log_error("overlay crashed")
        release_mutex()
        return 1
    release_mutex()
    return 0


if __name__ == "__main__":
    sys.exit(main())
