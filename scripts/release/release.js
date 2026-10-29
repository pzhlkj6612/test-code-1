// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const config = require('../../config/release.json')
const { TARGETS, validateVersion, outputAsset, parseChecksum, sha256, resourceById } = require('./package-utils')
const { validateExtensions } = require('./package-extensions')

function validateReleaseRequest(ref, version) {
  if (ref !== 'refs/heads/main') throw new Error('Manual releases must run on the main branch')
  validateVersion(version)
  if (version !== config.releaseVersion) {
    throw new Error(`Requested version ${version} does not match configured releaseVersion ${config.releaseVersion}`)
  }
}

function check(releaseState) {
  const version = config.releaseVersion
  validateVersion(version)
  if (!releaseState || typeof releaseState !== 'object' ||
      typeof releaseState.releaseExists !== 'boolean' ||
      typeof releaseState.tagExists !== 'boolean') {
    throw new Error('Invalid release state')
  }
  if (releaseState.releaseExists) {
    throw new Error(`Release ${version} already exists; use a new downstream version`)
  }
  if (releaseState.tagExists) {
    throw new Error(`Tag ${version} already exists; use a new downstream version`)
  }
  return { include: TARGETS }
}

async function verifyArtifacts(directory) {
  const version = config.releaseVersion
  validateVersion(version)
  const expected = TARGETS.flatMap((target) => {
    const name = outputAsset(target, version)
    return [name, `${name}.sha256`]
  }).sort()
  const actual = fs.readdirSync(directory).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected exactly six packages and six checksums; found: ${actual.join(', ')}`)
  }
  for (const target of TARGETS) {
    const name = outputAsset(target, version)
    const file = path.join(directory, name)
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(`Empty or invalid package: ${name}`)
    const expectedHash = parseChecksum(fs.readFileSync(`${file}.sha256`, 'utf8'), name)
    if (await sha256(file) !== expectedHash) throw new Error(`Release artifact checksum mismatch: ${name}`)
  }
  return expected
}

function releaseNotes() {
  const version = config.releaseVersion
  validateVersion(version)
  const extensions = validateExtensions()
  return `RuyiSDK IDE ${version}, based on upstream editor ${config.baseVersion}.

Includes the RuyiSDK IDE home launcher and:
${extensions.map((extension) => {
    const resource = extension.source === 'build' ? resourceById(extension.resource) : undefined
    return `- ${extension.id} ${extension.version}${resource ? ` (built from ${resource.commit})` : ''}`
  }).join('\n')}
All six packages include SHA-256 checksums.

**macOS arm64: the DMG is unsigned/unnotarized (the app has only an ad-hoc signature). Gatekeeper may block it.**
Windows ZIPs retain upstream executable icons and embedded version resources.
Editor auto-updates are disabled to prevent replacement by VSCodium; install subsequent RuyiSDK IDE releases manually.`
}

if (require.main === module) {
  const [command, argument, output, ...extra] = process.argv.slice(2)
  Promise.resolve().then(async () => {
    if (extra.length) throw new Error('Too many arguments')
    if (command === 'check' && argument && output) {
      const result = check(JSON.parse(fs.readFileSync(argument, 'utf8')))
      fs.appendFileSync(output, `matrix=${JSON.stringify(result)}\n`)
    } else if (command === 'verify' && argument) {
      await verifyArtifacts(path.resolve(argument))
    } else if (command === 'notes' && argument) {
      fs.writeFileSync(argument, `${releaseNotes()}\n`)
    } else {
      throw new Error('Usage: node scripts/release/release.js check <release-state.json> <output-file> | verify <artifact-directory> | notes <output-file>')
    }
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { validateReleaseRequest, check, verifyArtifacts, releaseNotes }
