// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
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

function clone(resource) {
  const destination = resourcePath(resource)
  if (fs.existsSync(destination)) {
    const commit = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    if (commit !== resource.commit) {
      throw new Error(`Prepared repository ${resource.id} is at ${commit}, expected ${resource.commit}`)
    }
    return
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), `.${path.basename(destination)}-`))
  const checkout = path.join(temporary, 'checkout')
  try {
    execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', resource.url, checkout], {
      stdio: 'inherit',
    })
    execFileSync('git', ['-C', checkout, 'fetch', '--depth=1', 'origin', resource.commit], {
      stdio: 'inherit',
    })
    execFileSync('git', ['-C', checkout, 'checkout', '--detach', resource.commit], {
      stdio: 'inherit',
    })
    const commit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    if (commit !== resource.commit) throw new Error(`Expected ${resource.commit}, checked out ${commit}`)
    fs.renameSync(checkout, destination)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function selectResources(args) {
  if (args.length === 1 && args[0] === '--all') return config.resources
  if (args.length === 1 && args[0] === '--extensions') {
    const ids = new Set(config.extensions.map((extension) => extension.resource))
    return config.resources.filter((resource) => ids.has(resource.id))
  }
  if (args.length === 3 && args[0] === '--target' && args[1] && args[2]) {
    const matches = config.resources.filter((resource) =>
      resource.type === 'file' && resource.platform === args[1] && resource.arch === args[2])
    if (matches.length !== 1) throw new Error(`No file resource for ${args[1]}-${args[2]}`)
    return matches
  }
  throw new Error('Usage: node scripts/release/prepare-inputs.js --all | --extensions | --target <platform> <arch>')
}

async function main(args) {
  validateResources()
  const resources = selectResources(args)
  for (const resource of resources) {
    if (resource.type === 'file') await download(resource)
    else clone(resource)
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { checksum, download, clone, selectResources, main }
