// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  ROOT, config, metadata, targetFor, validateVersion, resourceForTarget, resourceById, resourcePath,
  outputAsset, run, sha256, macExecutable, verifyArchitecture,
} = require('./package-utils')
const { installExtensions } = require('./package-extensions')
const { overlay, rebrand } = require('./package-branding')

async function packageTarget(target) {
  const version = config.releaseVersion
  validateVersion(version)
  const requiredHost = target.platform === 'darwin' ? 'darwin' : target.platform === 'win32' ? 'win32' : 'linux'
  if (process.platform !== requiredHost) throw new Error(`Package ${target.platform} on a ${requiredHost} host`)
  const cache = path.join(ROOT, '.cache')
  fs.mkdirSync(cache, { recursive: true })
  const input = resourceForTarget(target)
  const archive = resourcePath(input)
  if (!fs.existsSync(archive)) throw new Error(`Missing downloaded resource: ${input.id}`)

  const build = path.join(ROOT, 'build', `${target.platform}-${target.arch}`)
  fs.rmSync(build, { recursive: true, force: true })
  const extracted = path.join(build, 'app')
  fs.mkdirSync(extracted, { recursive: true })
  if (target.platform === 'linux') run('tar', ['-xzf', archive, '-C', extracted])
  else if (target.platform === 'darwin') run('ditto', ['-x', '-k', archive, extracted])
  else run('python', ['-m', 'zipfile', '-e', archive, extracted])
  const appDir = target.platform === 'darwin'
    ? path.join(extracted, 'VSCodium.app') : extracted
  const appRoot = path.join(appDir, target.platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app')
  const executable = target.platform === 'darwin' ? macExecutable(appDir)
    : path.join(appDir, target.platform === 'win32' ? 'VSCodium.exe' : 'codium')
  verifyArchitecture(executable, target)
  overlay(appRoot, target)
  await installExtensions(appRoot, build, target)
  rebrand(appDir, appRoot, target)
  fs.writeFileSync(path.join(extracted, 'README-ruyisdk-ide-overlay.txt'), `RuyiSDK IDE ${version}
Based on checksum-verified upstream editor ${config.baseVersion}.
Bundled extensions:
${config.extensions.map((extension) => {
    const resource = extension.source === 'build' ? resourceById(extension.resource) : undefined
    return `${extension.id}: ${extension.version}${resource ? ` (source ${resource.commit})` : ''}`
  }).join('\n')}
The startup editor default is none; user settings still override it.
Editor auto-updates are disabled; install new RuyiSDK IDE releases manually.
Upstream licenses and third-party notices are retained.
${target.platform === 'darwin' ? 'This macOS application is ad-hoc signed only, NOT Developer ID signed or notarized. Gatekeeper may block it.\n' : ''}`)
  const dist = path.join(ROOT, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  const output = path.join(dist, outputAsset(target, version))
  fs.rmSync(output, { force: true })
  if (target.platform === 'linux') run('tar', ['-czf', output, '-C', extracted, '.'])
  else if (target.platform === 'win32') {
    run('python', ['-c', 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])', output.slice(0, -4), extracted])
  } else {
    fs.renameSync(appDir, path.join(extracted, `${metadata.productName}.app`))
    fs.symlinkSync('/Applications', path.join(extracted, 'Applications'))
    run('hdiutil', ['create', '-volname', metadata.productName, '-srcfolder', extracted, '-ov', '-format', 'UDZO', output])
    run('hdiutil', ['verify', output])
  }
  fs.writeFileSync(`${output}.sha256`, `${await sha256(output)}  ${path.basename(output)}\n`)
  console.log(`Packaged ${output}`)
}

if (require.main === module) {
  const [platform, arch, ...extra] = process.argv.slice(2)
  Promise.resolve().then(() => {
    if (extra.length) throw new Error('Usage: node scripts/release/package.js <linux|win32|darwin> <arch>')
    return packageTarget(targetFor(platform, arch))
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
