// SPDX-License-Identifier: Apache-2.0
'use strict'

const { Command, CommanderError } = require('commander')

// Commander throws instead of calling process.exit() so callers (and tests) can
// inspect parse results and failures.
function createProgram(name, description, output = {}) {
  return new Command(name)
    .description(description)
    .exitOverride()
    .configureOutput(output)
}

function runCli(main) {
  Promise.resolve().then(() => main(process.argv.slice(2))).catch((error) => {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode
    } else {
      console.error(error)
      process.exitCode = 1
    }
  })
}

module.exports = { createProgram, runCli }
