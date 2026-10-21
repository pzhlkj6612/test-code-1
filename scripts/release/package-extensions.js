// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  validateVersion, TARGETS, ROOT, config, run, writeJson, verifyArchitecture,
  sha256, parseChecksum, download,
} = require('./package-utils')

function validateExtensions(extensions = config.extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) throw new Error('Expected nonempty extensions array')
  const ids = new Set()
  for (const extension of extensions) {
    if (!extension || !/^[\w.-]+\/[\w.-]+$/.test(extension.repository || '') ||
        !/^[\w-]+\.[\w-]+$/.test(extension.id || '')) {
      throw new Error('Invalid extension repository or id')
    }
    validateVersion(extension.version)
    const id = extension.id.toLowerCase()
    if (ids.has(id)) throw new Error(`Duplicate extension id: ${extension.id}`)
    ids.add(id)
    if (extension.source === 'release') {
      if (!/^[\w.-]+\.vsix$/.test(extension.asset || '') || !/^[a-f0-9]{64}$/.test(extension.sha256 || '')) {
        throw new Error(`Invalid release asset/checksum for ${extension.id}`)
      }
    } else if (extension.source === 'build') {
      if (extension.repository !== 'kendryte/canmv-vscode-extension' ||
          !/^[a-f0-9]{40}$/.test(extension.commit || '')) {
        throw new Error(`Unsupported source build or invalid commit for ${extension.id}`)
      }
    } else {
      throw new Error(`Invalid extension source: ${extension.source}`)
    }
  }
  return extensions
}

function extensionAsset(extension) {
  return extension.source === 'release' ? extension.asset
    : `${extension.id}-${extension.version}-${extension.commit}.vsix`
}

function verifyExtension(directory, extension) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  if (`${manifest.publisher}.${manifest.name}`.toLowerCase() !== extension.id.toLowerCase() ||
      manifest.version !== extension.version) {
    throw new Error(`Unexpected extension identity/version: ${extension.id}`)
  }
}

function buildCanmvExtension(extension, directory, output) {
  const source = path.join(directory, 'source')
  run('git', ['init', source])
  run('git', ['-C', source, 'remote', 'add', 'origin', `https://github.com/${extension.repository}.git`])
  run('git', ['-C', source, 'fetch', '--depth=1', 'origin', extension.commit])
  run('git', ['-C', source, 'checkout', '--detach', extension.commit])
  const extensionRoot = path.join(source, 'extension')
  verifyExtension(extensionRoot, extension)
  run('npm', ['ci'], { cwd: extensionRoot })
  run('npm', ['run', 'compile'], { cwd: extensionRoot })
  for (const target of TARGETS) {
    const executable = target.platform === 'win32' ? 'canmv-backend.exe' : 'canmv-backend'
    const backend = path.join(extensionRoot, 'bin', `${target.platform}-${target.arch}`, executable)
    fs.mkdirSync(path.dirname(backend), { recursive: true })
    run('go', ['build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', backend, './cmd/canmv-backend'], {
      cwd: path.join(source, 'native/go'),
      env: { ...process.env, GOOS: target.platform === 'win32' ? 'windows' : target.platform,
        GOARCH: target.arch === 'x64' ? 'amd64' : target.arch, CGO_ENABLED: '0' },
    })
    verifyArchitecture(backend, target)
    fs.chmodSync(backend, 0o755)
  }
  writeJson(path.join(extensionRoot, 'build-info.json'), {
    version: extension.version, commit: extension.commit, shortCommit: extension.commit.slice(0, 7), dirty: false,
  })
  run(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--no-dependencies', '-o', output], {
    cwd: extensionRoot,
  })
}

async function prepareExtensions() {
  if (process.platform !== 'linux') throw new Error('Prepare bundled extensions on a Linux host')
  const extensions = validateExtensions()
  const cache = path.join(ROOT, '.cache/extensions')
  fs.mkdirSync(cache, { recursive: true })
  for (const extension of extensions) {
    const name = extensionAsset(extension)
    const output = path.join(cache, name)
    if (extension.source === 'release') {
      await download(`https://github.com/${extension.repository}/releases/download/${extension.version}/${extension.asset}`,
        output, extension.sha256)
    } else {
      const directory = fs.mkdtempSync(path.join(cache, 'canmv-build-'))
      try {
        buildCanmvExtension(extension, directory, path.join(directory, name))
        fs.renameSync(path.join(directory, name), output)
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
    fs.writeFileSync(`${output}.sha256`, `${await sha256(output)}  ${name}\n`)
  }
}

async function installExtensions(appRoot, build, target, cache = path.join(ROOT, '.cache/extensions')) {
  for (const extension of validateExtensions()) {
    const name = extensionAsset(extension)
    const vsix = path.join(cache, name)
    const expected = extension.source === 'release' ? extension.sha256
      : parseChecksum(fs.readFileSync(`${vsix}.sha256`, 'utf8'), name)
    if (await sha256(vsix) !== expected) throw new Error(`Bundled extension checksum mismatch: ${name}`)
    const temporary = fs.mkdtempSync(path.join(build, 'vsix-'))
    try {
      run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'zipfile', '-e', vsix, temporary])
      const directory = path.join(temporary, 'extension')
      verifyExtension(directory, extension)
      if (extension.source === 'build') {
        const info = JSON.parse(fs.readFileSync(path.join(directory, 'build-info.json'), 'utf8'))
        if (info.commit !== extension.commit) throw new Error(`Unexpected source commit for ${extension.id}`)
        const backend = path.join(directory, 'bin', `${target.platform}-${target.arch}`,
          target.platform === 'win32' ? 'canmv-backend.exe' : 'canmv-backend')
        verifyArchitecture(backend, target)
        // ZIP extraction does not retain Unix executable permissions.
        if (target.platform !== 'win32') fs.chmodSync(backend, 0o755)
      }
      fs.cpSync(directory, path.join(appRoot, 'extensions', extension.id.toLowerCase()), { recursive: true })
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }
}

module.exports = { validateExtensions, extensionAsset, verifyExtension, prepareExtensions, installExtensions }
