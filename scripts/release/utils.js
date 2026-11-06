// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { pipeline } = require('node:stream/promises')

async function sha256(file) {
  const hash = crypto.createHash('sha256').setEncoding('hex')
  await pipeline(fs.createReadStream(file), hash)
  return hash.read()
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status})`)
  }
  return result
}

module.exports = { sha256, run }
