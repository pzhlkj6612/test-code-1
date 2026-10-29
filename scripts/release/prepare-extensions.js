// SPDX-License-Identifier: Apache-2.0
'use strict'

const { prepareExtensions } = require('./package-extensions')
const { createProgram, runCli } = require('./cli')

function parseArguments(argv, output) {
  createProgram('prepare-extensions.js', 'Build or copy every bundled extension into .cache/extensions', output)
    .parse(argv, { from: 'user' })
  return {}
}

function main(argv) {
  parseArguments(argv)
  return prepareExtensions()
}

if (require.main === module) runCli(main)

module.exports = { parseArguments, main }
