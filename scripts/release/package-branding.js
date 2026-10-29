// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { patchInstallation } = require('./patch-startup-default')
const { ROOT, metadata, run, writeJson } = require('./package-utils')
const { validateExtensions } = require('./package-extensions')

function patchProduct(product, identity = metadata) {
  if (!Array.isArray(product.builtInExtensionsEnabledWithAutoUpdates)) {
    throw new Error('Expected builtInExtensionsEnabledWithAutoUpdates to be an array')
  }
  Object.assign(product, {
    nameShort: identity.productName,
    nameLong: identity.productNameLong,
    applicationName: identity.applicationName,
    dataFolderName: identity.dataFolderName,
    linuxIconName: identity.linuxIconName,
    urlProtocol: identity.urlProtocol,
    serverApplicationName: `${identity.applicationName}-server`,
    serverDataFolderName: `${identity.dataFolderName}-server`,
    quality: identity.quality,
  })
  for (const key of ['darwinBundleIdentifier', 'win32AppUserModelId', 'win32DirName',
    'win32MutexName', 'win32NameVersion', 'win32RegValueName', 'win32ShellNameShort']) {
    product[key] = identity[key]
  }
  product.builtInExtensionsEnabledWithAutoUpdates = [...new Set([
    ...product.builtInExtensionsEnabledWithAutoUpdates, ...validateExtensions().map((extension) => extension.id),
  ])]
  // Otherwisw, the upstream updater would install VSCodium over this downstream overlay.
  delete product.updateUrl
  for (const key of Object.keys(product)) {
    if (/^win32.*AppId$/.test(key)) delete product[key]
  }
  return product
}

function replaceLauncher(source, platform) {
  if (platform === 'linux') {
    if (!source.includes('$VSCODE_PATH/codium')) throw new Error('Upstream Linux launcher changed')
    return source.replaceAll('$VSCODE_PATH/codium', `$VSCODE_PATH/${metadata.binaryName}`)
      .replaceAll("'codium'", `'${metadata.binaryName}'`)
  }
  if (platform === 'win32') {
    if (!/VSCodium\.exe|^NAME="VSCodium"\r?$/im.test(source)) throw new Error('Upstream Windows launcher changed')
    return source.replace(/VSCodium\.exe/gi, `${metadata.binaryName}.exe`)
      .replace(/^NAME="VSCodium"(\r?)$/gm, `NAME="${metadata.binaryName}"$1`)
      .replace(/^APP_NAME="codium"(\r?)$/gm, `APP_NAME="${metadata.applicationName}"$1`)
      .replace(/^SERVERDATAFOLDER="[^"]+"(\r?)$/gm, `SERVERDATAFOLDER="${metadata.dataFolderName}-server"$1`)
  }
  return source.replaceAll("'codium'", `'${metadata.binaryName}'`)
    .replace(/^APP_NAME="codium"(\r?)$/gm, `APP_NAME="${metadata.applicationName}"$1`)
}

function overlay(appRoot, target) {
  patchInstallation(appRoot)

  const productFile = path.join(appRoot, 'product.json')
  writeJson(productFile, patchProduct(JSON.parse(fs.readFileSync(productFile, 'utf8'))))

  const packageFile = path.join(appRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
  pkg.name = metadata.productNameLong
  writeJson(packageFile, pkg)

  const icons = path.join(ROOT, 'icons/generated')
  for (const name of ['code-icon.svg', 'vscode-icon.svg']) {
    fs.copyFileSync(path.join(icons, 'workbench-icon.svg'), path.join(appRoot, 'out/media', name))
  }
  for (const name of ['letterpress-light.svg', 'letterpress-dark.svg',
    'letterpress-hcLight.svg', 'letterpress-hcDark.svg']) {
    fs.copyFileSync(path.join(icons, 'letterpress-icon.svg'), path.join(appRoot, 'out/media', name))
  }
  if (target.platform === 'linux') {
    fs.copyFileSync(path.join(icons, 'code.png'), path.join(appRoot, 'resources/linux/code.png'))
  }

  fs.cpSync(path.join(ROOT, 'extensions/launcher'), path.join(appRoot, 'extensions/ruyisdk-ide.home-launcher'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'extensions/theme'), path.join(appRoot, 'extensions/ruyisdk-ide.ruyisdk-theme'), { recursive: true })
}

function rebrand(appDir, appRoot, target) {
  if (target.platform === 'linux') {
    fs.renameSync(path.join(appDir, 'codium'), path.join(appDir, metadata.binaryName))

    const launcher = path.join(appDir, 'bin/codium')
    fs.writeFileSync(launcher, replaceLauncher(fs.readFileSync(launcher, 'utf8'), 'linux'))
    fs.renameSync(launcher, path.join(appDir, 'bin', metadata.binaryName))

    fs.writeFileSync(path.join(appDir, `${metadata.binaryName}.desktop`), `[Desktop Entry]
Name=${metadata.productNameLong}
Comment=${metadata.productNameLong} -- ${metadata.vendor}
GenericName=Text Editor
Exec=%k/bin/${metadata.binaryName} %F
Icon=%k/resources/app/resources/linux/code.png
Type=Application
StartupNotify=true
StartupWMClass=${metadata.applicationName}
Categories=TextEditor;Development;IDE;
MimeType=text/plain;inode/directory;application/x-${metadata.applicationName}-workspace;
Actions=new-empty-window;
Keywords=vscode;

[Desktop Action new-empty-window]
Name=New Empty Window
Exec=%k/bin/${metadata.binaryName} --new-window %F
Icon=%k/resources/app/resources/linux/code.png
`)
  } else if (target.platform === 'win32') {
    fs.renameSync(path.join(appDir, 'VSCodium.exe'), path.join(appDir, `${metadata.binaryName}.exe`))

    for (const suffix of ['', '.cmd']) {
      const launcher = path.join(appDir, `bin/codium${suffix}`)
      fs.writeFileSync(launcher, replaceLauncher(fs.readFileSync(launcher, 'utf8'), 'win32'))
      fs.renameSync(launcher, path.join(appDir, `bin/${metadata.binaryName}${suffix}`))
    }
  } else {
    const launcher = path.join(appRoot, 'bin/codium')
    fs.writeFileSync(launcher, replaceLauncher(fs.readFileSync(launcher, 'utf8'), 'darwin'))
    fs.renameSync(launcher, path.join(appRoot, 'bin', metadata.binaryName))

    const plist = path.join(appDir, 'Contents/Info.plist')
    for (const [key, value] of Object.entries({
      CFBundleName: metadata.productName,
      CFBundleDisplayName: metadata.productNameLong,
      CFBundleIdentifier: metadata.darwinBundleIdentifier,
      'CFBundleURLTypes:0:CFBundleURLSchemes:0': metadata.urlProtocol,
    })) {
      run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
    }

    const iconset = path.join(path.dirname(appDir), 'ruyisdk-ide.iconset')
    fs.mkdirSync(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
        fs.copyFileSync(path.join(ROOT, `icons/generated/icon-${size * scale}.png`), path.join(iconset, name))
      }
    }

    const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', plist], { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('Cannot read CFBundleIconFile')
    const icon = result.stdout.trim()
    if (!/^[\w.-]+$/.test(icon)) throw new Error(`Unexpected bundle icon name: ${icon}`)

    run('iconutil', ['-c', 'icns', iconset, '-o', path.join(appDir, 'Contents/Resources', icon.endsWith('.icns') ? icon : `${icon}.icns`)])
    // An ad-hoc seal is required on Apple Silicon; it is NOT Developer ID signing.
    run('codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', appDir])
    run('codesign', ['--verify', '--deep', '--strict', appDir])

    fs.rmSync(iconset, { recursive: true })
  }
}

module.exports = { patchProduct, replaceLauncher, overlay, rebrand }
