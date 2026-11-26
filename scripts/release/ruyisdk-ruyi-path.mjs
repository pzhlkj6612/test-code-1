// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs'
import path from 'node:path'

export function appendRuyiPath(env, fileRoot = globalThis._VSCODE_FILE_ROOT) {
  if (process.platform !== 'linux' || !env || typeof env !== 'object') {
    return
  }
  if (typeof fileRoot !== 'string') {
    return
  }
  const dir = path.resolve(fileRoot, '../../ruyi')
  const bin = path.join(dir, 'ruyi')
  try {
    if (!fs.statSync(bin).isFile()) {
      return
    }
    fs.accessSync(bin, fs.constants.X_OK)
  } catch {
    return
  }
  const entries = (env.PATH || '').split(path.delimiter).filter(Boolean)
  if (!entries.includes(dir)) {
    env.PATH = [...entries, dir].join(path.delimiter)
  }
}
