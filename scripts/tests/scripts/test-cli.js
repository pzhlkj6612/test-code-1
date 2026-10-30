// SPDX-License-Identifier: Apache-2.0
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { TARGETS } = require('../../release/package-utils')
const config = require('../../../config/release.json')

const RELEASE_DIR = path.resolve(__dirname, '../../release')
const quiet = { writeOut: () => {
}, writeErr: () => {
} }

function parser(script) {
  const { parseArguments } = require(path.join(RELEASE_DIR, script))
  return argv => parseArguments(argv, quiet)
}

function rejects(parse, argv, code) {
  assert.throws(() => parse(argv), (error) => {
    assert.equal(error.code, code, `${JSON.stringify(argv)}: ${error.message}`)
    assert.equal(error.exitCode, 1)
    return true
  })
}

function runScript(script, args) {
  return spawnSync(process.execPath, [path.join(RELEASE_DIR, script), ...args], { encoding: 'utf8' })
}

test('configure-workflow.js accepts the output file and optional release request options', () => {
  const parse = parser('configure-workflow.js')
  assert.deepEqual(parse(['out']), { output: 'out', event: '', ref: '', defaultBranch: '', requestedVersion: '' })
  const expected = {
    output: 'out', event: 'workflow_dispatch', ref: 'refs/heads/master', defaultBranch: 'master', requestedVersion: '1.2.3',
  }
  assert.deepEqual(parse(['--event', 'workflow_dispatch', '--ref', 'refs/heads/master', '--default-branch', 'master',
    '--requested-version', '1.2.3', 'out']), expected)
  assert.deepEqual(parse(['--event=workflow_dispatch', '--ref=refs/heads/master', '--default-branch=master',
    '--requested-version=1.2.3', '--', 'out']), expected)
  assert.deepEqual(parse(['out', '--requested-version=']), { output: 'out', event: '', ref: '', defaultBranch: '', requestedVersion: '' })
  // Workflow-supplied values are passed with "=" so dashes cannot become options.
  assert.equal(parse(['--requested-version=--event', 'out']).requestedVersion, '--event')
  assert.equal(parse(['--', '--out']).output, '--out')
  rejects(parse, [], 'commander.missingArgument')
  rejects(parse, ['out', 'extra'], 'commander.excessArguments')
  rejects(parse, ['--version=1.2.3', 'out'], 'commander.unknownOption')
  rejects(parse, ['out', '--ref'], 'commander.optionMissingArgument')
})

test('configure-workflow.js validates manual release requests from arguments only', () => {
  using directoryDirectory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'ruyi-workflow-output-'))
  const directory = directoryDirectory.path
  const output = path.join(directory, 'workflow-output.txt')
  const matrix = `matrix=${JSON.stringify({ include: TARGETS })}\n`
  const run = (args) => {
    fs.rmSync(output, { force: true })
    return runScript('configure-workflow.js', [...args, output])
  }

  for (const args of [
    [],
    ['--event=workflow_dispatch', '--ref=refs/heads/feature', '--requested-version='],
    ['--event=push', '--ref=refs/heads/feature', `--requested-version=v${config.releaseVersion}`],
    ['--event=workflow_dispatch', '--ref=refs/heads/master', '--default-branch=master',
      `--requested-version=${config.releaseVersion}`],
    ['--event=workflow_dispatch', '--ref=refs/heads/main', '--default-branch=main',
      `--requested-version=${config.releaseVersion}`],
  ]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.readFileSync(output, 'utf8'), matrix)
  }

  for (const [args, message] of [
    [['--event=workflow_dispatch', '--ref=refs/heads/feature', '--default-branch=master',
      `--requested-version=${config.releaseVersion}`], /default branch master/],
    [['--event=workflow_dispatch', '--ref=refs/heads/main', '--default-branch=master',
      `--requested-version=${config.releaseVersion}`], /default branch master/],
    [['--event=workflow_dispatch', '--ref=refs/heads/master', `--requested-version=${config.releaseVersion}`],
      /Default branch is required/],
    [['--event=workflow_dispatch', '--ref=refs/heads/master', '--default-branch=master',
      '--requested-version=9999.0.0'], /does not match/],
    [['--event=workflow_dispatch', '--ref=refs/heads/master', '--default-branch=master',
      '--requested-version=../1.2.3'], /Invalid release version/],
  ]) {
    const result = run(args)
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
    assert.equal(fs.existsSync(output), false)
  }
})

test('release.js accepts exactly the check, verify and notes commands', () => {
  const parse = parser('release.js')
  assert.deepEqual(parse(['check', 'state.json', 'out']), { command: 'check', releaseState: 'state.json', output: 'out' })
  assert.deepEqual(parse(['verify', 'assets']), { command: 'verify', directory: 'assets' })
  assert.deepEqual(parse(['notes', 'notes.md']), { command: 'notes', output: 'notes.md' })
  assert.deepEqual(parse(['notes', '--', '-notes.md']), { command: 'notes', output: '-notes.md' })
  rejects(parse, [], 'commander.help')
  rejects(parse, ['publish', '9.9.9', 'release-assets'], 'commander.unknownCommand')
  rejects(parse, ['check'], 'commander.missingArgument')
  rejects(parse, ['check', 'state.json'], 'commander.missingArgument')
  rejects(parse, ['check', 'state.json', 'out', '9.9.9'], 'commander.excessArguments')
  rejects(parse, ['verify'], 'commander.missingArgument')
  rejects(parse, ['verify', 'assets', '9.9.9'], 'commander.excessArguments')
  rejects(parse, ['notes'], 'commander.missingArgument')
  rejects(parse, ['notes', 'notes.md', 'extra'], 'commander.excessArguments')
  rejects(parse, ['notes', '--version', '9.9.9', 'notes.md'], 'commander.unknownOption')
})

test('release.js commands write their outputs', async () => {
  const { main } = require('../../release/release')
  using directoryDirectory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'ruyi-release-output-'))
  const directory = directoryDirectory.path
  const notes = path.join(directory, 'notes.md')
  await main(['notes', notes])
  assert.match(fs.readFileSync(notes, 'utf8'), new RegExp(`RuyiSDK IDE ${config.releaseVersion.replaceAll('.', '\\.')}`))
  const assets = path.join(directory, 'assets')
  fs.mkdirSync(assets)
  await assert.rejects(main(['verify', assets]), /exactly six/)
})

test('package.js accepts exactly one supported platform and architecture', () => {
  const parse = parser('package.js')
  for (const target of TARGETS) {
    assert.equal(parse([target.platform, target.arch]).target, target)
    assert.equal(parse(['--', target.platform, target.arch]).target, target)
  }
  rejects(parse, [], 'commander.missingArgument')
  rejects(parse, ['linux'], 'commander.missingArgument')
  rejects(parse, ['linux', 'armhf'], 'commander.invalidArgument')
  rejects(parse, ['freebsd', 'x64'], 'commander.invalidArgument')
  rejects(parse, ['win32', 'riscv64'], 'commander.error')
  rejects(parse, ['darwin', 'x64'], 'commander.error')
  rejects(parse, ['linux', 'x64', '9.9.9'], 'commander.excessArguments')
  rejects(parse, ['linux', 'x64', '--version=9.9.9'], 'commander.unknownOption')
})

test('prepare-inputs.js selects all, extension or single-target resources', () => {
  const parse = parser('prepare-inputs.js')
  const { selectResources } = require('../../release/prepare-inputs')
  assert.deepEqual(parse(['all']), { selection: 'all' })
  assert.deepEqual(selectResources(parse(['all'])), config.resources)
  assert.deepEqual(parse(['extensions']), { selection: 'extensions' })
  assert.deepEqual(selectResources(parse(['extensions'])).map(resource => resource.id),
    config.extensions.map(extension => extension.resource))
  for (const target of TARGETS) {
    const selection = parse(['target', '--', target.platform, target.arch])
    assert.deepEqual(selection, { selection: 'target', platform: target.platform, arch: target.arch })
    const [resource] = selectResources(selection)
    assert.deepEqual([resource.type, resource.platform, resource.arch], ['file', target.platform, target.arch])
  }
  assert.throws(() => selectResources(parse(['target', 'linux', 'armhf'])), /No file resource for linux-armhf/)
  rejects(parse, [], 'commander.help')
  rejects(parse, ['--all'], 'commander.unknownOption')
  rejects(parse, ['--extensions'], 'commander.unknownOption')
  rejects(parse, ['--target', 'linux', 'x64'], 'commander.unknownOption')
  rejects(parse, ['download'], 'commander.unknownCommand')
  rejects(parse, ['all', 'extensions'], 'commander.excessArguments')
  rejects(parse, ['extensions', 'x'], 'commander.excessArguments')
  rejects(parse, ['target'], 'commander.missingArgument')
  rejects(parse, ['target', 'linux'], 'commander.missingArgument')
  rejects(parse, ['target', 'linux', 'x64', 'extra'], 'commander.excessArguments')
})

test('patch-startup-default.js accepts exactly one application directory', () => {
  const parse = parser('patch-startup-default.js')
  assert.deepEqual(parse(['resources/app']), { appRoot: 'resources/app' })
  assert.deepEqual(parse(['--', '-app']), { appRoot: '-app' })
  rejects(parse, [], 'commander.missingArgument')
  rejects(parse, ['resources/app', 'extra'], 'commander.excessArguments')
  rejects(parse, ['--force', 'resources/app'], 'commander.unknownOption')
})

test('argument-free scripts reject any arguments', () => {
  for (const script of ['prepare-extensions.js', 'generate-icons.js']) {
    const parse = parser(script)
    assert.deepEqual(parse([]), {})
    rejects(parse, ['extra'], 'commander.excessArguments')
    rejects(parse, ['--all'], 'commander.unknownOption')
  }
})

test('CLI argument errors exit with status 1 before doing any work', () => {
  using directoryDirectory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'ruyi-cli-errors-'))
  const directory = directoryDirectory.path
  for (const [script, args] of [
    ['configure-workflow.js', []],
    ['release.js', ['notes', path.join(directory, 'notes.md'), 'extra']],
    ['package.js', ['linux', 'x64', '9.9.9']],
    ['prepare-inputs.js', ['--all']],
    ['prepare-extensions.js', ['extra']],
    ['generate-icons.js', ['extra']],
    ['patch-startup-default.js', []],
  ]) {
    const result = runScript(script, args)
    assert.equal(result.status, 1, `${script} ${args.join(' ')}`)
    assert.notEqual(result.stderr, '')
  }
  assert.deepEqual(fs.readdirSync(directory), [])
})
