#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Rasterizes the RuyiSDK extension icon into PNG sizes for release packages,
// including Linux app icons and the macOS iconset.
//
// Uses @resvg/resvg-js (prebuilt native binding, no system imagemagick/
// librsvg CLI required) since this environment has no root/apt access to
// install those system tools.

'use strict'

const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')
const { createProgram, runCli } = require('./cli')

const ROOT = path.resolve(__dirname, '../..')
const SRC_PNG = path.join(ROOT, 'icons', 'source', 'icon.png')
const OUT_DIR = path.join(ROOT, 'icons', 'generated')

// Sizes needed for the Linux repack: the main app/desktop icon (VS Code's
// upstream Linux icon ships at 512x512 as resources/app/resources/linux/code.png)
// plus a handful of common sizes for hicolor icon themes / favicon-style uses.
const SIZES = [16, 24, 32, 48, 64, 128, 192, 256, 512, 1024]

function parseArguments(argv, output) {
  createProgram('generate-icons.js', 'Rasterize icons/source/icon.png into icons/generated', output)
    .parse(argv, { from: 'user' })
  return {}
}

function main(argv) {
  parseArguments(argv)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const icon = fs.readFileSync(SRC_PNG)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 720" width="1024" height="1024"><image href="data:image/png;base64,${icon.toString('base64')}" width="720" height="720"/></svg>`

  for (const size of SIZES) {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: size },
      background: 'rgba(0,0,0,0)',
    })
    const png = resvg.render().asPng()
    const outPath = path.join(OUT_DIR, `icon-${size}.png`)
    fs.writeFileSync(outPath, png)
    console.log(`wrote ${path.relative(ROOT, outPath)} (${size}x${size})`)
  }

  // Canonical "code.png" name expected by the Linux packaging path
  // (upstream VSCodium/VS Code ship this at 1024x1024).
  fs.copyFileSync(
    path.join(OUT_DIR, 'icon-1024.png'),
    path.join(OUT_DIR, 'code.png'),
  )
  console.log('wrote icons/generated/code.png (1024x1024, canonical Linux app icon)')

  // Workbench logos and About use the original color artwork.
  fs.writeFileSync(path.join(OUT_DIR, 'workbench-icon.svg'), svg)
  console.log('wrote icons/generated/workbench-icon.svg (1024x1024 render box)')

  // VSCodium's letterpress watermarks are monochrome; keep them separate from
  // the colored app and workbench icons. Lower their opacity to keep the
  // watermark subtle against the welcome page.
  const letterpressSvg = svg.replace(
    '<image ',
    '<defs><filter id="monochrome"><feColorMatrix type="saturate" values="0"/></filter></defs><image opacity="0.35" filter="url(#monochrome)" ',
  )
  fs.writeFileSync(path.join(OUT_DIR, 'letterpress-icon.svg'), letterpressSvg)
  console.log('wrote icons/generated/letterpress-icon.svg (monochrome letterpress artwork)')
}

if (require.main === module) runCli(main)

module.exports = { parseArguments, main }
