// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { config, resourcePath, validateResources } = require('./package-utils')

function clone(resource) {
  const destination = resourcePath(resource)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (fs.existsSync(destination)) throw new Error(`Clone destination already exists: ${destination}`)
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', resource.url, destination], {
    stdio: 'inherit',
  })
  execFileSync('git', ['-C', destination, 'fetch', '--depth=1', 'origin', resource.commit], {
    stdio: 'inherit',
  })
  execFileSync('git', ['-C', destination, 'checkout', '--detach', resource.commit], {
    stdio: 'inherit',
  })
  const commit = execFileSync('git', ['-C', destination, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  if (commit !== resource.commit) throw new Error(`Expected ${resource.commit}, checked out ${commit}`)
}

validateResources()
for (const resource of config.resources.filter((entry) => entry.type === 'git')) clone(resource)
