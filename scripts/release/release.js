// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const config = require('../../config/release.json')
const { TARGETS, validateVersion, upstreamAsset, outputAsset, parseChecksum, sha256 } = require('./package-utils')
const { validateExtensions } = require('./package-extensions')

async function githubApi(endpoint, allowMissing = false) {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('GH_TOKEN is required')
  const response = await fetch(`https://api.github.com/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(60000),
  })
  if (allowMissing && response.status === 404) return undefined
  if (!response.ok) throw new Error(`GitHub API failed (${response.status}): ${endpoint}`)
  return response.json()
}

function gh(args) {
  const result = spawnSync('gh', args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed (${result.status})`)
}

function validateRepository(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid GITHUB_REPOSITORY')
  return repository
}

async function findRelease(repository, version) {
  // Listing includes drafts for the publishing token; tag lookup can omit them.
  for (let page = 1; ; page++) {
    const releases = await githubApi(`repos/${repository}/releases?per_page=100&page=${page}`)
    const release = releases.find((entry) => entry.tag_name === version)
    if (release) return release
    if (releases.length < 100) return undefined
  }
}

async function requireUnusedVersion(repository, version) {
  if (await findRelease(repository, version)) {
    throw new Error(`Release ${version} already exists; use a new downstream version`)
  }
  if (await githubApi(`repos/${repository}/git/ref/tags/${encodeURIComponent(version)}`, true)) {
    throw new Error(`Tag ${version} already exists; use a new downstream version`)
  }
}

async function check() {
  const version = config.releaseVersion
  validateVersion(version)
  const repository = validateRepository(process.env.GITHUB_REPOSITORY)
  await requireUnusedVersion(repository, version)
  const upstream = await githubApi(`repos/VSCodium/vscodium/releases/tags/${config.vscodiumVersion}`)
  if (upstream.draft || upstream.prerelease) throw new Error('Expected a stable upstream release')
  const assets = new Set(upstream.assets.map((asset) => asset.name))
  for (const target of TARGETS) {
    for (const name of [upstreamAsset(target), `${upstreamAsset(target)}.sha256`]) {
      if (!assets.has(name)) throw new Error(`Missing upstream release asset: ${name}`)
    }
  }
  for (const extension of validateExtensions()) {
    if (extension.source === 'build') {
      const commit = await githubApi(`repos/${extension.repository}/commits/${extension.commit}`)
      if (commit.sha !== extension.commit) throw new Error(`Pinned source commit is missing: ${extension.repository}`)
    } else {
      const release = await githubApi(`repos/${extension.repository}/releases/tags/${extension.version}`)
      if (!release.assets.some((asset) => asset.name === extension.asset)) {
        throw new Error(`Pinned extension asset is missing: ${extension.repository}/${extension.asset}`)
      }
    }
  }
  return { include: TARGETS }
}

async function verifyArtifacts(directory) {
  const version = config.releaseVersion
  validateVersion(version)
  const expected = TARGETS.flatMap((target) => {
    const name = outputAsset(target, version)
    return [name, `${name}.sha256`]
  }).sort()
  const actual = fs.readdirSync(directory).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected exactly six packages and six checksums; found: ${actual.join(', ')}`)
  }
  for (const target of TARGETS) {
    const name = outputAsset(target, version)
    const file = path.join(directory, name)
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(`Empty or invalid package: ${name}`)
    const expectedHash = parseChecksum(fs.readFileSync(`${file}.sha256`, 'utf8'), name)
    if (await sha256(file) !== expectedHash) throw new Error(`Release artifact checksum mismatch: ${name}`)
  }
  return expected
}

async function publish(directory) {
  const version = config.releaseVersion
  const files = await verifyArtifacts(directory)
  const repository = validateRepository(process.env.GITHUB_REPOSITORY)
  const commit = process.env.GITHUB_SHA
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Invalid GITHUB_SHA')
  await requireUnusedVersion(repository, version)
  const notes = `RuyiSDK IDE ${version}, based on VSCodium ${config.vscodiumVersion}.

Includes the RuyiSDK IDE home launcher and:
${config.extensions.map((extension) => `- ${extension.repository} ${extension.version}${extension.source === 'build' ? ` (built from ${extension.commit})` : ''}`).join('\n')}
All six packages include SHA-256 checksums.

**macOS arm64: the DMG is unsigned/unnotarized (the app has only an ad-hoc signature). Gatekeeper may block it.**
Windows ZIPs retain upstream executable icons and embedded version resources.
Editor auto-updates are disabled to prevent replacement by VSCodium; install subsequent RuyiSDK IDE releases manually.

Built from ${commit}. See the repository README for installation and platform limitations.`
  gh(['release', 'create', version, '--repo', repository, '--target', commit,
    '--title', `RuyiSDK IDE ${version}`, '--notes', notes, '--draft'])
  // A failed upload leaves a draft, never a public partial release.
  gh(['release', 'upload', version, ...files.map((name) => path.join(directory, name)), '--repo', repository])
  const uploaded = await findRelease(repository, version)
  if (!uploaded || !uploaded.draft) throw new Error('Expected a draft release after upload')
  const names = uploaded.assets.map((asset) => asset.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(files)) throw new Error('Uploaded release assets are incomplete; release remains a draft')
  for (const asset of uploaded.assets) {
    if (asset.size !== fs.statSync(path.join(directory, asset.name)).size) {
      throw new Error(`Uploaded asset size mismatch: ${asset.name}; release remains a draft`)
    }
  }
  gh(['release', 'edit', version, '--repo', repository, '--draft=false', '--latest'])
}

if (require.main === module) {
  const [command, directory, ...extra] = process.argv.slice(2)
  Promise.resolve().then(async () => {
    if (extra.length) throw new Error('Too many arguments')
    if (command === 'check' && !directory) {
      const matrix = await check()
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`)
    } else if (command === 'publish' && directory) {
      await publish(path.resolve(directory))
    } else {
      throw new Error('Usage: node scripts/release/release.js check | publish <artifact-directory>')
    }
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { check, verifyArtifacts, publish }
