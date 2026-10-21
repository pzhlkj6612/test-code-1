// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const WORKBENCH = 'vs/workbench/workbench.desktop.main.js'

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
  return source.replace(setting, (match) => match.replace('default:"welcomePage"', 'default:"none"'))
}

function patchInstallation(appRoot) {
  const productFile = path.join(appRoot, 'product.json')
  const product = JSON.parse(fs.readFileSync(productFile, 'utf8'))
  verifyChecksums(appRoot, product)
  const bundle = path.join(appRoot, 'out', WORKBENCH)
  fs.writeFileSync(bundle, patchStartupDefault(fs.readFileSync(bundle, 'utf8')))
  product.checksums[WORKBENCH] = checksum(bundle)
  verifyChecksums(appRoot, product)
  fs.writeFileSync(productFile, JSON.stringify(product, null, 2) + '\n')
}

if (require.main === module) {
  const appRoot = process.argv[2]
  if (!appRoot) throw new Error('Usage: node scripts/release/patch-startup-default.js <resources/app directory>')
  patchInstallation(appRoot)
}

module.exports = { patchStartupDefault, patchInstallation }
