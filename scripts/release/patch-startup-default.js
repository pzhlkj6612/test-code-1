// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createProgram, runCli } = require('./cli')
const { config, validateVersion } = require('./package-utils')

const WORKBENCH = 'vs/workbench/workbench.desktop.main.js'
const RUYI_PATH_MODULE = 'ruyisdk-ruyi-path.mjs'
const RUYI_PATH_SOURCE = path.join(__dirname, RUYI_PATH_MODULE)
const RUYI_PATH_HOOK = `import{appendRuyiPath as _RUYISDK_APPEND_RUYI_PATH}from"./${RUYI_PATH_MODULE}";globalThis._RUYISDK_APPEND_RUYI_PATH=_RUYISDK_APPEND_RUYI_PATH;_RUYISDK_APPEND_RUYI_PATH(process.env);`

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64').replace(/=+$/, '')
}

function verifyChecksums(appRoot, product) {
  if (!product.checksums || !Object.hasOwn(product.checksums, WORKBENCH)) {
    throw new Error('Missing workbench integrity checksum in product.json')
  }
  for (const [file, expected] of Object.entries(product.checksums)) {
    if (checksum(path.join(appRoot, 'out', file)) !== expected) {
      throw new Error(`Integrity checksum mismatch before packaging: ${file}`)
    }
  }
}

function patchStartupDefault(source) {
  const setting = /"workbench\.startupEditor":\{[^{}]*default:"welcomePage"/g
  const matches = [...source.matchAll(setting)]
  if (matches.length !== 1) {
    throw new Error(`Expected one built-in startupEditor default, found ${matches.length}. Review the upstream bundle before packaging.`)
  }
  return source.replace(setting, match => match.replace('default:"welcomePage"', 'default:"none"'))
}

function patchAboutVersion(source, version = config.releaseVersion) {
  validateVersion(version)
  const aboutVersion = /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.version;(?=\2\.target\?\1=`\$\{\1\} \(\$\{\2\.target\} setup\)`:\2\.darwinUniversalAssetId)/g
  const matches = [...source.matchAll(aboutVersion)]
  if (matches.length !== 1) {
    throw new Error(`Expected one About dialog version definition, found ${matches.length}. Review the upstream bundle before packaging.`)
  }
  return source.replace(aboutVersion, (_, variable, product) => `let ${variable}=\`${version} (VSCodium \${${product}.version})\`;`)
}

function patchRuyiPath(source) {
  const fileRoot = /globalThis\._VSCODE_FILE_ROOT=import\.meta\.dirname;(?!import\{appendRuyiPath as _RUYISDK_APPEND_RUYI_PATH\})/g
  const matches = [...source.matchAll(fileRoot)]
  if (matches.length !== 1) {
    throw new Error(`Expected one bootstrap file root definition, found ${matches.length}. Review the upstream bundle before packaging.`)
  }
  return source.replace(fileRoot, match => `${match}${RUYI_PATH_HOOK}`)
}

function patchShellEnvRuyiPath(source) {
  const shellEnvResult = /(?<!_RUYISDK_APPEND_RUYI_PATH\?\.\([A-Za-z_$][\w$]*\),)([A-Za-z_$][\w$]*)\.trace\("getUnixShellEnvironment#result",([A-Za-z_$][\w$]*)\)/g
  const matches = [...source.matchAll(shellEnvResult)]
  if (matches.length !== 1) {
    throw new Error(`Expected one Unix shell environment result trace, found ${matches.length}. Review the upstream bundle before packaging.`)
  }
  return source.replace(shellEnvResult, (match, _logger, env) => `(globalThis._RUYISDK_APPEND_RUYI_PATH?.(${env}),${match})`)
}

const BUNDLES = [
  [WORKBENCH, source => patchAboutVersion(patchStartupDefault(source))],
  ['bootstrap-fork.js', patchRuyiPath],
  ['cli.js', patchRuyiPath],
  ['main.js', source => patchShellEnvRuyiPath(patchRuyiPath(source))],
]

function patchInstallation(appRoot) {
  const productFile = path.join(appRoot, 'product.json')
  const product = JSON.parse(fs.readFileSync(productFile, 'utf8'))
  verifyChecksums(appRoot, product)

  const updates = BUNDLES.map(([file, apply]) => {
    const bundle = path.join(appRoot, 'out', file)
    return [file, bundle, apply(fs.readFileSync(bundle, 'utf8'))]
  })
  fs.copyFileSync(RUYI_PATH_SOURCE, path.join(appRoot, 'out', RUYI_PATH_MODULE))
  for (const [file, bundle, content] of updates) {
    fs.writeFileSync(bundle, content)
    if (Object.hasOwn(product.checksums, file)) {
      product.checksums[file] = checksum(bundle)
    }
  }

  verifyChecksums(appRoot, product)
  fs.writeFileSync(productFile, JSON.stringify(product, null, 2) + '\n')
}

function parseArguments(argv, output) {
  const program = createProgram('patch-startup-default.js',
    'Patch built-in workbench defaults, About dialog version, and bundled ruyi PATH bootstrap, then refresh integrity checksums', output)
    .argument('<app-root>', 'resources/app directory of an extracted editor')
  program.parse(argv, { from: 'user' })
  return { appRoot: program.args[0] }
}

function main(argv) {
  patchInstallation(parseArguments(argv).appRoot)
}

if (require.main === module) {
  runCli(main)
}

module.exports = {
  RUYI_PATH_MODULE, RUYI_PATH_SOURCE,
  patchStartupDefault, patchAboutVersion, patchRuyiPath, patchShellEnvRuyiPath,
  patchInstallation, parseArguments, main,
}
