// Synthetic metric tests for index.js. No provider, network, or real state
// file is involved: the engine clock is injected and writeState is stubbed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tps-overlay-test-"));
process.env.TPS_OVERLAY_DATA_DIR = tempDir;
process.env.TPS_OVERLAY_AUTOSTART = "0";
process.env.TPS_OVERLAY_DEBUG = "0";

const { TpsEngine, estimateTokens } = await import("./index.js");

const SESSION_ID = "ses_test";
const BASE = 1_000_000;
const DELTA_TEXT = "abcd"; // 4 non-CJK chars -> 1.2 estimated tokens at 0.30

function createHarness() {
  const clock = { value: BASE };
  const engine = new TpsEngine({});
  engine.now = () => clock.value;
  engine.writeState = () => {};
  return { engine, clock };
}

function emit(engine, clock, type, data, at) {
  clock.value = at;
  engine.handleEvent({ type, created: at, data });
}

function emitDelta(engine, clock, at, delta) {
  emit(engine, clock, "session.text.delta", { sessionID: SESSION_ID, delta }, at);
}

function emitStepEnd(engine, clock, at, tokens) {
  emit(
    engine,
    clock,
    "session.step.ended",
    { sessionID: SESSION_ID, tokens: { output: tokens } },
    at,
  );
}

function relativeDiff(a, b) {
  const base = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / base;
}

function report(name, details) {
  console.log(`PASS  ${name}`);
  for (const [key, value] of Object.entries(details)) {
    console.log(`      ${key}: ${value}`);
  }
}

function testSmoothStream() {
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0,
  );

  let last = t0;
  for (let i = 0; i < 60; i += 1) {
    last = t0 + (i + 1) * 20;
    emitDelta(engine, clock, last, DELTA_TEXT);
  }

  // One tick before the step ends captures the live estimate.
  engine.tick();
  const session = engine.sessions.get(SESSION_ID);
  const liveTps = session.liveTps;

  emitStepEnd(engine, clock, t0 + 1300, 72);
  const state = engine.buildState(t0 + 1300);
  const decodeTps = state.session.decodeTps;

  assert.ok(
    liveTps >= 45 && liveTps <= 75,
    `smooth liveTps ${liveTps} should be within 45..75`,
  );
  assert.ok(
    relativeDiff(liveTps, decodeTps) < 0.3,
    `liveTps ${liveTps} vs decodeTps ${decodeTps} differ by more than 30%`,
  );

  report("1. smooth stream", {
    liveTps: liveTps.toFixed(2),
    decodeTps: decodeTps.toFixed(2),
    relativeDiff: `${(relativeDiff(liveTps, decodeTps) * 100).toFixed(1)}%`,
  });
}

function testBurstStream() {
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0,
  );

  // The spec's "bursty" rule requires more than two gaps > 500 ms, so use
  // four dense batches; three inter-batch gaps satisfy stallCount > 2.
  const batches = 4;
  const perBatch = 15;
  let cursor = t0 + 1500;
  for (let batch = 0; batch < batches; batch += 1) {
    for (let i = 0; i < perBatch; i += 1) {
      emitDelta(engine, clock, cursor, DELTA_TEXT);
      cursor += 5;
    }
    clock.value = cursor - 5;
    engine.tick();
    cursor += 600;
  }

  const endAt = cursor;
  emitStepEnd(engine, clock, endAt, 72);
  const state = engine.buildState(endAt);
  const burstRatio = state.session.burstRatio;
  const health = state.session.streamHealth;
  const estimatedMax = state.sparkMaxEstimated;
  const usageMax = state.sparkMaxUsage;

  assert.ok(burstRatio > 0.6, `burstRatio ${burstRatio} should exceed 0.6`);
  assert.equal(health, "bursty");
  assert.ok(
    estimatedMax <= Math.max(usageMax * 1.5, usageMax + 5),
    `sparkMaxEstimated ${estimatedMax} should stay close to sparkMaxUsage ${usageMax}`,
  );

  report("2. burst stream", {
    burstRatio,
    streamHealth: health,
    stallCount: state.session.stallCount,
    sparkMaxEstimated: estimatedMax,
    sparkMaxUsage: usageMax,
  });
}

function testShortStep() {
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emitDelta(engine, clock, t0 + 50, "abcdefghijklmnopqrst");
  // A tick during the step gives the live estimator a non-zero peak; the
  // short step must still be excluded from PEAK once it completes.
  engine.tick();
  emitStepEnd(engine, clock, t0 + 100, 20);

  const busyState = engine.buildState(t0 + 100);
  assert.equal(busyState.session.peakTps, 0);
  assert.notEqual(busyState.session.peakSource, "usage");

  emit(engine, clock, "session.idle", { sessionID: SESSION_ID }, t0 + 100);
  const idleState = engine.buildState(t0 + 100);
  assert.equal(idleState.lastCompleted.peakTps, 0);
  assert.equal(idleState.session.peakTps, 0);

  report("3. short step excluded from peak", {
    peakTps: busyState.session.peakTps,
    peakSource: busyState.session.peakSource,
    stepTokens: busyState.session.stepTokens,
    stepDurationMs: busyState.session.stepDurationMs,
  });
}

function testTtftSplit() {
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emitDelta(engine, clock, t0 + 8000, "a".repeat(400));
  emitStepEnd(engine, clock, t0 + 10000, 100);

  const state = engine.buildState(t0 + 10000);
  const decodeTps = state.session.decodeTps;
  const e2eTps = state.session.e2eTps;
  const avgTps = state.session.avgTps;

  assert.ok(
    Math.abs(decodeTps - 50) < 0.5,
    `decodeTps ${decodeTps} should be ~50`,
  );
  assert.ok(Math.abs(e2eTps - 10) < 0.2, `e2eTps ${e2eTps} should be ~10`);
  assert.ok(Math.abs(avgTps - 10) < 0.2, `avgTps ${avgTps} should be ~10`);

  report("4. TTFT separation", {
    decodeTps: decodeTps.toFixed(2),
    e2eTps: e2eTps.toFixed(2),
    avgTps: avgTps.toFixed(2),
    stepTtftMs: state.session.stepTtftMs,
  });
}

function testCjkCalibration() {
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );

  let cursor = t0;
  for (let step = 0; step < 3; step += 1) {
    const stepStart = cursor;
    emit(
      engine,
      clock,
      "session.step.started",
      { sessionID: SESSION_ID },
      stepStart,
    );
    for (let i = 0; i < 10; i += 1) {
      cursor += 10;
      emitDelta(engine, clock, cursor, "汉".repeat(10));
    }
    cursor = stepStart + 1000;
    emitStepEnd(engine, clock, cursor, 60);
    cursor += 100;
  }

  const session = engine.sessions.get(SESSION_ID);
  const cjkRatio = session.cjkRatio;
  const nonCjkRatio = session.nonCjkRatio;
  const estimated = estimateTokens("汉".repeat(100), {
    cjkRatio,
    nonCjkRatio,
  });
  const error = Math.abs(estimated - 60) / 60;

  assert.ok(
    Math.abs(cjkRatio - 0.6) < 0.03,
    `cjkRatio ${cjkRatio} should converge near 0.6`,
  );
  assert.ok(
    error < 0.15,
    `CJK estimate error ${(error * 100).toFixed(1)}% should be below 15%`,
  );

  report("5. CJK calibration", {
    cjkRatio,
    nonCjkRatio,
    calibratedSamples: session.calibration.length,
    estimateFor100Cjk: estimated.toFixed(2),
    error: `${(error * 100).toFixed(1)}%`,
  });
}

function testReasoningDedup() {
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.reasoning.delta",
    { sessionID: SESSION_ID, delta: "reasoning-content-that-is-long" },
    t0 + 100,
  );
  emitDelta(engine, clock, t0 + 200, "reasoning-content-that-is-long");
  emitDelta(engine, clock, t0 + 300, "real answer");
  emitStepEnd(engine, clock, t0 + 1000, 5);
  const activeRun = engine.sessions.get(SESSION_ID).run;
  // Reasoning is counted once (31 chars) plus the real answer (11 chars):
  // about 12.3 tokens at ratio 0.30. If the replayed text were counted too,
  // this would be roughly 21.6.
  assert.ok(
    activeRun.estimatedTokens < 15,
    `duplicate reasoning must not be counted (estimatedTokens=${activeRun.estimatedTokens})`,
  );

  emit(engine, clock, "session.idle", { sessionID: SESSION_ID }, t0 + 1000);
  const run = engine.sessions.get(SESSION_ID).lastCompleted;
  assert.ok(
    run.outputTokens === 5,
    "usage accounting must not be affected by dedup",
  );

  report("6. reasoning/text dedup", {
    duplicateChunkSkipped: "yes",
    estimatedTokens: activeRun.estimatedTokens.toFixed(2),
    outputTokens: run.outputTokens,
  });
}

function testShortToolStep() {
  // Regression: a tool-call step carries usage tokens but no streamed delta.
  // The old code reused the run-level TTFT for it, which collapsed the decode
  // window and reported decodeTps values in the tens of thousands.
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0,
  );
  for (let i = 0; i < 30; i += 1) {
    emitDelta(engine, clock, t0 + 13400 + i * 100, "abcdefghij");
  }
  emitStepEnd(engine, clock, t0 + 16400, 100);

  // 300 ms, 120 usage tokens, no deltas at all.
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0 + 16400,
  );
  emitStepEnd(engine, clock, t0 + 16700, 120);

  const state = engine.buildState(t0 + 16700).session;
  assert.ok(
    state.decodeTps <= 100,
    `decodeTps ${state.decodeTps} must not explode for a short tool-only step`,
  );
  assert.ok(state.avgTps <= 10, `avgTps ${state.avgTps} must stay near 6 tok/s`);
  assert.ok(
    state.peakTps <= 10,
    `peakTps ${state.peakTps} must stay near 6 tok/s`,
  );
  assert.equal(state.stepTtftMs, 0);
  assert.equal(state.outputTokens, 220);

  report("7. short tool-only step", {
    decodeTps: state.decodeTps,
    avgTps: state.avgTps,
    peakTps: state.peakTps,
    stepTtftMs: state.stepTtftMs,
    outputTokens: state.outputTokens,
  });
}

function testMeasurableToolStep() {
  // Same shape, but long enough to time. The decode rate must come from the
  // step's own duration, not from the run-level TTFT.
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0,
  );
  for (let i = 0; i < 30; i += 1) {
    emitDelta(engine, clock, t0 + 13400 + i * 100, "abcdefghij");
  }
  emitStepEnd(engine, clock, t0 + 16400, 100);

  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0 + 16400,
  );
  emitStepEnd(engine, clock, t0 + 17400, 120);

  const state = engine.buildState(t0 + 17400).session;
  assert.ok(
    Math.abs(state.decodeTps - 120) < 1,
    `decodeTps ${state.decodeTps} should be 120 (120 tok / 1 s), not TTFT-driven`,
  );
  assert.equal(state.stepTtftMs, 0);

  report("8. measurable tool-only step", {
    decodeTps: state.decodeTps,
    avgTps: state.avgTps,
    stepTtftMs: state.stepTtftMs,
  });
}

function testLiveBurstBounded() {
  // Buffered chunks must be divided by the window they cover, not by the few
  // milliseconds since the chunk's first sample.
  const { engine, clock } = createHarness();
  const t0 = BASE;
  emit(
    engine,
    clock,
    "session.execution.started",
    { sessionID: SESSION_ID },
    t0,
  );
  emit(
    engine,
    clock,
    "session.step.started",
    { sessionID: SESSION_ID },
    t0,
  );

  const chunk = "a".repeat(100); // 30 estimated tokens at 0.30
  for (let i = 0; i < 100; i += 1) {
    emitDelta(engine, clock, t0 + 4000, chunk);
  }
  clock.value = t0 + 4100;
  engine.tick();
  const burstTps = engine.sessions.get(SESSION_ID).liveTps;

  const huge = "a".repeat(1000); // 300 estimated tokens
  for (let i = 0; i < 1000; i += 1) {
    emitDelta(engine, clock, t0 + 4100, huge);
  }
  clock.value = t0 + 4200;
  engine.tick();
  const cappedTps = engine.sessions.get(SESSION_ID).liveTps;

  assert.ok(
    burstTps < 1000,
    `liveTps ${burstTps} should be spread over the 4 s step, not a 1.2 s burst`,
  );
  // 303000 estimated tokens / 4.2 s would be ~72000 without the safety cap.
  assert.ok(cappedTps <= 2000, `liveTps ${cappedTps} must stay under the cap`);

  report("9. live burst bounded", {
    burstTps: burstTps.toFixed(1),
    cappedTps: cappedTps.toFixed(1),
  });
}

try {
  testSmoothStream();
  testBurstStream();
  testShortStep();
  testTtftSplit();
  testCjkCalibration();
  testReasoningDedup();
  testShortToolStep();
  testMeasurableToolStep();
  testLiveBurstBounded();
  console.log("\nAll metric tests passed.");
} catch (error) {
  console.error("\nTEST FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
