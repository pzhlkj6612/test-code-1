// SPDX-License-Identifier: Apache-2.0
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const {
  patchStartupDefault, patchAboutVersion, patchRuyiPath, patchShellEnvRuyiPath, patchInstallation,
} = require('../../release/patch-startup-default')
const { RUYI_DIR } = require('../../release/package-branding')
const config = require('../../../config/release.json')

const launcher = path.resolve(__dirname, '../../../extensions/launcher')

function load(extension, failure) {
  const commands = []
  const warnings = []
  const lookups = []
  const context = {
    module: { exports: {} },
    console: { warn: (...args) => warnings.push(args) },
    require: (name) => {
      assert.equal(name, 'vscode')
      return {
        extensions: {
          getExtension: (id) => {
            lookups.push(id)
            return extension
          },
        },
        commands: {
          executeCommand: async (command) => {
            commands.push(command)
            if (failure) {
              throw failure
            }
          },
        },
      }
    },
  }
  vm.runInNewContext(fs.readFileSync(path.join(launcher, 'extension.js'), 'utf8'), context)
  return { activate: context.module.exports.activate, commands, warnings, lookups }
}

test('disabled or absent RuyiSDK is skipped without a command or warning', async () => {
  const state = load(undefined)
  await state.activate()
  assert.deepEqual(state.lookups, ['RuyiSDK.ruyisdk-vscode-extension'])
  assert.deepEqual(state.commands, [])
  assert.deepEqual(state.warnings, [])
})

test('enabled but inactive RuyiSDK opens home on each launcher activation', async () => {
  const state = load({ isActive: false })
  await state.activate()
  await state.activate()
  assert.deepEqual(state.commands, ['ruyi.home.show', 'ruyi.home.show'])
  assert.deepEqual(state.warnings, [])
})

test('a genuine command failure remains visible', async () => {
  const error = new Error('Home panel failed')
  const state = load({ isActive: true }, error)
  await state.activate()
  assert.equal(state.warnings.length, 1)
  assert.equal(state.warnings[0][1], error)
})

test('launcher only supplies startup activation, not a late configuration override', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(launcher, 'package.json'), 'utf8'))
  assert.equal(manifest.contributes.configurationDefaults, undefined)
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished'])
})

test('patch changes only the built-in startup default and preserves user override semantics', () => {
  const source = '"another.setting":{default:"welcomePage"},"workbench.startupEditor":{scope:5,type:"string",enum:["none","welcomePage"],default:"welcomePage",description:"Welcome",agentsWindow:{default:"none"}}'
  const patched = patchStartupDefault(source)
  assert.equal(patched, source.replace('],default:"welcomePage"', '],default:"none"'))
})

test('patch refuses missing, duplicate or changed upstream defaults', () => {
  const source = '"workbench.startupEditor":{type:"string",default:"welcomePage"}'
  for (const value of ['', source + source, source.replace('"welcomePage"', '"none"')]) {
    assert.throws(() => patchStartupDefault(value), /Expected one built-in/)
  }
})

test('about version patch formats downstream and upstream versions and rejects unexpected bundles', () => {
  const source = 'function Omo(i,e){let t=i.version;i.target?t=`${t} (${i.target} setup)`:i.darwinUniversalAssetId&&(t=`${t} (Universal)`)}'
  const patched = patchAboutVersion(source, '0.1.8')
  assert.equal(patched, 'function Omo(i,e){let t=`0.1.8 (VSCodium ${i.version})`;i.target?t=`${t} (${i.target} setup)`:i.darwinUniversalAssetId&&(t=`${t} (Universal)`)}')
  for (const value of ['', source + source, patched]) {
    assert.throws(() => patchAboutVersion(value, '0.1.8'), /Expected one About dialog version definition/)
  }
  assert.throws(() => patchAboutVersion(source, 'v0.1.8'), /Invalid release version/)
})

test('ruyi PATH bootstrap patches reject missing, duplicate or already-patched bundles', () => {
  const bootstrap = 'globalThis._VSCODE_FILE_ROOT=import.meta.dirname;var Ow=void 0;'
  const patchedBootstrap = patchRuyiPath(bootstrap)
  for (const value of ['', bootstrap + bootstrap, patchedBootstrap]) {
    assert.throws(() => patchRuyiPath(value), /Expected one bootstrap file root definition/)
  }

  const shellEnv = 'delete $.XDG_RUNTIME_DIR,t.trace("getUnixShellEnvironment#result",$),c($)'
  const patchedShellEnv = patchShellEnvRuyiPath(shellEnv)
  for (const value of ['', shellEnv + shellEnv, patchedShellEnv]) {
    assert.throws(() => patchShellEnvRuyiPath(value), /Expected one Unix shell environment result trace/)
  }
})

test('patched bootstrap exposes only the dedicated ruyi directory across spawns and login-shell resets', () => {
  using installDir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'ruyi-bootstrap-path-'))
  const outDir = path.join(installDir.path, 'resources/app/out')
  const appBinDir = path.join(installDir.path, 'bin')
  const ruyiDir = path.join(installDir.path, RUYI_DIR)
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(appBinDir, { recursive: true })
  fs.writeFileSync(path.join(appBinDir, 'ruyisdk-ide'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const bundleSource = [
    'Object.defineProperty(process, "platform", { value: process.env.TEST_PLATFORM });',
    'globalThis._VSCODE_FILE_ROOT=import.meta.dirname;',
    'const traced=[];const t={trace:(...args)=>traced.push(args)};',
    'const $={PATH:process.env.TEST_SHELL_PATH};',
    'delete $.XDG_RUNTIME_DIR,t.trace("getUnixShellEnvironment#result",$);',
    'globalThis._RUYISDK_APPEND_RUYI_PATH(process.env);',
    'console.log(JSON.stringify({processPath:process.env.PATH??null,shellPath:$.PATH??null,traced:traced.length}));',
  ].join('\n')
  const bundleFile = path.join(outDir, 'main.mjs')
  fs.writeFileSync(bundleFile, patchShellEnvRuyiPath(patchRuyiPath(bundleSource)))

  const runBundle = (env) => {
    const result = spawnSync(process.execPath, [bundleFile], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout.trim())
  }

  for (const platform of ['darwin', 'win32', 'linux']) {
    const absent = runBundle({ TEST_PLATFORM: platform, PATH: '/usr/bin', TEST_SHELL_PATH: '/usr/bin' })
    assert.deepEqual(absent, { processPath: '/usr/bin', shellPath: '/usr/bin', traced: 1 })
  }

  fs.mkdirSync(path.join(ruyiDir, 'ruyi'), { recursive: true })
  assert.deepEqual(runBundle({ TEST_PLATFORM: 'linux', PATH: '/usr/bin', TEST_SHELL_PATH: '/usr/bin' }),
    { processPath: '/usr/bin', shellPath: '/usr/bin', traced: 1 })
  fs.rmSync(path.join(ruyiDir, 'ruyi'), { recursive: true })

  fs.writeFileSync(path.join(ruyiDir, 'ruyi'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
  if (process.platform !== 'win32') {
    assert.deepEqual(runBundle({ TEST_PLATFORM: 'linux', PATH: '/usr/bin', TEST_SHELL_PATH: '/usr/bin' }),
      { processPath: '/usr/bin', shellPath: '/usr/bin', traced: 1 })
  }
  fs.chmodSync(path.join(ruyiDir, 'ruyi'), 0o755)

  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(runBundle({ TEST_PLATFORM: platform, PATH: '/usr/bin', TEST_SHELL_PATH: '/usr/bin' }),
      { processPath: '/usr/bin', shellPath: '/usr/bin', traced: 1 })
  }

  const expected = `/usr/local/bin${path.delimiter}/usr/bin${path.delimiter}${ruyiDir}`
  const populated = runBundle({
    TEST_PLATFORM: 'linux',
    PATH: `/usr/local/bin${path.delimiter}/usr/bin${path.delimiter}`,
    TEST_SHELL_PATH: `/usr/local/bin${path.delimiter}/usr/bin`,
  })
  assert.deepEqual(populated, { processPath: expected, shellPath: expected, traced: 1 })
  assert.equal(populated.processPath.includes(appBinDir), false)

  const empty = runBundle({ TEST_PLATFORM: 'linux' })
  assert.deepEqual(empty, { processPath: ruyiDir, shellPath: ruyiDir, traced: 1 })
})

function installation(root) {
  const workbench = 'vs/workbench/workbench.desktop.main.js'
  const source = '"workbench.startupEditor":{type:"string",default:"welcomePage"};let t=i.version;i.target?t=`${t} (${i.target} setup)`:i.darwinUniversalAssetId&&(t=`${t} (Universal)`)'
  const bootstrap = 'globalThis._VSCODE_FILE_ROOT=import.meta.dirname;var D=void 0;'
  const main = `${bootstrap}function NI(t,$){delete $.XDG_RUNTIME_DIR,t.trace("getUnixShellEnvironment#result",$)}`
  fs.mkdirSync(path.join(root, 'out/vs/workbench'), { recursive: true })
  fs.writeFileSync(path.join(root, 'out', workbench), source)
  fs.writeFileSync(path.join(root, 'out/bootstrap-fork.js'), bootstrap)
  fs.writeFileSync(path.join(root, 'out/cli.js'), bootstrap)
  fs.writeFileSync(path.join(root, 'out/main.js'), main)
  fs.writeFileSync(path.join(root, 'out/other.js'), 'unchanged')
  const hash = content => crypto.createHash('sha256').update(content).digest('base64').replace(/=+$/, '')
  const product = { nameShort: 'RuyiSDK IDE', checksums: { [workbench]: hash(source), 'other.js': hash('unchanged') } }
  fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify(product))
  return { root, workbench, product, hash }
}

test('intentional patch updates only its checksum and preserves integrity checking', () => {
  using directory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'ruyi-integrity-'))
  const { root, workbench, product, hash } = installation(directory.path)
  patchInstallation(root)
  const updated = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'))
  const patched = fs.readFileSync(path.join(root, 'out', workbench), 'utf8')
  assert.ok(patched.includes(`\`${config.releaseVersion} (VSCodium \${i.version})\``))
  for (const file of ['bootstrap-fork.js', 'cli.js', 'main.js']) {
    assert.match(fs.readFileSync(path.join(root, 'out', file), 'utf8'), /_RUYISDK_APPEND_RUYI_PATH/)
  }
  assert.match(fs.readFileSync(path.join(root, 'out/main.js'), 'utf8'), /_RUYISDK_APPEND_RUYI_PATH\?\.\(\$\)/)
  assert.equal(updated.checksums[workbench], hash(Buffer.from(patched)))
  assert.notEqual(updated.checksums[workbench], product.checksums[workbench])
  assert.equal(updated.checksums['other.js'], product.checksums['other.js'])
  assert.equal(updated.nameShort, product.nameShort)
  assert.deepEqual(Object.keys(updated.checksums), Object.keys(product.checksums))
})

test('unexpected modification is rejected rather than given a new checksum', () => {
  using directory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'ruyi-integrity-'))
  const { root, workbench } = installation(directory.path)
  const before = fs.readFileSync(path.join(root, 'out', workbench), 'utf8')
  fs.writeFileSync(path.join(root, 'out/other.js'), 'unexpected modification')
  assert.throws(() => patchInstallation(root), /checksum mismatch.*other\.js/)
  assert.equal(fs.readFileSync(path.join(root, 'out', workbench), 'utf8'), before)
})

test('missing workbench integrity entry fails packaging', () => {
  using directory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'ruyi-integrity-'))
  const { root, product, workbench } = installation(directory.path)
  delete product.checksums[workbench]
  fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify(product))
  assert.throws(() => patchInstallation(root), /Missing workbench integrity checksum/)
})
