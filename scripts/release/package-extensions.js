// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const AdmZip = require('adm-zip')
const {
  validateVersion, TARGETS, ROOT, config, run, writeJson, verifyArchitecture,
  resourceById, resourcePath,
} = require('./package-utils')

function validateExtensions(extensions = config.extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new Error('Expected nonempty extensions array')
  }
  const ids = new Set()
  for (const extension of extensions) {
    if (!extension || !/^[\w-]+\.[\w-]+$/.test(extension.id || '')) {
      throw new Error('Invalid extension id')
    }
    validateVersion(extension.version)
    const id = extension.id.toLowerCase()
    if (ids.has(id)) {
      throw new Error(`Duplicate extension id: ${extension.id}`)
    }
    ids.add(id)
    if (!['build', 'prebuilt'].includes(extension.source)) {
      throw new Error(`Invalid extension source: ${extension.source}`)
    }
    const resource = resourceById(extension.resource)
    if (extension.source === 'build' && (resource.type !== 'git'
      || typeof extension.sourceDirectory !== 'string' || path.isAbsolute(extension.sourceDirectory)
      || extension.sourceDirectory.split(/[\\/]/).includes('..'))) {
      throw new Error(`Invalid source resource for ${extension.id}`)
    }
    if (extension.source === 'prebuilt' && resource.type !== 'file') {
      throw new Error(`Invalid prebuilt resource for ${extension.id}`)
    }
  }
  return extensions
}

function extensionAsset(extension) {
  const resource = resourceById(extension.resource)
  return extension.source === 'prebuilt'
    ? path.basename(resource.path)
    : `${extension.id}-${extension.version}-${resource.commit}.vsix`
}

function verifyExtension(directory, extension) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  if (`${manifest.publisher}.${manifest.name}`.toLowerCase() !== extension.id.toLowerCase()
    || manifest.version !== extension.version) {
    throw new Error(`Unexpected extension identity/version: ${extension.id}`)
  }
}

function buildCanmvExtension(extension, source, output) {
  const resource = resourceById(extension.resource)
  const extensionRoot = path.join(source, extension.sourceDirectory)
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
    version: extension.version, commit: resource.commit, shortCommit: resource.commit.slice(0, 7), dirty: false,
  })
  run(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--no-dependencies', '-o', output], {
    cwd: extensionRoot,
  })
}

function prepareExtensions() {
  if (process.platform !== 'linux') {
    throw new Error('Prepare bundled extensions on a Linux host')
  }
  const extensions = validateExtensions()
  const cache = path.join(ROOT, '.cache/extensions')
  fs.mkdirSync(cache, { recursive: true })

  for (const extension of extensions) {
    const name = extensionAsset(extension)
    const output = path.join(cache, name)

    if (extension.source === 'prebuilt') {
      const resource = resourceById(extension.resource)
      const downloaded = resourcePath(resource)
      if (!fs.existsSync(downloaded)) {
        throw new Error(`Missing downloaded resource: ${resource.id}`)
      }
      if (path.resolve(downloaded) !== path.resolve(output)) {
        fs.copyFileSync(downloaded, output)
      }
    } else {
      using directory = fs.mkdtempDisposableSync(path.join(cache, 'canmv-build-'))
      const source = resourcePath(resourceById(extension.resource))
      if (!fs.existsSync(source)) {
        throw new Error(`Missing workflow-cloned source repository: ${source}`)
      }
      buildCanmvExtension(extension, source, path.join(directory.path, name))
      fs.renameSync(path.join(directory.path, name), output)
    }
  }
}

function installExtensions(appRoot, build, target, cache = path.join(ROOT, '.cache/extensions')) {
  for (const extension of validateExtensions()) {
    const name = extensionAsset(extension)
    const vsix = path.join(cache, name)
    using temporary = fs.mkdtempDisposableSync(path.join(build, 'vsix-'))
    new AdmZip(vsix).extractAllTo(temporary.path, true)
    const directory = path.join(temporary.path, 'extension')

    verifyExtension(directory, extension)

    if (extension.source === 'build') {
      const resource = resourceById(extension.resource)
      const info = JSON.parse(fs.readFileSync(path.join(directory, 'build-info.json'), 'utf8'))
      if (info.commit !== resource.commit) {
        throw new Error(`Unexpected source commit for ${extension.id}`)
      }
      const backend = path.join(directory, 'bin', `${target.platform}-${target.arch}`,
        target.platform === 'win32' ? 'canmv-backend.exe' : 'canmv-backend')

      verifyArchitecture(backend, target)

      // ZIP extraction does not retain Unix executable permissions.
      if (target.platform !== 'win32') {
        fs.chmodSync(backend, 0o755)
      }
    }

    fs.cpSync(directory, path.join(appRoot, 'extensions', extension.id.toLowerCase()), { recursive: true })
  }
}

module.exports = { validateExtensions, extensionAsset, verifyExtension, prepareExtensions, installExtensions }
