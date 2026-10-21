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

The [CI workflow](.github/workflows/ci.yml) checks commit sign-offs (DCO), lints JavaScript, runs tests, and builds all six packages on branch pushes and pull requests. Packages and SHA-256 checksums are available as workflow artifacts for seven days. Bundled extensions are prepared once and shared by the packaging jobs.

### Publishing a release

Releases are manual; pushes and pull requests never publish.

1. Update `releaseVersion` and any pinned inputs in [config/release.json](config/release.json), then merge the changes into `main`.
2. In GitHub Actions, select **CI**, choose **Run workflow** on `main`, and enter the exact configured version without a `v` prefix.
3. Alternatively, dispatch `ci.yml` through the GitHub REST API with `ref: "main"` and `inputs: {"version": "0.1.6"}` (replace the example version with the configured version).

Manual runs reject other branches, mismatched versions, existing release versions or tags, and missing pinned upstream inputs before building. DCO applies to push and pull-request commits; manual dispatch does not introduce commits and skips that check. Release runs are serialized.

After lint, tests, and all six packaging jobs succeed, the publishing job downloads those same artifacts, verifies that all packages and checksums are present and correct, uploads a draft release, and publishes it only after verifying the uploaded assets. It does not rebuild the packages. Only the publishing job has permission to write repository contents.
