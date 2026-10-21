// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
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

function upstreamAsset(target) {
  const format = target.platform === 'linux' ? 'tar.gz' : 'zip'
  return `VSCodium-${target.platform}-${target.arch}-${config.vscodiumVersion}.${format}`
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

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
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

async function download(url, destination, expected) {
  if (!fs.existsSync(destination)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) })
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
    const temporary = `${destination}.part`
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary))
      fs.renameSync(temporary, destination)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  const actual = await sha256(destination)
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${path.basename(destination)}: expected ${expected}, got ${actual}. Remove the cached file before retrying.`)
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function macExecutable(appDir) {
  const plist = path.join(appDir, 'Contents/Info.plist')
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'import plistlib,sys; print(plistlib.load(open(sys.argv[1], "rb"))["CFBundleExecutable"])',
    plist], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cannot read CFBundleExecutable from ${plist}: ${result.stderr.trim()}`)
  const name = result.stdout.trim()
  if (!name || name === '.' || name === '..' || /[/\\\r\n]/.test(name)) {
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
  ROOT, TARGETS, config, metadata, targetFor, validateVersion, upstreamAsset, outputAsset,
  run, sha256, parseChecksum, download, writeJson, macExecutable, verifyArchitecture,
}
