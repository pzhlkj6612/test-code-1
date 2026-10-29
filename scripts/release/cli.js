// SPDX-License-Identifier: Apache-2.0
'use strict'

const { Command, CommanderError } = require('commander')

function createProgram(name, description, output = {}) {
  return new Command(name)
    .description(description)
    .exitOverride()
    .configureOutput(output)
}

function runCli(main) {
  Promise.try(main, process.argv.slice(2)).catch((error) => {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode
    } else {
      console.error(error)
      process.exitCode = 1
    }
  })
}

module.exports = { createProgram, runCli }
