// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { config, resourcePath, validateResources } = require('./package-utils')
const { sha256 } = require('./utils')
const { createProgram, runCli } = require('./cli')

async function download(resource) {
  const destination = resourcePath(resource)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (!fs.existsSync(destination)) {
    const response = await fetch(resource.url, { signal: AbortSignal.timeout(600000) })
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${resource.url}`)
    const temporary = `${destination}.part`
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary))
      const actual = await sha256(temporary)
      if (actual !== resource.sha256) {
        throw new Error(`Checksum mismatch for ${resource.id}: expected ${resource.sha256}, got ${actual}`)
      }
      fs.renameSync(temporary, destination)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  } else {
    const actual = await sha256(destination)
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
  using temporary = fs.mkdtempDisposableSync(path.join(path.dirname(destination), `.${path.basename(destination)}-`))
  const checkout = path.join(temporary.path, 'checkout')

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
}

function parseArguments(argv, output) {
  let parsed
  const program = createProgram('prepare-inputs.js',
    'Download and verify pinned files, and clone pinned repositories, from config/release.json', output)
  program.command('all')
    .description('prepare every configured resource')
    .action(() => { parsed = { selection: 'all' } })
  program.command('extensions')
    .description('prepare resources referenced by bundled extensions')
    .action(() => { parsed = { selection: 'extensions' } })
  program.command('target')
    .description('prepare the upstream archive for one packaging target')
    .argument('<platform>', 'target platform')
    .argument('<arch>', 'target architecture')
    .action((platform, arch) => { parsed = { selection: 'target', platform, arch } })
  program.parse(argv, { from: 'user' })
  return parsed
}

function selectResources({ selection, platform, arch }) {
  if (selection === 'all') return config.resources
  if (selection === 'extensions') {
    const ids = new Set(config.extensions.map((extension) => extension.resource))
    return config.resources.filter((resource) => ids.has(resource.id))
  }
  const matches = config.resources.filter((resource) =>
    resource.type === 'file' && resource.platform === platform && resource.arch === arch)
  if (matches.length !== 1) throw new Error(`No file resource for ${platform}-${arch}`)
  return matches
}

async function main(argv) {
  const selection = parseArguments(argv)
  validateResources()
  for (const resource of selectResources(selection)) {
    if (resource.type === 'file') await download(resource)
    else clone(resource)
  }
}

if (require.main === module) runCli(main)

module.exports = { download, clone, parseArguments, selectResources, main }
