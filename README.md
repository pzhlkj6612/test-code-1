# RuyiSDK IDE

RuyiSDK IDE is a lightweight downstream overlay of [VSCodium](https://github.com/VSCodium/vscodium), with RuyiSDK integration.

## What’s added

- RuyiSDK IDE name, icons, and application identity.
- The RuyiSDK extension logo replaces the workbench logos; its monochrome version is used for the empty-window watermark in light, dark, and both high-contrast themes.
- Bundled RuyiSDK light and dark color themes, with neutral editor surfaces, navy selection accents, and warm gold highlights.
- The bundled [RuyiSDK VS Code extension](https://github.com/ruyisdk/ruyisdk-vscode-extension).
- The bundled [CanMV extension](https://github.com/kendryte/canmv-vscode-extension), built from pinned source with native backends for every IDE target.
- A home launcher that opens RuyiSDK Home on startup when RuyiSDK is enabled.

## What’s changed

- The default startup editor is set to “none,” so the Welcome page does not open automatically. Users can still open it or choose a different startup editor.
- The bundled RuyiSDK dark theme is the default color theme for new profiles; users can choose RuyiSDK Light or another theme, or customize colors in settings.

## What remains VSCodium

The editor and most built-in features come from VSCodium. Some secondary UI text may still refer to VS Code or VSCodium; fully replacing it requires a source-build patch.

## Build and download

CI packages the following architectures:

- macOS arm64.
- Windows x64/arm64.
- Linux x64/arm64/RISC-V64.

Download packages from GitHub Releases when available; IDE updates are manual. macOS builds are ad-hoc signed, not notarized; Windows executables retain upstream icons and version resources.

For build requirements and steps, see the [CI release workflow](.github/workflows/release.yml).
