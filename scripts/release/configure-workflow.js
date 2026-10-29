// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const { TARGETS, validateResources } = require('./package-utils')
const { validateReleaseRequest } = require('./release')

validateResources()
if (process.env.RUN_EVENT === 'workflow_dispatch' && process.env.REQUESTED_VERSION) {
  validateReleaseRequest(process.env.RUN_REF, process.env.REQUESTED_VERSION)
}
const output = process.argv[2]
if (!output) throw new Error('Usage: node scripts/release/configure-workflow.js <output-file>')
fs.appendFileSync(output, `matrix=${JSON.stringify({ include: TARGETS })}\n`)
