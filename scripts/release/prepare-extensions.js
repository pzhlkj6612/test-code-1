// SPDX-License-Identifier: Apache-2.0
'use strict'

const { prepareExtensions } = require('./package-extensions')

Promise.resolve().then(() => {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/release/prepare-extensions.js')
  return prepareExtensions()
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
