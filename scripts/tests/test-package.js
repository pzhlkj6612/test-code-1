// SPDX-License-Identifier: Apache-2.0
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const {
  TARGETS, targetFor, validateVersion, upstreamAsset, outputAsset,
  parseChecksum, sha256, macExecutable, verifyArchitecture,
} = require('../release/package-utils')
const {
  validateExtensions, extensionAsset, verifyExtension, installExtensions,
} = require('../release/package-extensions')
const { patchProduct, replaceLauncher, overlay, rebrand } = require('../release/package-branding')
const { check, verifyArtifacts, publish } = require('../release/release')
const config = require('../../config/release.json')
const metadata = require('../../config/product-overrides.json')

const RELEASE_DIR = path.resolve(__dirname, '../release')

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-package-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function nativeHeader(target) {
  const bytes = Buffer.alloc(128)
  if (target.platform === 'linux') {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes)
    bytes.writeUInt16LE({ x64: 62, arm64: 183, riscv64: 243 }[target.arch], 18)
  } else if (target.platform === 'win32') {
    bytes.write('MZ')
    bytes.writeUInt32LE(64, 60)
    bytes.writeUInt32LE(0x00004550, 64)
    bytes.writeUInt16LE({ x64: 0x8664, arm64: 0xaa64 }[target.arch], 68)
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(0x0100000c, 4)
  }
  return bytes
}

test('extension pins are parallel, validated entries with release or source inputs', () => {
  assert.deepEqual(validateExtensions().map((extension) => extension.repository), [
    'kendryte/canmv-vscode-extension', 'ruyisdk/ruyisdk-vscode-extension',
  ])
  const [source, release] = config.extensions
  assert.ok(extensionAsset(source).includes(source.commit))
  assert.equal(extensionAsset(release), release.asset)
  for (const entries of [
    null, [], [{ ...source, repository: '../repo' }], [{ ...source, id: '../extension' }],
    [{ ...source, version: '../1.0.0' }], [{ ...source, commit: 'main' }],
    [{ ...source, repository: 'unknown/extension' }], [{ ...source, source: 'unknown' }],
    [{ ...release, asset: '../extension.vsix' }], [{ ...release, sha256: 'invalid' }],
    [source, { ...source, id: source.id.toUpperCase() }],
  ]) {
    assert.throws(() => validateExtensions(entries), /extension|version|source|commit|checksum/i)
  }
})

test('extension identity and version checks apply to both input types', (t) => {
  const directory = temporary(t)
  for (const extension of config.extensions) {
    const [publisher, name] = extension.id.split('.')
    const manifest = { publisher, name, version: extension.version }
    const file = path.join(directory, 'package.json')
    fs.writeFileSync(file, JSON.stringify(manifest))
    verifyExtension(directory, extension)
    for (const patch of [{ publisher: 'wrong' }, { name: 'wrong' }, { version: '0.0.0' }]) {
      fs.writeFileSync(file, JSON.stringify({ ...manifest, ...patch }))
      assert.throws(() => verifyExtension(directory, extension), /identity\/version/)
    }
  }
})

test('both VSIX inputs install on every target with verified backends and executable permissions', async (t) => {
  const root = temporary(t)
  const cache = path.join(root, 'cache')
  fs.mkdirSync(cache)
  const source = config.extensions.find((extension) => extension.source === 'build')
  const release = config.extensions.find((extension) => extension.source === 'release')
  const previousChecksum = release.sha256
  t.after(() => { release.sha256 = previousChecksum })
  const directories = new Map()
  async function pack(extension) {
    const vsix = path.join(cache, extensionAsset(extension))
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'zipfile', '-c',
      vsix, path.join(directories.get(extension), 'extension')], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const checksum = await sha256(vsix)
    fs.writeFileSync(`${vsix}.sha256`, `${checksum}  ${extensionAsset(extension)}\n`)
    if (extension.source === 'release') extension.sha256 = checksum
  }
  for (const extension of config.extensions) {
    const directory = path.join(root, extension.id, 'extension')
    directories.set(extension, path.dirname(directory))
    fs.mkdirSync(directory, { recursive: true })
    const [publisher, name] = extension.id.split('.')
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ publisher, name, version: extension.version }))
    if (extension.source === 'build') {
      fs.writeFileSync(path.join(directory, 'build-info.json'), JSON.stringify({ commit: extension.commit }))
      for (const target of TARGETS) {
        const backend = path.join(directory, 'bin', `${target.platform}-${target.arch}`,
          target.platform === 'win32' ? 'canmv-backend.exe' : 'canmv-backend')
        fs.mkdirSync(path.dirname(backend), { recursive: true })
        fs.writeFileSync(backend, nativeHeader(target), { mode: 0o644 })
      }
    }
    await pack(extension)
  }
  for (const target of TARGETS) {
    const build = path.join(root, `${target.platform}-${target.arch}`)
    fs.mkdirSync(build)
    await installExtensions(build, build, target, cache)
    for (const extension of config.extensions) {
      verifyExtension(path.join(build, 'extensions', extension.id.toLowerCase()), extension)
    }
    if (target.platform !== 'win32' && process.platform !== 'win32') {
      const backend = path.join(build, 'extensions', source.id, 'bin',
        `${target.platform}-${target.arch}`, 'canmv-backend')
      assert.equal(fs.statSync(backend).mode & 0o777, 0o755)
    }
  }
  const target = targetFor('linux', 'riscv64')
  const vsix = path.join(cache, extensionAsset(source))
  fs.appendFileSync(vsix, 'corrupted')
  await assert.rejects(installExtensions(root, root, target, cache), /checksum mismatch/)
  const sourceDirectory = path.join(directories.get(source), 'extension')
  fs.writeFileSync(path.join(sourceDirectory, 'build-info.json'), JSON.stringify({ commit: 'wrong' }))
  await pack(source)
  await assert.rejects(installExtensions(root, root, target, cache), /Unexpected source commit/)
  fs.writeFileSync(path.join(sourceDirectory, 'build-info.json'), JSON.stringify({ commit: source.commit }))
  const backend = path.join(sourceDirectory, 'bin/linux-riscv64/canmv-backend')
  fs.writeFileSync(backend, nativeHeader(targetFor('linux', 'x64')))
  await pack(source)
  await assert.rejects(installExtensions(root, root, target, cache), /does not match linux-riscv64/)
  fs.rmSync(backend)
  await pack(source)
  await assert.rejects(installExtensions(root, root, target, cache), /ENOENT/)
  assert.equal(fs.readdirSync(root).some((name) => name.startsWith('vsix-')), false)
})

test('release matrix has exactly the six requested output formats', () => {
  assert.deepEqual(TARGETS.map((t) => `${t.platform}-${t.arch}.${t.format}`), [
    'darwin-arm64.dmg', 'win32-x64.zip', 'win32-arm64.zip',
    'linux-arm64.tar.gz', 'linux-x64.tar.gz', 'linux-riscv64.tar.gz',
  ])
  assert.throws(() => targetFor('linux', 'armhf'), /Unsupported target/)
  for (const target of TARGETS) {
    const upstream = upstreamAsset(target)
    assert.ok(upstream.includes(config.vscodiumVersion))
    assert.equal(upstream.endsWith('.tar.gz'), target.platform === 'linux')
    assert.ok(outputAsset(target, '1.2.3-ruyi.1').includes('1.2.3-ruyi.1'))
  }
  assert.equal(outputAsset(TARGETS[0], '1.2.3'), 'ruyisdk-ide-darwin-arm64-1.2.3-unsigned.dmg')
})

test('release version cannot inject paths, flags or shell syntax', () => {
  for (const value of ['1.2.3', '1.135.06055-ruyi.1']) assert.equal(validateVersion(value), value)
  for (const value of ['', '../1.2.3', '--draft', 'v1.2.3', '1.2.3;echo', '1.2.3\n', undefined]) {
    assert.throws(() => validateVersion(value), /Invalid release version/)
  }
})

test('release and package CLIs reject user-supplied version arguments', () => {
  for (const [script, args] of [
    ['release.js', ['check', '9.9.9']],
    ['release.js', ['publish', '9.9.9', 'release-assets']],
    ['package.js', ['linux', 'x64', '9.9.9']],
  ]) {
    const result = spawnSync(process.execPath, [path.join(RELEASE_DIR, script), ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage:|Too many arguments/)
  }
})

test('upstream checksums must be a single valid hash for the requested asset', () => {
  const hash = 'a'.repeat(64)
  for (const text of [hash, `${hash}  base.zip\n`, `${hash.toUpperCase()} *base.zip\r\n`, `${hash}  ./base.zip`]) {
    assert.equal(parseChecksum(text, 'base.zip'), hash)
  }
  for (const text of ['', '1234', `${hash}  other.zip`, `${hash}\n${hash}`]) {
    assert.throws(() => parseChecksum(text, 'base.zip'), /checksum/i)
  }
})

test('product identity is isolated without losing licenses, remote downloads or extension updates', () => {
  const product = {
    builtInExtensionsEnabledWithAutoUpdates: ['existing', 'RuyiSDK.ruyisdk-vscode-extension'],
    updateUrl: 'https://upstream.invalid/update',
    win32x64AppId: 'upstream-installer-id',
    win32arm64UserAppId: 'upstream-user-installer-id',
    licenseUrl: 'https://upstream.invalid/LICENSE',
    serverDownloadUrlTemplate: 'https://upstream.invalid/server',
    checksums: { file: 'hash' },
  }
  const result = patchProduct(product)
  assert.equal(result.nameShort, 'RuyiSDK IDE')
  assert.equal(result.applicationName, 'ruyisdk-ide')
  assert.equal(result.win32AppUserModelId, metadata.win32AppUserModelId)
  assert.equal(result.darwinBundleIdentifier, metadata.darwinBundleIdentifier)
  assert.equal(result.updateUrl, undefined)
  assert.equal(result.win32x64AppId, undefined)
  assert.equal(result.win32arm64UserAppId, undefined)
  assert.equal(result.licenseUrl, 'https://upstream.invalid/LICENSE')
  assert.equal(result.serverDownloadUrlTemplate, 'https://upstream.invalid/server')
  assert.deepEqual(result.checksums, { file: 'hash' })
  assert.deepEqual(result.builtInExtensionsEnabledWithAutoUpdates,
    ['existing', 'RuyiSDK.ruyisdk-vscode-extension', 'kendryte747.canmv-vscode'])
  assert.throws(() => patchProduct({}), /Expected builtInExtensions/)
})

test('Linux and Windows CLI wrappers point at the renamed binary and preserve arguments', () => {
  assert.equal(replaceLauncher('ELECTRON="$VSCODE_PATH/codium"\nwhich -a \'codium\'\n"$ELECTRON" "$@"', 'linux'),
    'ELECTRON="$VSCODE_PATH/ruyisdk-ide"\nwhich -a \'ruyisdk-ide\'\n"$ELECTRON" "$@"')
  assert.equal(replaceLauncher('"%~dp0..\\VSCodium.exe" %*\r\n', 'win32'), '"%~dp0..\\ruyisdk-ide.exe" %*\r\n')
  assert.equal(replaceLauncher('APP_NAME="codium"\nNAME="VSCodium"\nSERVERDATAFOLDER=".vscodium-server"\nELECTRON="$VSCODE_PATH/$NAME.exe"\n', 'win32'),
    'APP_NAME="ruyisdk-ide"\nNAME="ruyisdk-ide"\nSERVERDATAFOLDER=".ruyisdk-ide-server"\nELECTRON="$VSCODE_PATH/$NAME.exe"\n')
  assert.throws(() => replaceLauncher('changed upstream', 'linux'), /launcher changed/)
  assert.throws(() => replaceLauncher('changed upstream', 'win32'), /launcher changed/)
})

test('native binary headers match every requested architecture', (t) => {
  const root = temporary(t)
  for (const target of TARGETS) {
    const file = path.join(root, `${target.platform}-${target.arch}`)
    fs.writeFileSync(file, nativeHeader(target))
    verifyArchitecture(file, target)
    fs.writeFileSync(file, Buffer.alloc(128))
    assert.throws(() => verifyArchitecture(file, target), /does not match/)
    fs.writeFileSync(file, 'truncated')
    assert.throws(() => verifyArchitecture(file, target), /Truncated/)
  }
})

test('macOS executable is resolved from Info.plist rather than assumed to be Electron', (t) => {
  const app = temporary(t)
  const contents = path.join(app, 'Contents')
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
  const plist = path.join(contents, 'Info.plist')
  for (const name of ['VSCodium', 'Electron', 'RuyiSDK IDE']) {
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`)
    const executable = path.join(contents, 'MacOS', name)
    const bytes = Buffer.alloc(64)
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(0x0100000c, 4)
    fs.writeFileSync(executable, bytes)
    assert.equal(macExecutable(app), executable)
    verifyArchitecture(macExecutable(app), targetFor('darwin', 'arm64'))
  }
  for (const name of ['', '.', '..', '../Electron', 'dir/Electron', 'dir\\Electron']) {
    fs.writeFileSync(plist, `<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`)
    assert.throws(() => macExecutable(app), /Invalid CFBundleExecutable/)
  }
  fs.writeFileSync(plist, '<plist version="1.0"><dict></dict></plist>')
  assert.throws(() => macExecutable(app), /Cannot read CFBundleExecutable/)
  fs.writeFileSync(plist, 'invalid plist')
  assert.throws(() => macExecutable(app), /Cannot read CFBundleExecutable/)
})

test('shared overlay patches integrity and bundles the home launcher for all platforms', (t) => {
  const root = temporary(t)
  const iconNames = ['code-icon.svg', 'vscode-icon.svg',
    'letterpress-light.svg', 'letterpress-dark.svg', 'letterpress-hcLight.svg', 'letterpress-hcDark.svg']
  const icon = fs.readFileSync(path.resolve(__dirname, '../../icons/generated/workbench-icon.svg'), 'utf8')
  const letterpressIcon = fs.readFileSync(path.resolve(__dirname, '../../icons/generated/letterpress-icon.svg'), 'utf8')
  const embeddedIcon = /href="data:image\/png;base64,([^"]+)"/.exec(icon)
  assert.ok(embeddedIcon, 'workbench logo must embed the RuyiSDK icon')
  assert.deepEqual(Buffer.from(embeddedIcon[1], 'base64'),
    fs.readFileSync(path.resolve(__dirname, '../../icons/source/icon.png')))
  assert.match(letterpressIcon, /<feColorMatrix type="saturate" values="0"\/>/,
    'letterpress watermark must be monochrome')
  assert.match(letterpressIcon, /<image opacity="0\.35" filter="url\(#monochrome\)"/,
    'letterpress watermark must remain subtle')
  for (const target of TARGETS) {
    const app = path.join(root, `${target.platform}-${target.arch}`)
    fs.mkdirSync(path.join(app, 'out/vs/workbench'), { recursive: true })
    fs.mkdirSync(path.join(app, 'out/media'), { recursive: true })
    fs.mkdirSync(path.join(app, 'resources/linux'), { recursive: true })
    for (const name of iconNames) {
      fs.writeFileSync(path.join(app, 'out/media', name), '<svg>upstream logo</svg>')
    }
    const source = '"workbench.startupEditor":{type:"string",default:"welcomePage"}'
    const workbench = 'vs/workbench/workbench.desktop.main.js'
    fs.writeFileSync(path.join(app, 'out', workbench), source)
    const hash = crypto.createHash('sha256').update(source).digest('base64').replace(/=+$/, '')
    fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify({
      checksums: { [workbench]: hash }, builtInExtensionsEnabledWithAutoUpdates: [],
    }))
    fs.writeFileSync(path.join(app, 'package.json'), '{"name":"VSCodium"}')
    overlay(app, target)
    const product = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8'))
    assert.equal(product.nameShort, metadata.productName)
    assert.notEqual(product.checksums[workbench], hash)
    assert.match(fs.readFileSync(path.join(app, 'out', workbench), 'utf8'), /default:"none"/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).name, 'RuyiSDK IDE')
    assert.ok(fs.existsSync(path.join(app, 'extensions/ruyisdk-ide.home-launcher/extension.js')))
    const themeRoot = path.join(app, 'extensions/ruyisdk-ide.ruyisdk-theme')
    const themeExtension = JSON.parse(fs.readFileSync(path.join(themeRoot, 'package.json'), 'utf8'))
    assert.equal(themeExtension.contributes.configurationDefaults['workbench.colorTheme'], 'RuyiSDK Dark')
    for (const [label, file, type, background, focus] of [
      ['RuyiSDK Dark', 'ruyisdk-dark-color-theme.json', 'dark', '#101820', '#E6B85C'],
      ['RuyiSDK Light', 'ruyisdk-light-color-theme.json', 'light', '#F7F8FA', '#9A6A12'],
    ]) {
      const contribution = themeExtension.contributes.themes.find((theme) => theme.label === label)
      assert.ok(contribution, `${label} must be contributed`)
      assert.equal(contribution.uiTheme, type === 'dark' ? 'vs-dark' : 'vs')
      const themePath = path.join(themeRoot, 'themes', file)
      assert.ok(fs.existsSync(themePath))
      const theme = JSON.parse(fs.readFileSync(themePath, 'utf8'))
      assert.equal(theme.type, type)
      assert.equal(theme.colors['editor.background'], background)
      assert.equal(theme.colors.focusBorder, focus)
    }
    for (const name of iconNames) {
      const expectedIcon = name.startsWith('letterpress-') ? letterpressIcon : icon
      assert.equal(fs.readFileSync(path.join(app, 'out/media', name), 'utf8'), expectedIcon,
        `${target.platform}-${target.arch}: ${name} must use the correct RuyiSDK artwork`)
    }
  }
})

test('Linux rebrand preserves executable mode and supplies the desktop entry', (t) => {
  const app = temporary(t)
  fs.mkdirSync(path.join(app, 'bin'))
  fs.writeFileSync(path.join(app, 'codium'), 'binary', { mode: 0o755 })
  fs.writeFileSync(path.join(app, 'bin/codium'), '#!/bin/sh\n"$VSCODE_PATH/codium" "$@"', { mode: 0o755 })
  rebrand(app, path.join(app, 'resources/app'), targetFor('linux', 'x64'))
  assert.ok(fs.existsSync(path.join(app, 'ruyisdk-ide')))
  assert.equal(fs.statSync(path.join(app, 'bin/ruyisdk-ide')).mode & 0o111, process.platform === 'win32' ? 0 : 0o111)
  assert.match(fs.readFileSync(path.join(app, 'ruyisdk-ide.desktop'), 'utf8'), /Name=RuyiSDK IDE/)
})

test('Windows rebrand renames both CLI wrappers and the executable', (t) => {
  const app = temporary(t)
  fs.mkdirSync(path.join(app, 'bin'))
  fs.writeFileSync(path.join(app, 'VSCodium.exe'), 'binary')
  for (const suffix of ['', '.cmd']) fs.writeFileSync(path.join(app, `bin/codium${suffix}`), '"../VSCodium.exe"')
  rebrand(app, path.join(app, 'resources/app'), targetFor('win32', 'arm64'))
  assert.ok(fs.existsSync(path.join(app, 'ruyisdk-ide.exe')))
  for (const suffix of ['', '.cmd']) {
    assert.equal(fs.readFileSync(path.join(app, `bin/ruyisdk-ide${suffix}`), 'utf8'), '"../ruyisdk-ide.exe"')
  }
})

test('publication requires exactly six nonempty packages with matching portable checksums', async (t) => {
  const directory = temporary(t)
  const version = config.releaseVersion
  for (const target of TARGETS) {
    const name = outputAsset(target, version)
    const file = path.join(directory, name)
    fs.writeFileSync(file, `${target.platform}-${target.arch}`)
    fs.writeFileSync(`${file}.sha256`, `${await sha256(file)}  ${name}\n`)
  }
  assert.equal((await verifyArtifacts(directory)).length, 12)
  const name = outputAsset(TARGETS[0], version)
  fs.writeFileSync(path.join(directory, name), 'corrupted')
  await assert.rejects(verifyArtifacts(directory), /checksum mismatch/)
  fs.rmSync(path.join(directory, name))
  await assert.rejects(verifyArtifacts(directory), /exactly six/)
})

test('preflight builds the complete matrix and fails if even one upstream asset is missing', async (t) => {
  const previousFetch = global.fetch
  const previousToken = process.env.GH_TOKEN
  const previousRepository = process.env.GITHUB_REPOSITORY
  t.after(() => {
    global.fetch = previousFetch
    if (previousToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousToken
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY
    else process.env.GITHUB_REPOSITORY = previousRepository
  })
  process.env.GH_TOKEN = 'test-token'
  process.env.GITHUB_REPOSITORY = 'example/ide'
  const assets = TARGETS.flatMap((target) => [
    { name: upstreamAsset(target) }, { name: `${upstreamAsset(target)}.sha256` },
  ])
  const source = config.extensions.find((extension) => extension.source === 'build')
  let sourceCommit = source.commit
  let extensionAssets = [{ name: config.extensions.find((extension) => extension.source === 'release').asset }]
  global.fetch = async (url) => {
    if (url.includes('/repos/example/ide/releases?')) return Response.json([])
    if (url.includes('/git/ref/tags/')) return new Response('', { status: 404 })
    if (url.includes('/repos/VSCodium/')) return Response.json({ assets, draft: false, prerelease: false })
    if (url.includes('/repos/ruyisdk/')) return Response.json({
      assets: extensionAssets,
    })
    if (url.includes('/repos/kendryte/')) {
      assert.ok(url.endsWith(`/commits/${source.commit}`))
      return Response.json({ sha: sourceCommit })
    }
    throw new Error(`Unexpected API request: ${url}`)
  }
  assert.deepEqual(await check(), { include: TARGETS })
  sourceCommit = 'b'.repeat(40)
  await assert.rejects(check(), /Pinned source commit is missing/)
  sourceCommit = source.commit
  extensionAssets = []
  await assert.rejects(check(), /Pinned extension asset is missing/)
  assets.pop()
  await assert.rejects(check(), /Missing upstream release asset/)
  global.fetch = async () => new Response('', { status: 403 })
  await assert.rejects(check(), /GitHub API failed \(403\)/)
  global.fetch = async () => Response.json([{ tag_name: config.releaseVersion, draft: true }])
  await assert.rejects(check(), /already exists/)
})

test('publication refuses incomplete packages before making any GitHub request', async (t) => {
  await assert.rejects(publish(temporary(t)), /exactly six/)
})

test('publication uploads a draft before publishing, and upload failure never publishes', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = temporary(t)
  const directory = path.join(root, 'assets')
  fs.mkdirSync(directory)
  const version = config.releaseVersion
  const names = []
  for (const target of TARGETS) {
    const name = outputAsset(target, version)
    names.push(name, `${name}.sha256`)
    const file = path.join(directory, name)
    fs.writeFileSync(file, name)
    fs.writeFileSync(`${file}.sha256`, `${await sha256(file)}  ${name}\n`)
  }
  const log = path.join(root, 'gh.log')
  fs.writeFileSync(path.join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.RUYI_TEST_GH_LOG, JSON.stringify(args) + '\\n')
if (process.env.RUYI_TEST_UPLOAD_FAIL === 'yes' && args[1] === 'upload') process.exit(1)
`, { mode: 0o755 })
  const environment = {
    PATH: `${root}${path.delimiter}${process.env.PATH}`,
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'example/ide',
    GITHUB_SHA: 'a'.repeat(40),
    RUYI_TEST_GH_LOG: log,
    RUYI_TEST_UPLOAD_FAIL: '',
  }
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]))
  const previousFetch = global.fetch
  t.after(() => {
    global.fetch = previousFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  Object.assign(process.env, environment)
  let listCalls = 0
  global.fetch = async (url) => {
    if (url.includes('/git/ref/tags/')) return new Response('', { status: 404 })
    assert.ok(url.includes('/releases?'))
    listCalls++
    return Response.json(listCalls === 1 ? [] : [{
      tag_name: version,
      draft: true,
      assets: names.map((name) => ({ name, size: fs.statSync(path.join(directory, name)).size })),
    }])
  }
  await publish(directory)
  const commands = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(commands.map((args) => args.slice(0, 2)), [
    ['release', 'create'], ['release', 'upload'], ['release', 'edit'],
  ])
  assert.ok(commands[0].includes('--draft'))
  const notes = commands[0][commands[0].indexOf('--notes') + 1]
  for (const extension of config.extensions) {
    assert.ok(notes.includes(`${extension.repository} ${extension.version}`))
    if (extension.source === 'build') assert.ok(notes.includes(extension.commit))
  }
  assert.equal(commands[0][2], config.releaseVersion)
  assert.ok(commands[2].includes('--draft=false'))
  fs.writeFileSync(log, '')
  listCalls = 0
  process.env.RUYI_TEST_UPLOAD_FAIL = 'yes'
  await assert.rejects(publish(directory), /gh release failed/)
  const failedCommands = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(failedCommands.map((args) => args.slice(0, 2)), [
    ['release', 'create'], ['release', 'upload'],
  ])
})
