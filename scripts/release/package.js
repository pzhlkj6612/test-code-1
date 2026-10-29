// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const AdmZip = require('adm-zip')
const { Argument } = require('commander')
const {
  ROOT, TARGETS, config, metadata, validateVersion, resourceForTarget, resourceById, resourcePath,
  outputAsset, run, macExecutable, verifyArchitecture,
} = require('./package-utils')
const { sha256 } = require('./utils')
const { installExtensions } = require('./package-extensions')
const { overlay, rebrand } = require('./package-branding')
const { createProgram, runCli } = require('./cli')

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
  else new AdmZip(archive).extractAllTo(extracted, true)
  const appDir = target.platform === 'darwin'
    ? path.join(extracted, 'VSCodium.app') : extracted
  const appRoot = path.join(appDir, target.platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app')
  const executable = target.platform === 'darwin' ? macExecutable(appDir)
    : path.join(appDir, target.platform === 'win32' ? 'VSCodium.exe' : 'codium')
  verifyArchitecture(executable, target)
  overlay(appRoot, target)
  installExtensions(appRoot, build, target)
  rebrand(appDir, appRoot, target)
  const bundledExtensions = config.extensions.map((extension) => {
    const resource = extension.source === 'build' ? resourceById(extension.resource) : undefined
    const sourceSuffix = resource ? ` (source ${resource.commit})` : ''
    return `${extension.id}: ${extension.version}${sourceSuffix}`
  }).join('\n')
  const macOSNotice = target.platform === 'darwin'
    ? 'This macOS application is ad-hoc signed only, NOT Developer ID signed or notarized. Gatekeeper may block it.\n'
    : ''
  const readme = `RuyiSDK IDE ${version}
Based on checksum-verified upstream editor ${config.baseVersion}.
Bundled extensions:
${bundledExtensions}
The startup editor default is none; user settings still override it.
Editor auto-updates are disabled; install new RuyiSDK IDE releases manually.
Upstream licenses and third-party notices are retained.
${macOSNotice}`
  fs.writeFileSync(path.join(extracted, 'README-ruyisdk-ide-overlay.txt'), readme)
  const dist = path.join(ROOT, 'dist')
  fs.mkdirSync(dist, { recursive: true })
  const output = path.join(dist, outputAsset(target, version))
  fs.rmSync(output, { force: true })
  if (target.platform === 'linux') run('tar', ['-czf', output, '-C', extracted, '.'])
  else if (target.platform === 'win32') {
    const zip = new AdmZip()
    zip.addLocalFolder(extracted)
    fs.writeFileSync(output, zip.toBuffer())
  } else {
    fs.renameSync(appDir, path.join(extracted, `${metadata.productName}.app`))
    fs.symlinkSync('/Applications', path.join(extracted, 'Applications'))
    run('hdiutil', ['create', '-volname', metadata.productName, '-srcfolder', extracted, '-ov', '-format', 'UDZO', output])
    run('hdiutil', ['verify', output])
  }
  fs.writeFileSync(`${output}.sha256`, `${await sha256(output)}  ${path.basename(output)}\n`)
  console.log(`Packaged ${output}`)
}

function parseArguments(argv, output) {
  const program = createProgram('package.js', 'Package RuyiSDK IDE for one target', output)
    .addArgument(new Argument('<platform>', 'target platform').choices([...new Set(TARGETS.map((t) => t.platform))]))
    .addArgument(new Argument('<arch>', 'target architecture').choices([...new Set(TARGETS.map((t) => t.arch))]))
  program.parse(argv, { from: 'user' })
  const [platform, arch] = program.args
  const target = TARGETS.find((entry) => entry.platform === platform && entry.arch === arch)
  if (!target) program.error(`Unsupported target '${platform}-${arch}'`)
  return { target }
}

function main(argv) {
  return packageTarget(parseArguments(argv).target)
}

if (require.main === module) runCli(main)

module.exports = { packageTarget, parseArguments, main }
