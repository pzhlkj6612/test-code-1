// SPDX-License-Identifier: Apache-2.0
'use strict'

const vscode = require('vscode')

const TARGET_COMMAND = 'ruyi.home.show'
const TARGET_EXTENSION = 'RuyiSDK.ruyisdk-vscode-extension'

async function activate() {
  // Disabled extensions are not exposed by the extension host API.
  if (!vscode.extensions.getExtension(TARGET_EXTENSION)) {
    return
  }

  try {
    await vscode.commands.executeCommand(TARGET_COMMAND)
  }
  catch (err) {
    console.warn(
      `[ruyisdk-ide.home-launcher] Could not run '${TARGET_COMMAND}'.`,
      err,
    )
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
