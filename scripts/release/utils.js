// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')

async function sha256(file) {
  const hash = crypto.createHash('sha256').setEncoding('hex')
  await pipeline(fs.createReadStream(file), hash)
  return hash.read()
}

module.exports = { sha256 }
