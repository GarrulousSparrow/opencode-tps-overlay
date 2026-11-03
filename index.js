import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "local.tps-overlay";
const VERSION = "1.1.1";
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.TPS_OVERLAY_DATA_DIR
  ? path.resolve(process.env.TPS_OVERLAY_DATA_DIR)
  : path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "opencode-tps-overlay",
    );
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PID_FILE = path.join(DATA_DIR, "overlay.pid");
const PLUGIN_LOG = path.join(DATA_DIR, "plugin.log");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const OVERLAY_SCRIPT = path.join(PLUGIN_DIR, "overlay.py");
const DEBUG = process.env.TPS_OVERLAY_DEBUG === "1";
const AUTOSTART = process.env.TPS_OVERLAY_AUTOSTART !== "0";
const ENGINE_KEY = Symbol.for("opencode.tps-overlay.engine");
const STATE_SCHEMA = 2;
const TICK_MS = 300;
const LIVE_WINDOW_MS = 5000;
const OFFLINE_MS = 5000;
const STATE_HEARTBEAT_MS = 1000;
const LINK_WINDOW = 200;
const LINK_BURST_GAP_MS = 30;
const LINK_STALL_GAP_MS = 500;
const DEFAULT_CJK_RATIO = 0.65;
const DEFAULT_NON_CJK_RATIO = 0.3;
const CJK_RATIO_MIN = 0.4;
const CJK_RATIO_MAX = 1.0;
const NON_CJK_RATIO_MIN = 0.1;
const NON_CJK_RATIO_MAX = 0.6;
const CALIBRATION_MIN_STEPS = 3;
const CALIBRATION_WINDOW = 16;
const PEAK_MIN_TOKENS = 32;
const PEAK_MIN_DURATION_MS = 500;
// A step only produces a trustworthy rate when it lasted long enough to be
// timed. Shorter steps still count toward OUT, but must never become the
// displayed TPS: a 300 ms tool-call step with 120 usage tokens would report
// 400 tok/s instead of the ~8 tok/s the model actually streams.
const MEASURABLE_STEP_MS = 500;
// Even inside a measurable step, subtracting TTFT must not collapse the
// decode window to a few milliseconds.
const MIN_DECODE_MS = 250;
// The live estimate divides a burst of tokens by the time it actually covers,
// never by a shorter span, so buffered chunks cannot multiply the rate.
const MIN_LIVE_SPAN_MS = 1000;
// Hard sanity ceiling for every rate we publish (live, decode, avg, peak,
// e2e and sparkline). Real providers stay far below this.
const MAX_TPS = 2000;

let writeSeq = 0;

function nowMs() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (error) {
    // Nothing useful can be written if the directory cannot be created.
  }
}

function rotateIfLarge(file, limit) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= limit) return;
    try {
      fs.rmSync(`${file}.1`, { force: true });
    } catch {
      // ignore
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Missing file is fine.
  }
}

function log(message, extra) {
  ensureDir();
  const suffix = extra === undefined ? "" : ` ${safeJson(extra)}`;
  const line = `${new Date().toISOString()} [${PLUGIN_ID}] ${message}${suffix}\n`;
  try {
    fs.appendFileSync(PLUGIN_LOG, line, "utf8");
  } catch {
    // Logging must never break the plugin.
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function writeJsonAtomic(file, value) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
      fs.renameSync(tmp, file);
    }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    log("failed to write JSON", { file, error: String(error) });
  }
}

async function writeBufferAtomic(file, buffer, shouldAbort) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
  try {
    await fs.promises.writeFile(tmp, buffer);
    if (typeof shouldAbort === "function" && shouldAbort()) {
      await fs.promises.rm(tmp, { force: true });
      return;
    }
    try {
      await fs.promises.rename(tmp, file);
    } catch {
      try {
        await fs.promises.rm(file, { force: true });
      } catch {
        // ignore
      }
      await fs.promises.rename(tmp, file);
    }
  } catch (error) {
    try {
      await fs.promises.rm(tmp, { force: true });
    } catch {
      // ignore
    }
    log("failed to write JSON", { file, error: String(error) });
  }
}

function appendDebugEvent(event) {
  if (!DEBUG) return;
  try {
    rotateIfLarge(EVENTS_FILE, 10 * 1024 * 1024);
    fs.appendFileSync(
      EVENTS_FILE,
      `${JSON.stringify({ loggedAt: nowMs(), event })}\n`,
      "utf8",
    );
  } catch {
    // Debug logging must never break the plugin.
  }
}

function readPidFile() {
  try {
    const text = fs.readFileSync(PID_FILE, "utf8").trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      const pid = Number(parsed.pid);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      const pid = Number(text);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function overlayRunning() {
  return processAlive(readPidFile());
}

function countCjk(text) {
  const matches = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  return matches ? matches.length : 0;
}

function estimateTokens(text, ratios) {
  if (!text) return 0;
  const cjkRatio =
    ratios && Number.isFinite(ratios.cjkRatio)
      ? ratios.cjkRatio
      : DEFAULT_CJK_RATIO;
  const nonCjkRatio =
    ratios && Number.isFinite(ratios.nonCjkRatio)
      ? ratios.nonCjkRatio
      : DEFAULT_NON_CJK_RATIO;
  const cjk = countCjk(text);
  const nonCjk = Math.max(0, text.length - cjk);
  return cjk * cjkRatio + nonCjk * nonCjkRatio;
}

/**
 * Least-squares fit of `tokens = cjk * cjkRatio + nonCjk * nonCjkRatio`.
 * Returns null until there are enough step samples. Ratios are clamped so a
 * single odd step can never drive the estimator out of a sane range.
 */
function solveRatios(samples) {
  if (!Array.isArray(samples) || samples.length < CALIBRATION_MIN_STEPS) {
    return null;
  }
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  for (const sample of samples) {
    const cjk = Math.max(0, Number(sample.cjk) || 0);
    const nonCjk = Math.max(0, Number(sample.nonCjk) || 0);
    const tokens = Math.max(0, Number(sample.tokens) || 0);
    a11 += cjk * cjk;
    a12 += cjk * nonCjk;
    a22 += nonCjk * nonCjk;
    b1 += cjk * tokens;
    b2 += nonCjk * tokens;
  }
  const det = a11 * a22 - a12 * a12;
  const scale = Math.max(1, a11 * a22);
  let cjkRatio = null;
  let nonCjkRatio = null;
  if (det > 1e-9 * scale) {
    cjkRatio = (b1 * a22 - b2 * a12) / det;
    nonCjkRatio = (b2 * a11 - b1 * a12) / det;
  } else if (a11 > 0 && a22 === 0) {
    // Only CJK text was sampled; the non-CJK ratio keeps its current value.
    cjkRatio = b1 / a11;
  } else if (a22 > 0 && a11 === 0) {
    nonCjkRatio = b2 / a22;
  }
  if (cjkRatio === null && nonCjkRatio === null) return null;
  return {
    cjkRatio:
      cjkRatio === null
        ? null
        : clamp(cjkRatio, CJK_RATIO_MIN, CJK_RATIO_MAX),
    nonCjkRatio:
      nonCjkRatio === null
        ? null
        : clamp(nonCjkRatio, NON_CJK_RATIO_MIN, NON_CJK_RATIO_MAX),
  };
}

function summarizeLink(gaps) {
  const count = gaps.length;
  if (!count) {
    return {
      sampleCount: 0,
      gapP50Ms: 0,
      gapP95Ms: 0,
      gapMaxMs: 0,
      burstRatio: 0,
      stallCount: 0,
      streamHealth: "smooth",
    };
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const percentile = (fraction) => {
    const index = clamp(
      Math.ceil(fraction * count) - 1,
      0,
      count - 1,
    );
    return sorted[index];
  };
  let bursts = 0;
  let stalls = 0;
  let max = 0;
  for (const gap of gaps) {
    if (gap < LINK_BURST_GAP_MS) bursts += 1;
    if (gap > LINK_STALL_GAP_MS) stalls += 1;
    if (gap > max) max = gap;
  }
  const burstRatio = bursts / count;
  const gapP95Ms = percentile(0.95);
  let streamHealth = "smooth";
  if (burstRatio > 0.6 && stalls > 2) {
    streamHealth = "bursty";
  } else if (gapP95Ms > 800) {
    streamHealth = "stalled";
  }
  return {
    sampleCount: count,
    gapP50Ms: Math.round(percentile(0.5)),
    gapP95Ms: Math.round(gapP95Ms),
    gapMaxMs: Math.round(max),
    burstRatio: round(burstRatio, 3),
    stallCount: stalls,
    streamHealth,
  };
}

function rememberReasoning(run, text) {
  if (!text) return;
  run.reasoningTail = (run.reasoningTail + text).slice(-8192);
  if (text.length >= 8) {
    run.reasoningChunks.add(text);
    if (run.reasoningChunks.size > 512) {
      const oldest = run.reasoningChunks.values().next().value;
      run.reasoningChunks.delete(oldest);
    }
  }
}

/**
 * Some providers stream reasoning and then replay it inside text deltas.
 * Counting both would roughly double the live estimate. Only exact chunk
 * matches and full reasoning-buffer replays are dropped, so normal answer
 * text that merely shares a phrase with reasoning is kept.
 */
function dedupeAgainstReasoning(run, text) {
  if (!text || run.reasoningTail.length < 8) return text;
  if (run.reasoningChunks.has(text)) return "";
  if (text.length >= 12 && run.reasoningTail.includes(text)) return "";
  const tail = run.reasoningTail;
  if (tail.length >= 20) {
    const index = text.indexOf(tail);
    if (index >= 0 && index <= 4) {
      return text.slice(index + tail.length);
    }
  }
  return text;
}

function modelRef(model) {
  if (!model || !model.providerID || !model.id) return null;
  return `${model.providerID}/${model.id}`;
}

function modelVariant(model) {
  return model && model.variant ? String(model.variant) : null;
}

function createRun(startedAt, usageBase, observedStart, ratios) {
  return {
    startedAt,
    observedStart: observedStart === true,
    usageBase: Number.isFinite(usageBase) ? usageBase : 0,
    firstTokenAt: null,
    ttftMs: null,
    outputTokens: 0,
    timedTokens: 0,
    totalGenerationMs: 0,
    decodeMsTotal: 0,
    peakTps: 0,
    peakSource: "estimated",
    livePeak: 0,
    completedSteps: 0,
    lastStepTps: 0,
    lastStepTokens: 0,
    lastStepMs: 0,
    lastDecodeTps: 0,
    lastE2eTps: 0,
    lastStepTtftMs: 0,
    lastStepEndedAt: 0,
    stepStartedAt: null,
    stepFirstDeltaAt: null,
    stepChars: 0,
    stepCjk: 0,
    stepNonCjk: 0,
    stepEstimated: 0,
    stepUsageBacked: false,
    estimatedTokens: 0,
    chars: 0,
    cjkRatio:
      ratios && Number.isFinite(ratios.cjkRatio)
        ? ratios.cjkRatio
        : DEFAULT_CJK_RATIO,
    nonCjkRatio:
      ratios && Number.isFinite(ratios.nonCjkRatio)
        ? ratios.nonCjkRatio
        : DEFAULT_NON_CJK_RATIO,
    ratio:
      ratios && Number.isFinite(ratios.nonCjkRatio)
        ? ratios.nonCjkRatio
        : DEFAULT_NON_CJK_RATIO,
    samples: [],
    gaps: [],
    lastArrivalAt: 0,
    lastDeltaAt: 0,
    stepEndedAt: 0,
    reasoningTail: "",
    reasoningChunks: new Set(),
    finalized: false,
  };
}

class TpsEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.refs = 1;
    this.version = VERSION;
    this.stopped = false;
    this.startedAt = nowMs();
    this.sessions = new Map();
    this.modelNames = new Map();
    this.controller = null;
    this.timer = null;
    this.ready = null;
    this.spark = new Array(60).fill(0);
    this.sparkSource = new Array(60).fill(0);
    // Shadow array for estimated values. Backfilling usage overwrites a spark
    // point, but we still need to report how high the estimator went.
    this.sparkEstimated = new Array(60).fill(0);
    this.sparkSecond = Math.floor(nowMs() / 1000);
    this.lastState = null;
    this.lastStateJson = null;
    this.lastStateSignature = null;
    this.lastStateWriteAt = 0;
    this.stateBuffer = Buffer.allocUnsafe(64 * 1024);
    this.pendingStatePayload = null;
    this.pendingStateSeq = 0;
    this.latestStateSeq = 0;
    this.stateWriting = false;
    this.now = () => nowMs();
    this.lastErrorLogAt = 0;
  }

  async start() {
    ensureDir();
    rotateIfLarge(PLUGIN_LOG, 1024 * 1024);
    if (DEBUG) rotateIfLarge(EVENTS_FILE, 10 * 1024 * 1024);
    log("starting", {
      version: VERSION,
      dataDir: DATA_DIR,
      debug: DEBUG,
      autostart: AUTOSTART,
    });

    this.writeState(nowMs());
    this.loadModels();
    this.spawnOverlay();
    this.controller = new AbortController();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
    // Do not await the subscription here: subscribeLoop runs for the whole
    // plugin lifetime. Awaiting it would keep setup() pending forever and
    // delay the tps tool registration until the event stream closes.
    this.ready = this.subscribeLoop(this.controller.signal);
    this.ready.catch((error) => {
      log("subscription loop failed", { error: String(error) });
    });
    return this;
  }

  release() {
    this.refs -= 1;
    if (this.refs > 0) return;
    if (globalThis[ENGINE_KEY] === this) {
      delete globalThis[ENGINE_KEY];
    }
    this.stop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    log("stopping");
    try {
      if (this.controller) this.controller.abort();
    } catch {
      // ignore
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.writeState(this.now(), true);
  }

  async loadModels() {
    try {
      const result = await this.ctx.model.list();
      const list = Array.isArray(result)
        ? result
        : Array.isArray(result && result.data)
          ? result.data
          : Array.isArray(result && result.items)
            ? result.items
            : Array.isArray(result && result.models)
              ? result.models
              : [];
      for (const model of list) {
        const ref = modelRef(model);
        if (!ref) continue;
        this.modelNames.set(ref, model.name || model.id || ref);
      }
      for (const session of this.sessions.values()) {
        if (session.modelRef && this.modelNames.has(session.modelRef)) {
          session.model = this.modelNames.get(session.modelRef);
        }
      }
      log("model catalog loaded", { count: this.modelNames.size });
    } catch (error) {
      log("model catalog unavailable", { error: String(error) });
    }
  }

  async subscribeLoop(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const stream = this.ctx.event.subscribe({ signal });
        for await (const event of stream) {
          if (signal.aborted) break;
          try {
            this.handleEvent(event);
          } catch (error) {
            log("event handler failed", {
              type: event && event.type,
              error: String(error),
            });
          }
        }
        attempt = 0;
      } catch (error) {
        if (signal.aborted) break;
        attempt += 1;
        const wait = Math.min(5000, 500 * attempt);
        if (nowMs() - this.lastErrorLogAt > 5000) {
          this.lastErrorLogAt = nowMs();
          log("event stream error", { error: String(error), retryMs: wait });
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  tick() {
    const at = this.now();
    for (const session of this.sessions.values()) {
      session.liveTps = this.computeLive(session, at);
      if (
        session.run &&
        session.status === "busy" &&
        session.liveTps > session.run.livePeak
      ) {
        session.run.livePeak = session.liveTps;
      }
    }
    const active = this.pickActive();
    if (active && active.session.status === "busy") {
      this.pushSpark(at, active.session.liveTps || 0, 0);
    }
    this.writeState(at);
  }

  getSession(sessionID, at) {
    if (!sessionID) return null;
    let session = this.sessions.get(sessionID);
    if (!session) {
      session = {
        id: sessionID,
        title: "",
        model: "",
        modelRef: null,
        modelVariant: null,
        status: "idle",
        totalOutput: 0,
        ratio: DEFAULT_NON_CJK_RATIO,
        nonCjkRatio: DEFAULT_NON_CJK_RATIO,
        cjkRatio: DEFAULT_CJK_RATIO,
        calibration: [],
        run: null,
        lastCompleted: null,
        lastActivityAt: at,
        updatedAt: at,
        hydratedAt: 0,
        hydrating: false,
        error: null,
        liveTps: 0,
      };
      this.sessions.set(sessionID, session);
      void this.hydrate(session);
      this.trimSessions();
    }
    session.lastActivityAt = at;
    session.updatedAt = at;
    return session;
  }

  trimSessions() {
    if (this.sessions.size <= 30) return;
    const ordered = [...this.sessions.values()].sort(
      (a, b) => (a.lastActivityAt || 0) - (b.lastActivityAt || 0),
    );
    while (this.sessions.size > 24 && ordered.length) {
      const victim = ordered.shift();
      if (victim && victim.status !== "busy") this.sessions.delete(victim.id);
    }
  }

  async hydrate(session, force = false) {
    if (!this.ctx || !this.ctx.session || !this.ctx.session.get) return;
    if (session.hydrating) return;
    const at = nowMs();
    if (!force && at - session.hydratedAt < 15000) return;
    session.hydrating = true;
    try {
      const info = await this.ctx.session.get({ sessionID: session.id });
      if (info) {
        if (info.title) session.title = String(info.title);
        if (info.model) this.setModel(session, info.model);
        const output = Number(info.tokens && info.tokens.output);
        if (Number.isFinite(output) && output > session.totalOutput) {
          session.totalOutput = output;
        }
      }
      session.hydratedAt = nowMs();
    } catch (error) {
      session.hydratedAt = nowMs();
      if (DEBUG) {
        log("session hydrate failed", {
          sessionID: session.id,
          error: String(error),
        });
      }
    } finally {
      session.hydrating = false;
    }
  }

  setModel(session, model) {
    const ref = modelRef(model);
    if (!ref) return;
    session.modelRef = ref;
    session.modelVariant = modelVariant(model);
    session.model =
      this.modelNames.get(ref) || model.id || ref;
  }

  ensureRun(session, at, observedStart) {
    if (!session.run) {
      session.run = createRun(at, session.totalOutput, observedStart, {
        cjkRatio: session.cjkRatio,
        nonCjkRatio: session.nonCjkRatio,
      });
      session.run.ratio = clamp(
        session.nonCjkRatio || DEFAULT_NON_CJK_RATIO,
        NON_CJK_RATIO_MIN,
        NON_CJK_RATIO_MAX,
      );
      session.status = "busy";
    }
    return session.run;
  }

  beginExecution(session, at) {
    if (
      session.run &&
      !session.run.finalized &&
      !session.run.observedStart &&
      session.run.firstTokenAt === null &&
      session.run.outputTokens === 0
    ) {
      session.run.startedAt = at;
      session.run.observedStart = true;
      session.run.usageBase = session.totalOutput;
    } else {
      session.run = createRun(at, session.totalOutput, true, {
        cjkRatio: session.cjkRatio,
        nonCjkRatio: session.nonCjkRatio,
      });
      session.run.ratio = clamp(
        session.nonCjkRatio || DEFAULT_NON_CJK_RATIO,
        NON_CJK_RATIO_MIN,
        NON_CJK_RATIO_MAX,
      );
    }
    session.status = "busy";
    session.error = null;
  }

  onDelta(session, eventAt, arrivalAt, text, kind) {
    if (!text) return;
    const run = this.ensureRun(session, arrivalAt, false);
    if (!run.startedAt) run.startedAt = eventAt;
    if (run.firstTokenAt === null) {
      run.firstTokenAt = eventAt;
      run.ttftMs = Math.max(0, eventAt - run.startedAt);
    }
    if (!run.stepStartedAt) run.stepStartedAt = eventAt;
    if (!run.stepFirstDeltaAt) run.stepFirstDeltaAt = eventAt;

    // Link diagnostics intentionally run before dedup: a duplicate payload is
    // still a real packet arrival, and we want to see the transport pattern.
    if (run.lastArrivalAt > 0) {
      const gap = Math.max(0, arrivalAt - run.lastArrivalAt);
      run.gaps.push(gap);
      if (run.gaps.length > LINK_WINDOW) run.gaps.shift();
    }
    run.lastArrivalAt = arrivalAt;
    run.lastDeltaAt = arrivalAt;

    if (kind === "reasoning") {
      rememberReasoning(run, text);
    } else {
      text = dedupeAgainstReasoning(run, text);
      if (!text) {
        session.status = "busy";
        return;
      }
    }

    const cjk = countCjk(text);
    const nonCjk = Math.max(0, text.length - cjk);
    const estimated = estimateTokens(text, {
      cjkRatio: run.cjkRatio,
      nonCjkRatio: run.nonCjkRatio,
    });
    run.stepChars += text.length;
    run.stepCjk += cjk;
    run.stepNonCjk += nonCjk;
    run.stepEstimated += estimated;
    run.estimatedTokens += estimated;
    run.chars += text.length;

    run.samples.push({ t: arrivalAt, tokens: estimated });
    const cutoff = arrivalAt - LIVE_WINDOW_MS - 2000;
    while (run.samples.length && run.samples[0].t < cutoff) {
      run.samples.shift();
    }
    session.status = "busy";
  }

  onStepStarted(session, at, data) {
    const run = this.ensureRun(session, at, false);
    if (!run.stepStartedAt) run.stepStartedAt = at;
    // Do not count the idle gap between two steps as a stream stall.
    run.lastArrivalAt = 0;
    run.stepFirstDeltaAt = null;
    // The live estimate is per step: mixing the previous step's deltas into
    // the new window would report a rate that spans two decode phases.
    run.samples = [];
    if (data && data.model) this.setModel(session, data.model);
    session.status = "busy";
  }

  onStepEnded(session, eventAt, arrivalAt, data) {
    const run = this.ensureRun(session, eventAt, false);
    const tokensInfo = data && data.tokens ? data.tokens : {};
    const usageTokens = Number(tokensInfo.output);
    const usageBacked = Number.isFinite(usageTokens) && usageTokens > 0;
    let tokens = usageTokens;
    if (!usageBacked) {
      tokens = Math.max(0, Math.round(run.stepEstimated));
    }

    // Only a step we actually observed starting can be timed. When the
    // step.started event is missing, the first delta of this step is the best
    // remaining anchor; without either, the step gets no rate at all (its
    // tokens still count toward OUT).
    const hasStepStart =
      Number.isFinite(run.stepStartedAt) && run.stepStartedAt > 0;
    const startedAt = hasStepStart
      ? run.stepStartedAt
      : run.stepFirstDeltaAt !== null
        ? run.stepFirstDeltaAt
        : null;
    const durationMs =
      startedAt === null ? 0 : Math.max(0, eventAt - startedAt);
    // Step TTFT is only meaningful when this step streamed a first delta.
    // The old fallback to the run-level TTFT made decodeMs collapse to 1 ms
    // for tool-only steps and reported decodeTps values in the tens of
    // thousands.
    const stepTtftMs =
      hasStepStart && run.stepFirstDeltaAt !== null
        ? clamp(run.stepFirstDeltaAt - startedAt, 0, durationMs)
        : 0;
    const decodeMs = Math.max(MIN_DECODE_MS, durationMs - stepTtftMs);
    const e2eMs = run.observedStart
      ? Math.max(1, arrivalAt - run.startedAt)
      : 0;
    // Steps shorter than MEASURABLE_STEP_MS are too noisy to time. They still
    // add their tokens to OUT, but they must not overwrite the displayed rate.
    const measurable = tokens > 0 && durationMs >= MEASURABLE_STEP_MS;
    let tps = 0;
    let decodeTps = 0;
    let e2eTps = 0;

    if (tokens > 0) {
      run.completedSteps += 1;
      run.outputTokens += tokens;
      run.lastStepTokens = tokens;
      run.lastStepMs = durationMs;
      run.lastStepTtftMs = stepTtftMs;
      run.stepUsageBacked = usageBacked;

      if (measurable) {
        run.timedTokens += tokens;
        run.totalGenerationMs += durationMs;
        run.decodeMsTotal += decodeMs;
        const tpsValue = clamp(tokens / (durationMs / 1000), 0, MAX_TPS);
        const decodeTpsValue = clamp(tokens / (decodeMs / 1000), 0, MAX_TPS);
        const e2eTpsValue =
          e2eMs > 0 ? clamp(tokens / (e2eMs / 1000), 0, MAX_TPS) : 0;
        tps = tpsValue;
        decodeTps = decodeTpsValue;
        e2eTps = e2eTpsValue;
        run.lastStepTps = tpsValue;
        run.lastDecodeTps = decodeTpsValue;
        run.lastE2eTps = e2eTpsValue;
        if (
          usageBacked &&
          tokens >= PEAK_MIN_TOKENS &&
          durationMs >= PEAK_MIN_DURATION_MS &&
          tpsValue > run.peakTps
        ) {
          run.peakTps = tpsValue;
          run.peakSource = "usage";
        }
      }

      if (usageBacked && run.stepChars > 0) {
        session.calibration.push({
          cjk: run.stepCjk,
          nonCjk: run.stepNonCjk,
          tokens,
        });
        if (session.calibration.length > CALIBRATION_WINDOW) {
          session.calibration.splice(
            0,
            session.calibration.length - CALIBRATION_WINDOW,
          );
        }
        const solved = solveRatios(session.calibration);
        if (solved) {
          if (solved.cjkRatio !== null) {
            session.cjkRatio = solved.cjkRatio;
            run.cjkRatio = solved.cjkRatio;
          }
          if (solved.nonCjkRatio !== null) {
            session.nonCjkRatio = solved.nonCjkRatio;
            run.nonCjkRatio = solved.nonCjkRatio;
            session.ratio = solved.nonCjkRatio;
            run.ratio = solved.nonCjkRatio;
          }
        }
      }

      run.stepEndedAt = arrivalAt;
      run.lastStepEndedAt = arrivalAt;
      // Backfill the step's time range with real usage so the sparkline and
      // the usage-derived peak use the same unit.
      if (usageBacked && startedAt !== null) {
        this.backfillSpark(startedAt, arrivalAt, tokens);
      }
      // The step is complete: show its real usage-derived TPS instead of the
      // character-based estimate for the next couple of seconds.
      run.samples = [];
      if (DEBUG) {
        log("step usage", {
          sessionID: session.id,
          tokens,
          durationMs,
          stepTtftMs,
          tps: round(tps, 1),
          decodeTps: round(decodeTps, 1),
          e2eTps: round(e2eTps, 1),
          chars: run.stepChars,
          cjk: run.stepCjk,
          cjkRatio: round(run.cjkRatio, 4),
          nonCjkRatio: round(run.nonCjkRatio, 4),
        });
      }
    }

    run.stepStartedAt = null;
    run.stepFirstDeltaAt = null;
    run.stepChars = 0;
    run.stepCjk = 0;
    run.stepNonCjk = 0;
    run.stepEstimated = 0;
    run.stepUsageBacked = false;
    // Gaps between steps are tool/queue time, not transport stalls.
    run.lastArrivalAt = 0;
    run.reasoningTail = "";
    run.reasoningChunks.clear();
    session.status = "busy";
  }

  onUsage(session, data) {
    const tokens = data && data.tokens ? data.tokens : {};
    const output = Number(tokens.output);
    if (!Number.isFinite(output)) return;
    if (output > session.totalOutput) session.totalOutput = output;
    // `tokens.output` is cumulative for the session, not for the current run.
    // When the plugin starts in the middle of a session, using it as the run
    // total would report the whole session (tens of thousands of tokens) as
    // this run's output. Run output is accumulated from step.ended instead.
  }

  finishRun(session, at, reason, error) {
    const run = session.run;
    if (!run) {
      session.status = "idle";
      if (error) session.error = error;
      return;
    }
    if (run.finalized) {
      session.status = "idle";
      return;
    }
    run.finalized = true;

    const avg =
      run.totalGenerationMs > 0
        ? clamp(
            run.timedTokens / (run.totalGenerationMs / 1000),
            0,
            MAX_TPS,
          )
        : 0;
    const e2eTps =
      run.observedStart && run.outputTokens > 0
        ? clamp(
            run.outputTokens /
              (Math.max(1, (run.lastStepEndedAt || at) - run.startedAt) / 1000),
            0,
            MAX_TPS,
          )
        : 0;
    // LAST prefers the last measurable step. When every step was too short to
    // time (or none completed), fall back to the average and then to the
    // end-to-end rate instead of publishing the last short step's raw ratio.
    const tps = run.lastStepTps || avg || e2eTps;
    // Prefer actual per-step usage. The live estimate is only a fallback when
    // no step ever completed (for example the plugin loaded mid-stream).
    // Never fall back to the last step's own TPS: a short, noisy step must not
    // become PEAK just because it was the only step in the run. The live
    // estimate is only a fallback when no step completed at all (for example
    // the plugin loaded in the middle of a stream).
    const peak = clamp(
      run.peakTps > 0
        ? run.peakTps
        : run.completedSteps === 0
          ? run.livePeak
          : 0,
      0,
      MAX_TPS,
    );
    const peakSource = run.peakTps > 0 ? "usage" : "estimated";
    const link = summarizeLink(run.gaps);

    if (run.outputTokens > 0 || tps > 0) {
      session.lastCompleted = {
        tps: round(tps, 2),
        liveTps: 0,
        liveTpsSource: "estimated",
        decodeTps: round(run.lastDecodeTps, 2),
        decodeTpsSource: "usage",
        e2eTps: round(e2eTps, 2),
        e2eTpsSource: "usage",
        avgTps: round(avg, 2),
        peakTps: round(peak, 2),
        peakSource,
        ttftMs:
          run.ttftMs === null || !Number.isFinite(run.ttftMs)
            ? null
            : Math.round(run.ttftMs),
        outputTokens: Math.round(run.outputTokens),
        totalOutputTokens: Math.round(session.totalOutput),
        durationMs: Math.max(0, at - run.startedAt),
        stepDurationMs: Math.round(run.lastStepMs),
        stepTtftMs: Math.round(run.lastStepTtftMs),
        stepTokens: Math.round(run.lastStepTokens),
        model: session.model,
        modelRef: session.modelRef,
        title: session.title,
        at,
        reason: reason || "idle",
        ...link,
      };
    }

    session.run = null;
    session.status = "idle";
    session.liveTps = 0;
    session.error = error || null;
    void this.hydrate(session, true);
  }

  handleEvent(event) {
    if (!event || !event.type) return;
    appendDebugEvent(event);
    const at = this.now();
    const eventAt = Number.isFinite(Number(event.created))
      ? Number(event.created)
      : at;
    const data = event.data || {};

    switch (event.type) {
      case "session.created": {
        const id = data.sessionID || data.id;
        const session = this.getSession(id, eventAt);
        if (!session) return;
        if (data.title) session.title = String(data.title);
        if (data.model) this.setModel(session, data.model);
        if (data.model) void this.hydrate(session);
        return;
      }
      case "session.renamed": {
        const session = this.getSession(data.sessionID, eventAt);
        if (session && data.title) session.title = String(data.title);
        return;
      }
      case "session.model.selected": {
        const session = this.getSession(data.sessionID, eventAt);
        if (session && data.model) this.setModel(session, data.model);
        return;
      }
      case "session.execution.started": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        this.beginExecution(session, eventAt);
        return;
      }
      case "session.step.started": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        this.onStepStarted(session, eventAt, data);
        return;
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        this.onDelta(
          session,
          eventAt,
          at,
          data.delta || "",
          event.type === "session.reasoning.delta" ? "reasoning" : "text",
        );
        return;
      }
      case "session.step.ended": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        this.onStepEnded(session, eventAt, at, data);
        return;
      }
      case "session.usage.updated": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        this.onUsage(session, data);
        return;
      }
      case "session.status": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        const status = data.status || {};
        if (status.type === "busy") {
          this.ensureRun(session, eventAt, false);
          session.status = "busy";
          session.error = null;
        } else if (status.type === "idle") {
          this.finishRun(session, eventAt, "idle");
        } else if (status.type === "retry") {
          session.status = "retry";
          session.error = status.message || "retry";
        }
        return;
      }
      case "session.idle": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        this.finishRun(session, eventAt, "idle");
        return;
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        this.finishRun(session, eventAt, event.type);
        return;
      }
      case "session.execution.failed": {
        const session = this.getSession(data.sessionID, eventAt);
        if (!session) return;
        this.finishRun(
          session,
          eventAt,
          "failed",
          data.error ? String(data.error) : "execution failed",
        );
        return;
      }
      case "session.deleted":
      case "session.archived": {
        if (data.sessionID) this.sessions.delete(data.sessionID);
        return;
      }
      default:
        return;
    }
  }

  computeLive(session, at) {
    const run = session.run;
    if (!run || run.finalized) return 0;
    const cutoff = at - LIVE_WINDOW_MS;
    const samples = run.samples.filter((sample) => sample.t >= cutoff);
    if (samples.length === 0) {
      // No samples means there is no live estimate. The usage-derived last
      // step TPS is exposed separately as decodeTps / lastStepTps, so liveTps
      // always keeps its documented meaning: a character-based estimate.
      return 0;
    }
    // Divide the window by the time it really covers, anchored at the step
    // start. Dividing a buffered chunk by the few milliseconds since its
    // first sample multiplied the estimate by up to 10x.
    const stepStart =
      Number.isFinite(run.stepStartedAt) && run.stepStartedAt > 0
        ? run.stepStartedAt
        : samples[0].t;
    const spanMs = Math.max(MIN_LIVE_SPAN_MS, at - Math.max(cutoff, stepStart));
    let tokens = 0;
    for (const sample of samples) tokens += sample.tokens;
    return clamp(tokens / (spanMs / 1000), 0, MAX_TPS);
  }

  pickActive() {
    const sessions = [...this.sessions.values()];
    if (!sessions.length) return null;
    const busy = sessions.filter(
      (session) => session.status === "busy" || session.status === "retry",
    );
    const pool = busy.length ? busy : sessions;
    pool.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    return { session: pool[0], busyCount: busy.length };
  }

  alignSpark(at) {
    const second = Math.floor(at / 1000);
    if (second === this.sparkSecond) return;
    const gap = Math.min(60, Math.max(0, second - this.sparkSecond));
    if (gap > 0) {
      for (let i = 0; i < gap; i += 1) {
        this.spark.shift();
        this.spark.push(0);
        this.sparkSource.shift();
        this.sparkSource.push(0);
        this.sparkEstimated.shift();
        this.sparkEstimated.push(0);
      }
    }
    this.sparkSecond = second;
  }

  pushSpark(at, tps, source) {
    this.alignSpark(at);
    const value = clamp(Number(tps) || 0, 0, MAX_TPS);
    if (source === 1) {
      // Usage backfill wins over an estimate for the same second.
      this.spark[59] = value;
      this.sparkSource[59] = 1;
      return;
    }
    if (this.sparkSource[59] === 1) return;
    this.spark[59] = Math.max(this.spark[59], value);
    this.sparkEstimated[59] = Math.max(this.sparkEstimated[59], value);
  }

  backfillSpark(startMs, endMs, tokens) {
    if (!(tokens > 0) || !(endMs > startMs)) return;
    this.alignSpark(endMs);
    const seconds = Math.max(0.5, (endMs - startMs) / 1000);
    const tps = clamp(tokens / seconds, 0, MAX_TPS);
    const firstSecond = Math.floor(startMs / 1000);
    const lastSecond = Math.floor(endMs / 1000);
    for (let second = firstSecond; second <= lastSecond; second += 1) {
      const index = 59 - (this.sparkSecond - second);
      if (index < 0 || index > 59) continue;
      this.spark[index] = tps;
      this.sparkSource[index] = 1;
    }
  }

  buildState(at) {
    const active = this.pickActive();
    const session = active ? active.session : null;
    let status = "waiting";
    let sessionState = null;
    let lastCompleted = null;

    if (session) {
      lastCompleted = session.lastCompleted || null;
      if (session.status === "busy" || session.status === "retry") {
        status = session.status;
        const run = session.run;
        const live = session.liveTps || 0;
        const generationMs = run ? run.totalGenerationMs : 0;
        const avg = run
          ? generationMs > 0
            ? clamp(run.timedTokens / (generationMs / 1000), 0, MAX_TPS)
            : run.estimatedTokens > 0 && at - run.startedAt > 300
              ? clamp(
                  run.estimatedTokens / ((at - run.startedAt) / 1000),
                  0,
                  MAX_TPS,
                )
              : 0
          : 0;
        const e2eTps =
          run && run.observedStart
            ? run.outputTokens > 0
              ? clamp(
                  run.outputTokens /
                    (Math.max(1, (run.lastStepEndedAt || at) - run.startedAt) /
                      1000),
                  0,
                  MAX_TPS,
                )
              : 0
            : 0;
        const link = summarizeLink(run ? run.gaps : []);
        const peak = clamp(
          run
            ? run.peakTps > 0
              ? run.peakTps
              : run.completedSteps === 0
                ? run.livePeak
                : 0
            : 0,
          0,
          MAX_TPS,
        );
        sessionState = {
          id: session.id,
          title: session.title || "",
          model: session.model || "",
          modelRef: session.modelRef,
          modelVariant: session.modelVariant,
          status: session.status,
          tps: round(live, 2),
          liveTps: round(live, 2),
          liveTpsSource: "estimated",
          decodeTps: run ? round(run.lastDecodeTps, 2) : 0,
          decodeTpsSource: "usage",
          e2eTps: round(e2eTps, 2),
          e2eTpsSource: "usage",
          avgTps: round(avg, 2),
          peakTps: round(peak, 2),
          peakSource: run && run.peakTps > 0 ? "usage" : "estimated",
          ttftMs:
            run && run.ttftMs !== null && Number.isFinite(run.ttftMs)
              ? Math.round(run.ttftMs)
              : null,
          stepTtftMs: run ? Math.round(run.lastStepTtftMs) : null,
          stepTokens: run ? Math.round(run.lastStepTokens) : 0,
          stepDurationMs: run ? Math.round(run.lastStepMs) : 0,
          outputTokens: Math.round(run ? run.outputTokens : 0),
          totalOutputTokens: Math.round(session.totalOutput || 0),
          elapsedMs: run ? Math.max(0, at - run.startedAt) : 0,
          startedAt: run ? run.startedAt : null,
          lastCompletedAt: lastCompleted ? lastCompleted.at : null,
          estimateRatio: run ? round(run.nonCjkRatio, 4) : null,
          estimateCjkRatio: run ? round(run.cjkRatio, 4) : null,
          estimateNonCjkRatio: run ? round(run.nonCjkRatio, 4) : null,
          error: session.error || null,
          ...link,
        };
      } else {
        status = "idle";
        const completed = lastCompleted || {};
        sessionState = {
          id: session.id,
          title: session.title || "",
          model: session.model || "",
          modelRef: session.modelRef,
          modelVariant: session.modelVariant,
          status: "idle",
          tps: completed.tps || 0,
          liveTps: 0,
          liveTpsSource: "estimated",
          decodeTps: completed.decodeTps || 0,
          decodeTpsSource: "usage",
          e2eTps: completed.e2eTps || 0,
          e2eTpsSource: "usage",
          avgTps: completed.avgTps || 0,
          peakTps: completed.peakTps || 0,
          peakSource: completed.peakSource || "estimated",
          ttftMs:
            completed.ttftMs === undefined ? null : completed.ttftMs,
          stepTtftMs: completed.stepTtftMs || 0,
          stepTokens: completed.stepTokens || 0,
          stepDurationMs: completed.stepDurationMs || 0,
          outputTokens: completed.outputTokens || 0,
          totalOutputTokens: Math.round(session.totalOutput || 0),
          elapsedMs: completed.durationMs || 0,
          startedAt: completed.at || null,
          lastCompletedAt: completed.at || null,
          estimateRatio: session.nonCjkRatio,
          estimateCjkRatio: session.cjkRatio,
          estimateNonCjkRatio: session.nonCjkRatio,
          error: session.error || null,
          gapP50Ms: completed.gapP50Ms || 0,
          gapP95Ms: completed.gapP95Ms || 0,
          gapMaxMs: completed.gapMaxMs || 0,
          burstRatio: completed.burstRatio || 0,
          stallCount: completed.stallCount || 0,
          streamHealth: completed.streamHealth || "smooth",
        };
      }
    }

    const summaries = [...this.sessions.values()]
      .sort((a, b) => {
        const rank = (s) => (s.status === "busy" ? 0 : s.status === "retry" ? 1 : 2);
        return rank(a) - rank(b) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
      })
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        title: item.title || "",
        model: item.model || "",
        status: item.status,
        tps: round(item.liveTps || 0, 2),
        decodeTps: item.run
          ? round(item.run.lastDecodeTps, 2)
          : item.lastCompleted
            ? round(item.lastCompleted.decodeTps || 0, 2)
            : 0,
        lastCompleted: item.lastCompleted || null,
      }));

    const spark = this.spark.map((value) => round(value, 1));
    const sparkSource = this.sparkSource.slice();
    let sparkMaxUsage = 0;
    for (let i = 0; i < spark.length; i += 1) {
      if (sparkSource[i] === 1 && spark[i] > sparkMaxUsage) {
        sparkMaxUsage = spark[i];
      }
    }
    const sparkMaxEstimated = Math.max(
      0,
      ...this.sparkEstimated.map((value) => round(value, 1)),
    );
    return {
      schema: STATE_SCHEMA,
      plugin: {
        id: PLUGIN_ID,
        version: VERSION,
        pid: process.pid,
        startedAt: this.startedAt,
        host: os.hostname(),
      },
      updatedAt: at,
      status,
      busyCount: active ? active.busyCount : 0,
      activeSessionID: session ? session.id : null,
      session: sessionState,
      lastCompleted,
      sessions: summaries,
      spark,
      sparkSource,
      sparkMax: round(Math.max(0, ...spark), 1),
      sparkMaxUsage: round(sparkMaxUsage, 1),
      sparkMaxEstimated: round(sparkMaxEstimated, 1),
      staleAfterMs: OFFLINE_MS,
    };
  }

  stateSignature(state) {
    const content = { ...state };
    delete content.updatedAt;
    return JSON.stringify(content);
  }

  writeState(at, closed = false) {
    const state = this.buildState(at);
    if (closed) state.plugin.closedAt = at;
    this.lastState = state;
    const payload = JSON.stringify(state);

    if (closed) {
      // A final synchronous write must win over any in-flight async write.
      this.latestStateSeq += 1;
      this.pendingStatePayload = null;
      this.lastStateJson = payload;
      this.lastStateWriteAt = at;
      writeJsonAtomic(STATE_FILE, state);
      return;
    }

    const signature = this.stateSignature(state);
    if (
      signature === this.lastStateSignature &&
      at - this.lastStateWriteAt < STATE_HEARTBEAT_MS
    ) {
      return;
    }
    this.lastStateSignature = signature;
    this.lastStateJson = payload;
    this.lastStateWriteAt = at;

    this.latestStateSeq += 1;
    const seq = this.latestStateSeq;
    this.pendingStateSeq = seq;
    this.pendingStatePayload = payload;
    if (this.stateWriting) return;
    this.stateWriting = true;
    void this.flushStateWrites();
  }

  async flushStateWrites() {
    while (this.pendingStatePayload !== null) {
      const payload = this.pendingStatePayload;
      const seq = this.pendingStateSeq;
      this.pendingStatePayload = null;
      const bytes = Buffer.byteLength(payload);
      if (bytes > this.stateBuffer.length) {
        this.stateBuffer = Buffer.allocUnsafe(Math.max(bytes * 2, 64 * 1024));
      }
      this.stateBuffer.write(payload, 0, "utf8");
      const buffer = this.stateBuffer.subarray(0, bytes);
      await writeBufferAtomic(STATE_FILE, buffer, () => seq !== this.latestStateSeq);
    }
    this.stateWriting = false;
  }

  spawnOverlay() {
    if (!AUTOSTART) {
      log("overlay autostart disabled");
      return;
    }
    if (!fs.existsSync(OVERLAY_SCRIPT)) {
      log("overlay script missing", { path: OVERLAY_SCRIPT });
      return;
    }
    if (overlayRunning()) {
      log("overlay already running");
      return;
    }

    const candidates = [];
    if (process.env.TPS_OVERLAY_PYTHON) {
      candidates.push(process.env.TPS_OVERLAY_PYTHON);
    } else {
      candidates.push("pythonw.exe", "python.exe");
    }

    const trySpawn = (index) => {
      if (index >= candidates.length) {
        log("unable to start overlay: no Python executable found");
        return;
      }
      const command = candidates[index];
      let child;
      try {
        child = spawn(command, [OVERLAY_SCRIPT], {
          cwd: PLUGIN_DIR,
          detached: true,
          windowsHide: true,
          stdio: "ignore",
          env: {
            ...process.env,
            TPS_OVERLAY_DATA_DIR: DATA_DIR,
          },
        });
      } catch (error) {
        log("overlay spawn failed", { command, error: String(error) });
        trySpawn(index + 1);
        return;
      }
      child.once("error", (error) => {
        log("overlay spawn error", { command, error: String(error) });
        trySpawn(index + 1);
      });
      child.once("spawn", () => {
        log("overlay spawned", { command, pid: child.pid });
        if (child.unref) child.unref();
      });
    };

    trySpawn(0);
  }

  toolReport(sessionID) {
    const selected = sessionID ? this.sessions.get(sessionID) : null;
    const list = selected
      ? [selected]
      : [...this.sessions.values()].sort((a, b) => {
          const rank = (s) => (s.status === "busy" ? 0 : s.status === "retry" ? 1 : 2);
          return rank(a) - rank(b) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
        });
    if (!list.length) {
      return "No TPS data yet. Start a prompt in OpenCode V2, then try again.";
    }
    const lines = ["OpenCode TPS (live)"];
    for (const session of list.slice(0, 6)) {
      const run = session.run;
      const completed = session.lastCompleted;
      const busy = session.status === "busy" || session.status === "retry";
      const avg = run
        ? run.totalGenerationMs > 0
          ? clamp(run.timedTokens / (run.totalGenerationMs / 1000), 0, MAX_TPS)
          : 0
        : completed
          ? completed.avgTps
          : 0;
      const peak = clamp(
        run
          ? run.peakTps > 0
            ? run.peakTps
            : run.completedSteps === 0
              ? run.livePeak
              : 0
          : completed
            ? completed.peakTps
            : 0,
        0,
        MAX_TPS,
      );
      const ttft = run
        ? run.ttftMs
        : completed
          ? completed.ttftMs
          : null;
      const output = run
        ? run.outputTokens
        : completed
          ? completed.outputTokens
          : 0;
      const tps = busy ? session.liveTps || 0 : completed ? completed.tps : 0;
      const decode = run
        ? run.lastDecodeTps
        : completed
          ? completed.decodeTps || 0
          : 0;
      const e2e = run
        ? run.observedStart && run.outputTokens > 0
          ? clamp(
              run.outputTokens /
                (Math.max(1, (run.lastStepEndedAt || this.now()) - run.startedAt) /
                  1000),
              0,
              MAX_TPS,
            )
          : 0
        : completed
          ? completed.e2eTps || 0
          : 0;
      const link = run
        ? summarizeLink(run.gaps)
        : {
            streamHealth: (completed && completed.streamHealth) || "smooth",
            gapP95Ms: (completed && completed.gapP95Ms) || 0,
            stallCount: (completed && completed.stallCount) || 0,
          };
      lines.push(
        `- ${session.status.toUpperCase()} ${session.title || session.id} (${session.model || "unknown model"}): ` +
          `tps=${round(tps, 1)} avg=${round(avg, 1)} peak=${round(peak, 1)} ` +
          `ttft=${ttft === null ? "n/a" : `${Math.round(ttft)}ms`} out=${Math.round(output)} ` +
          `decode=${round(decode, 1)} e2e=${round(e2e, 1)} ` +
          `link=${link.streamHealth}/p95:${link.gapP95Ms}ms/stall:${link.stallCount}`,
      );
    }
    lines.push(`State file: ${STATE_FILE}`);
    return lines.join("\n");
  }
}

async function setup(ctx) {
  let engine = globalThis[ENGINE_KEY];
  if (engine && engine.version !== VERSION) {
    // A plugin reload can happen without restarting the server process. The
    // singleton would otherwise keep running the previous module's engine.
    log("replacing engine from another version", {
      from: String(engine.version || "unknown"),
      to: VERSION,
    });
    try {
      engine.stop();
    } catch {
      // ignore
    }
    if (globalThis[ENGINE_KEY] === engine) {
      delete globalThis[ENGINE_KEY];
    }
    engine = null;
  }
  if (!engine) {
    engine = new TpsEngine(ctx);
    globalThis[ENGINE_KEY] = engine;
    await engine.start();
  } else {
    engine.refs += 1;
    engine.ctx = ctx;
  }

  let registration = null;
  try {
    registration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "tps",
        description:
          "Show live OpenCode token throughput (TPS), average TPS, peak TPS, time to first token, and output tokens for the current or most recent session.",
        input: {
          type: "object",
          properties: {
            sessionID: {
              type: "string",
              description: "Optional session ID. Omit to show all active sessions.",
            },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const sessionID =
            input && typeof input.sessionID === "string"
              ? input.sessionID
              : undefined;
          return { content: engine.toolReport(sessionID) };
        },
      });
    });
  } catch (error) {
    log("tps tool registration failed", { error: String(error) });
  }

  return async () => {
    try {
      if (registration) await registration.dispose();
    } catch {
      // ignore
    }
    engine.release();
  };
}

export { TpsEngine, estimateTokens, countCjk };
export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    return setup(ctx);
  },
};
