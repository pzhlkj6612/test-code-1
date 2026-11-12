// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

const TARGET_COMMAND = 'ruyi.home.show'
const TARGET_EXTENSION = 'RuyiSDK.ruyisdk-vscode-extension'

function registerBundledRuyi(context) {
  const collection = context?.environmentVariableCollection
  if (process.platform !== 'linux') {
    collection?.delete('PATH')
    return
  }

  const appRoot = vscode.env?.appRoot
  const binDir = appRoot
    ? path.resolve(appRoot, '../../bin')
    : path.resolve(__dirname, '../../../../bin')

  try {
    fs.accessSync(path.join(binDir, 'ruyi'), fs.constants.X_OK)
  } catch {
    collection?.delete('PATH')
    return
  }

  const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  if (!entries.includes(binDir)) {
    process.env.PATH = entries.length > 0
      ? `${process.env.PATH}${path.delimiter}${binDir}`
      : binDir
  }
  collection?.append('PATH', `${path.delimiter}${binDir}`)
}

async function activate(context) {
  registerBundledRuyi(context)

  // Disabled extensions are not exposed by the extension host API.
  if (!vscode.extensions.getExtension(TARGET_EXTENSION)) {
    return
  }

  try {
    await vscode.commands.executeCommand(TARGET_COMMAND)
  } catch (err) {
    console.warn(
      `[ruyisdk-ide.home-launcher] Could not run '${TARGET_COMMAND}'.`,
      err,
    )
  }
}

function deactivate() {
}

module.exports = { activate, deactivate, registerBundledRuyi }
