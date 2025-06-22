# CSV Linter for Visual Studio Code

[![Marketplace Version](https://vsmarketplacebadge.apphb.com/version/csvlinter.csvlinter-vscode.svg)](https://marketplace.visualstudio.com/items?itemName=csvlinter.csvlinter-vscode)
[![Installs](https://vsmarketplacebadge.apphb.com/installs/csvlinter.csvlinter-vscode.svg)](https://marketplace.visualstudio.com/items?itemName=csvlinter.csvlinter-vscode)

Lint your CSV files directly in Visual Studio Code. This extension uses the powerful Go-based [csvlinter](https://github.com/csvlinter/vscode-extension) to provide fast and efficient validation of CSV structure, content, and encoding.


## How It Works

On activation, this extension automatically downloads the correct `csvlinter` binary for your operating system (Windows, macOS, or Linux) from the official GitHub releases. There are no external dependencies to install or configure.

The linting process is triggered whenever you open or save a `.csv` file.

## Features

- **Structural Validation**: Detects common CSV errors like mismatched column counts and malformed rows.
- **Schema Validation**: (Coming soon) Validate CSV data against a JSON Schema.
- **Encoding Validation**: Ensures files are properly UTF-8 encoded.
- **Automatic Binary Management**: The correct linter binary is downloaded and cached automatically.
- **Cross-Platform**: Works on Windows, macOS, and Linux.

## Usage

1.  Install the extension from the Visual Studio Code Marketplace.
2.  Open a `.csv` file.
3.  Any validation errors will automatically appear in the "Problems" panel (`View > Problems`).

## Requirements

None. The extension handles everything for you.

## Known Issues

There are no known issues at this time. If you find a bug, please [file an issue](https://github.com/csvlinter/vscode-issues/issues).

## Release Notes

See the [CHANGELOG.md](CHANGELOG.md) file for details on each release.

---

**Enjoy!**
