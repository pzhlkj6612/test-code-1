// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const { TARGETS, validateResources } = require('./package-utils')
const { validateReleaseRequest } = require('./release')
const { createProgram, runCli } = require('./cli')

function parseArguments(argv, output) {
  const program = createProgram('configure-workflow.js',
    'Validate the release request and append the packaging matrix to a GitHub Actions output file', output)
    .argument('<output-file>', 'GitHub Actions output file to append the matrix to')
    .option('--event <name>', 'triggering GitHub event name', '')
    .option('--ref <ref>', 'triggering Git ref', '')
    .option('--default-branch <name>', 'repository default branch that manual releases must run on', '')
    .option('--requested-version <version>', 'release version requested by a manual run', '')
  program.parse(argv, { from: 'user' })
  return { output: program.args[0], ...program.opts() }
}

function main(argv) {
  const { output, event, ref, defaultBranch, requestedVersion } = parseArguments(argv)
  validateResources()
  if (event === 'workflow_dispatch' && requestedVersion) validateReleaseRequest(ref, requestedVersion, defaultBranch)
  fs.appendFileSync(output, `matrix=${JSON.stringify({ include: TARGETS })}\n`)
}

if (require.main === module) runCli(main)

module.exports = { parseArguments, main }
