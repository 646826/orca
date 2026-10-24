const PHASE_PREFIX = 'ORCA_BENCHMARK_PHASE '
const PHASES = ['setup-start', 'setup-end', 'operation-end', 'cleanup-end']
const SCALE_ARMS = new Set([
  'journal',
  'baseline-journal',
  'preparation-full',
  'preparation-budgeted',
  'projection-scale'
])

export function benchmarkPhase(phase) {
  if (!PHASES.includes(phase)) {
    throw new RangeError('Invalid benchmark phase')
  }
  process.stderr.write(
    `${PHASE_PREFIX}${JSON.stringify({ phase, at: new Date().toISOString() })}\n`
  )
}

export function benchmarkChildTimeoutMs(arm, size) {
  // Includes setup and cleanup; the predeclared 100k allowance changes no operation acceptance gate.
  return size === 100000 && SCALE_ARMS.has(arm) ? 600000 : 120000
}

export function benchmarkChildReceipt(
  result,
  timeoutMs,
  terminationVerified = result.code !== null || result.signal != null
) {
  const phases = [],
    phaseErrors = []
  let previous = -1
  for (const line of result.stderr.split(/\r?\n/)) {
    if (!line.startsWith(PHASE_PREFIX)) {
      continue
    }
    let entry
    try {
      entry = JSON.parse(line.slice(PHASE_PREFIX.length))
    } catch {
      phaseErrors.push('Malformed phase JSON')
      continue
    }
    const ordinal = PHASES.indexOf(entry?.phase)
    if (
      ordinal === -1 ||
      ordinal <= previous ||
      typeof entry?.at !== 'string' ||
      !Number.isFinite(Date.parse(entry.at))
    ) {
      phaseErrors.push('Invalid or out-of-order phase')
      continue
    }
    previous = ordinal
    phases.push({ phase: entry.phase, at: entry.at })
  }
  return {
    exitCode: result.code,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    outputTruncated: result.outputTruncated === true,
    timeoutMs,
    terminationVerified,
    phases,
    phaseErrors
  }
}

export function benchmarkChildSample(result, receipt) {
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    parsed = undefined
  }
  const structured = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  const failure = (status, reason, extra = {}) => ({
    status,
    reason,
    ...(structured ? { childResult: parsed } : {}),
    ...extra,
    process: receipt
  })
  if (receipt.timedOut) {
    return failure('infrastructure-timeout', 'Child watchdog expired', {
      lastPhase: receipt.phases.at(-1)?.phase ?? 'unknown'
    })
  }
  if (!receipt.terminationVerified) {
    return failure('infrastructure-termination-unknown', 'Child termination not verified')
  }
  if (receipt.exitCode !== 0 || receipt.signal !== null || receipt.outputTruncated) {
    return failure('failed', 'Child failed or output truncated', { exitCode: receipt.exitCode })
  }
  if (!structured || typeof parsed.status !== 'string') {
    return failure('failed', 'Missing structured child result')
  }
  if (receipt.phaseErrors.length) {
    return failure('failed', 'Invalid child phase evidence')
  }
  return { ...parsed, process: receipt }
}
