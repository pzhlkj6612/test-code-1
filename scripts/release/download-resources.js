// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { config, resourcePath, validateResources } = require('./package-utils')

async function checksum(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(resource) {
  const destination = resourcePath(resource)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (!fs.existsSync(destination)) {
    const response = await fetch(resource.url, { signal: AbortSignal.timeout(600000) })
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${resource.url}`)
    const temporary = `${destination}.part`
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary))
      const actual = await checksum(temporary)
      if (actual !== resource.sha256) {
        throw new Error(`Checksum mismatch for ${resource.id}: expected ${resource.sha256}, got ${actual}`)
      }
      fs.renameSync(temporary, destination)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  } else {
    const actual = await checksum(destination)
    if (actual !== resource.sha256) {
      throw new Error(`Checksum mismatch for ${resource.id}: expected ${resource.sha256}, got ${actual}`)
    }
  }
}

async function main(args) {
  validateResources()
  let resources = config.resources.filter((resource) => resource.type === 'file')
  if (args.length === 2 && args[0] === '--id') {
    resources = resources.filter((resource) => resource.id === args[1])
    if (resources.length !== 1) throw new Error(`Unknown file resource: ${args[1]}`)
  } else if (args.length === 4 && args[0] === '--target' && args[2] === '--arch') {
    resources = resources.filter((resource) => resource.platform === args[1] && resource.arch === args[3])
    if (resources.length !== 1) throw new Error(`No file resource for ${args[1]}-${args[3]}`)
  } else if (args.length) {
    throw new Error('Usage: node scripts/release/download-resources.js [--id <id> | --target <platform> --arch <arch>]')
  }
  for (const resource of resources) await download(resource)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { download, main }
