// Fixture-only acceptance barrier: the native input has already been read and logged.
const { existsSync } = require('node:fs')
const { join } = require('node:path')
exports.afterAcceptanceRelease = (directory, agent, deliver) => {
  if (!directory || !existsSync(join(directory, `${agent}.hold`))) {
    deliver()
    return
  }
  const timer = setInterval(() => {
    if (!existsSync(join(directory, `${agent}.hold`))) {
      clearInterval(timer)
      deliver()
    }
  }, 25)
  timer.unref()
  process.stdin.once('end', () => clearInterval(timer))
}
