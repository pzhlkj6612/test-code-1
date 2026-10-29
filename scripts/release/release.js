// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const config = require('../../config/release.json')
const { TARGETS, validateVersion, outputAsset, parseChecksum, resourceById } = require('./package-utils')
const { sha256 } = require('./utils')
const { validateExtensions } = require('./package-extensions')
const { createProgram, runCli } = require('./cli')

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
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Expected exactly six packages and six checksums; found: ${actual.join(', ')}`)
  }
  for (const target of TARGETS) {
    const name = outputAsset(target, version)
    const file = path.join(directory, name)
    const stats = fs.statSync(file)
    if (!stats.isFile() || stats.size === 0) throw new Error(`Empty or invalid package: ${name}`)
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

function parseArguments(argv, output) {
  let parsed
  const program = createProgram('release.js', 'Validate, verify and describe a RuyiSDK IDE release', output)
  program.command('check')
    .description('Validate saved GitHub release state and append the release matrix to an output file')
    .argument('<release-state>', 'JSON file with releaseExists and tagExists booleans')
    .argument('<output-file>', 'GitHub Actions output file to append the matrix to')
    .action((releaseState, outputFile) => { parsed = { command: 'check', releaseState, output: outputFile } })
  program.command('verify')
    .description('Verify that a directory contains exactly the expected packages and checksums')
    .argument('<artifact-directory>', 'directory containing release packages')
    .action((directory) => { parsed = { command: 'verify', directory } })
  program.command('notes')
    .description('Write release notes')
    .argument('<output-file>', 'file to write the release notes to')
    .action((outputFile) => { parsed = { command: 'notes', output: outputFile } })
  program.parse(argv, { from: 'user' })
  return parsed
}

async function main(argv) {
  const args = parseArguments(argv)
  if (args.command === 'check') {
    const result = check(JSON.parse(fs.readFileSync(args.releaseState, 'utf8')))
    fs.appendFileSync(args.output, `matrix=${JSON.stringify(result)}\n`)
  } else if (args.command === 'verify') {
    await verifyArtifacts(path.resolve(args.directory))
  } else {
    fs.writeFileSync(args.output, `${releaseNotes()}\n`)
  }
}

if (require.main === module) runCli(main)

module.exports = { validateReleaseRequest, check, verifyArtifacts, releaseNotes, parseArguments, main }
