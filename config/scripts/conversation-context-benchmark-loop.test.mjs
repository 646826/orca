import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import {
  CONVERSATION_LOOP_MINIMUM_SAMPLES,
  startBenchmarkLoopMeasurement
} from './conversation-context-benchmark-loop.mjs'

it('captures a first synchronous stall with no fabricated histogram samples', () => {
  const stop = startBenchmarkLoopMeasurement()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125)
  const result = stop()
  expect(result).toMatchObject({
    loopMeasurementVersion: 2,
    loopSamples: 0,
    loopP95Ms: null,
    loopP99Ms: null,
    histogramMaxMs: null,
    heartbeatSamples: 1
  })
  expect(result.heartbeatFirstMs).toBeGreaterThan(100)
  expect(result.loopWindowMs).toBe(result.heartbeatFirstMs)
  expect(result.heartbeatTerminalMs).toBe(result.heartbeatFirstMs)
  expect(result.heartbeatMaxMs).toBe(result.heartbeatFirstMs)
  expect(stop()).toBe(result)
})

it('measures a cooperative operation without adding observations after it completes', async () => {
  const stop = startBenchmarkLoopMeasurement()
  let result
  try {
    for (let index = 0; index < CONVERSATION_LOOP_MINIMUM_SAMPLES + 20; index++) {
      await delay(1)
    }
    result = stop()
  } finally {
    stop()
  }
  expect(result.loopSamples).toBeGreaterThanOrEqual(CONVERSATION_LOOP_MINIMUM_SAMPLES)
  expect(result.loopP95Ms).toBeLessThanOrEqual(50)
  expect(result.loopP99Ms).toBeLessThanOrEqual(100)
  expect(result.heartbeatMaxMs).toBeLessThanOrEqual(100)
  expect(stop()).toBe(result)
})

it('captures a terminal stall after the histogram has already recorded cooperative work', async () => {
  const stop = startBenchmarkLoopMeasurement()
  try {
    for (let index = 0; index < 5; index++) {
      await delay(1)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125)
    const result = stop()
    expect(result.loopSamples).toBeGreaterThan(0)
    expect(result.heartbeatTerminalMs).toBeGreaterThan(100)
    expect(result.heartbeatMaxMs).toBeGreaterThanOrEqual(result.heartbeatTerminalMs)
  } finally {
    stop()
  }
})
