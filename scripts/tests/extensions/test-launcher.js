// SPDX-License-Identifier: Apache-2.0
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const os = require('node:os')
const crypto = require('node:crypto')
const { patchStartupDefault, patchInstallation } = require('../../release/patch-startup-default')

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
            if (failure) throw failure
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

function installation(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-integrity-'))
  t.after(() => fs.rmSync(root, { recursive: true }))
  const workbench = 'vs/workbench/workbench.desktop.main.js'
  const source = '"workbench.startupEditor":{type:"string",default:"welcomePage"}'
  fs.mkdirSync(path.join(root, 'out/vs/workbench'), { recursive: true })
  fs.writeFileSync(path.join(root, 'out', workbench), source)
  fs.writeFileSync(path.join(root, 'out/other.js'), 'unchanged')
  const hash = (content) => crypto.createHash('sha256').update(content).digest('base64').replace(/=+$/, '')
  const product = { nameShort: 'RuyiSDK IDE', checksums: { [workbench]: hash(source), 'other.js': hash('unchanged') } }
  fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify(product))
  return { root, workbench, product, hash }
}

test('intentional patch updates only its checksum and preserves integrity checking', (t) => {
  const { root, workbench, product, hash } = installation(t)
  patchInstallation(root)
  const updated = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8'))
  assert.equal(updated.checksums[workbench], hash(fs.readFileSync(path.join(root, 'out', workbench))))
  assert.notEqual(updated.checksums[workbench], product.checksums[workbench])
  assert.equal(updated.checksums['other.js'], product.checksums['other.js'])
  assert.equal(updated.nameShort, product.nameShort)
  assert.deepEqual(Object.keys(updated.checksums), Object.keys(product.checksums))
})

test('unexpected modification is rejected rather than given a new checksum', (t) => {
  const { root, workbench } = installation(t)
  const before = fs.readFileSync(path.join(root, 'out', workbench), 'utf8')
  fs.writeFileSync(path.join(root, 'out/other.js'), 'unexpected modification')
  assert.throws(() => patchInstallation(root), /checksum mismatch.*other\.js/)
  assert.equal(fs.readFileSync(path.join(root, 'out', workbench), 'utf8'), before)
})

test('missing workbench integrity entry fails packaging', (t) => {
  const { root, product, workbench } = installation(t)
  delete product.checksums[workbench]
  fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify(product))
  assert.throws(() => patchInstallation(root), /Missing workbench integrity checksum/)
})
