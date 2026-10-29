// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const simplePlist = require('simple-plist')
const config = require('../../config/release.json')
const metadata = require('../../config/product-overrides.json')

const ROOT = path.resolve(__dirname, '../..')
const TARGETS = [
  { platform: 'darwin', arch: 'arm64', runner: 'macos-14', format: 'dmg' },
  { platform: 'win32', arch: 'x64', runner: 'windows-2022', format: 'zip' },
  { platform: 'win32', arch: 'arm64', runner: 'windows-2022', format: 'zip' },
  { platform: 'linux', arch: 'arm64', runner: 'ubuntu-22.04', format: 'tar.gz' },
  { platform: 'linux', arch: 'x64', runner: 'ubuntu-22.04', format: 'tar.gz' },
  { platform: 'linux', arch: 'riscv64', runner: 'ubuntu-22.04', format: 'tar.gz' },
]

function targetFor(platform, arch) {
  const target = TARGETS.find((entry) => entry.platform === platform && entry.arch === arch)
  if (!target) throw new Error(`Unsupported target: ${platform}-${arch}`)
  return target
}

function validateVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`)
  }
  return version
}

function resourceForTarget(target) {
  const input = config.resources.find((entry) =>
    entry.type === 'file' &&
    entry.platform === target.platform && entry.arch === target.arch)
  if (!input) throw new Error(`Missing file resource for ${target.platform}-${target.arch}`)
  return input
}

function resourceById(id) {
  const resource = config.resources.find((entry) => entry.id === id)
  if (!resource) throw new Error(`Unknown resource: ${id}`)
  return resource
}

function resourcePath(resource) {
  const resolved = path.resolve(ROOT, resource.path)
  if (!resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error(`Resource path escapes workspace: ${resource.path}`)
  return resolved
}

function validateResources(resources = config.resources) {
  if (!Array.isArray(resources) || resources.length === 0) throw new Error('Expected nonempty resources array')
  const ids = new Set()
  const paths = new Set()
  for (const resource of resources) {
    if (!resource || !/^[\w.-]+$/.test(resource.id || '') ||
        !['file', 'git'].includes(resource.type) || typeof resource.path !== 'string') {
      throw new Error('Invalid resource definition')
    }
    if (ids.has(resource.id)) throw new Error(`Duplicate resource id: ${resource.id}`)
    ids.add(resource.id)
    const resolved = resourcePath(resource)
    if (paths.has(resolved)) throw new Error(`Duplicate resource path: ${resource.path}`)
    paths.add(resolved)
    let url
    try {
      url = new URL(resource.url)
    } catch {
      throw new Error(`Invalid resource URL: ${resource.id}`)
    }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`Invalid resource URL: ${resource.id}`)
    if (resource.type === 'file') {
      if (!/^[a-f0-9]{64}$/.test(resource.sha256 || '')) throw new Error(`Invalid resource checksum: ${resource.id}`)
      if (resource.commit !== undefined) throw new Error(`File resource has a commit: ${resource.id}`)
    } else if (!/^[a-f0-9]{40}$/.test(resource.commit || '') || resource.sha256 !== undefined) {
      throw new Error(`Invalid repository resource pin: ${resource.id}`)
    }
  }
  return resources
}

function outputAsset(target, version) {
  validateVersion(version)
  const suffix = target.platform === 'darwin' ? '-unsigned' : ''
  return `${metadata.applicationName}-${target.platform}-${target.arch}-${version}${suffix}.${target.format}`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}

function parseChecksum(text, asset) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length !== 1) throw new Error(`Expected one checksum for ${asset}`)
  const match = /^([a-fA-F0-9]{64})(?:[ \t]+\*?(.+))?$/.exec(lines[0])
  if (!match || (match[2] && match[2] !== asset && match[2] !== `./${asset}`)) {
    throw new Error(`Invalid checksum file for ${asset}`)
  }
  return match[1].toLowerCase()
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function macExecutable(appDir) {
  const plist = path.join(appDir, 'Contents/Info.plist')
  let name
  try {
    name = simplePlist.readFileSync(plist)?.CFBundleExecutable
  } catch (error) {
    throw new Error(`Cannot read CFBundleExecutable from ${plist}: ${error.message}`, { cause: error })
  }
  if (name === undefined) throw new Error(`Cannot read CFBundleExecutable from ${plist}`)
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\r\n]/.test(name)) {
    throw new Error(`Invalid CFBundleExecutable in ${plist}: ${name}`)
  }
  return path.join(appDir, 'Contents/MacOS', name)
}

function verifyArchitecture(file, target) {
  const descriptor = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(64)
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error(`Truncated executable: ${file}`)
    }
    let valid = false
    if (target.platform === 'linux') {
      const machine = { x64: 62, arm64: 183, riscv64: 243 }[target.arch]
      valid = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === machine
    } else if (target.platform === 'win32') {
      const pe = Buffer.alloc(6)
      const size = fs.readSync(descriptor, pe, 0, pe.length, header.readUInt32LE(60))
      valid = header.toString('ascii', 0, 2) === 'MZ' && size === pe.length &&
        pe.readUInt32LE(0) === 0x00004550 &&
        pe.readUInt16LE(4) === { x64: 0x8664, arm64: 0xaa64 }[target.arch]
    } else {
      valid = header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c
    }
    if (!valid) throw new Error(`Executable does not match ${target.platform}-${target.arch}: ${file}`)
  } finally {
    fs.closeSync(descriptor)
  }
}

module.exports = {
  ROOT, TARGETS, config, metadata, targetFor, validateVersion, resourceForTarget, resourceById,
  resourcePath, validateResources, outputAsset,
  run, parseChecksum, writeJson, macExecutable, verifyArchitecture,
}
