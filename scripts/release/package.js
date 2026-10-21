// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  ROOT, config, metadata, targetFor, validateVersion, upstreamAsset, outputAsset,
  run, sha256, parseChecksum, download, macExecutable, verifyArchitecture,
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
  const asset = upstreamAsset(target)
  const url = `https://github.com/VSCodium/vscodium/releases/download/${config.vscodiumVersion}/${asset}`
  const checksumResponse = await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(60000) })
  if (!checksumResponse.ok) throw new Error(`Missing upstream checksum: ${checksumResponse.status} ${asset}`)
  const checksumText = await checksumResponse.text()
  const archive = path.join(cache, asset)
  await download(url, archive, parseChecksum(checksumText, asset))

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
Based on checksum-verified VSCodium ${config.vscodiumVersion}.
Bundled extensions:
${config.extensions.map((extension) => `${extension.id}: ${extension.version}${extension.source === 'build' ? ` (source ${extension.commit})` : ''}`).join('\n')}
The startup editor default is none; user settings still override it.
Editor auto-updates are disabled; install new RuyiSDK IDE releases manually.
Upstream licenses and third-party notices are retained.
${target.platform === 'darwin' ? 'This macOS application is ad-hoc signed only, NOT Developer ID signed or notarized. Gatekeeper may block it.\n' : ''}`)
  fs.writeFileSync(path.join(build, `${asset}.sha256`), checksumText)

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
