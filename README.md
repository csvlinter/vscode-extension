# CSVLinter for Visual Studio Code

[![Version](https://img.shields.io/visual-studio-marketplace/v/csvlinter.csvlinter-vscode?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=csvlinter.csvlinter-vscode)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/csvlinter.csvlinter-vscode)](https://marketplace.visualstudio.com/items?itemName=csvlinter.csvlinter-vscode)

Lint your CSV files directly in Visual Studio Code. This extension uses the powerful Go-based [csvlinter](https://github.com/csvlinter/csvlinter) (⚡ up to 270x faster than similar tools) to provide fast and efficient validation of CSV structure, content, and encoding.

Learn more at [csvlinter.com](https://csvlinter.com)

## How it works

On activation, this extension automatically downloads the correct `csvlinter` binary for your operating system (Windows, macOS, or Linux) from the official GitHub releases. There are no external dependencies to install or configure.

The linting process is triggered whenever you open, edit or save a `.csv` file.

## Features

- **Structural validation**: Detects common CSV errors like mismatched column counts and malformed rows.
- **Schema validation**: Validate CSV data against a JSON Schema
- **Encoding validation**: Ensures files are properly UTF-8 encoded.
- **Blazing fast**: ⚡ Up to 270x faster than similar tools, thanks to streaming validation.
- **Automatic binary management**: The correct linter binary is downloaded and cached automatically.
- **Cross-platform**: Works on Windows, macOS, and Linux.

### Automatic JSON schema validation

When you open or edit a CSV file, the extension will automatically attempt to validate it against a JSON Schema if one is found. The schema file must be named either `csvlinter.schema.json` or `<csvfilename>.schema.json` (where `<csvfilename>` matches the CSV file's name). The schema file can be located in the same directory as the CSV file or in any parent directory, recursively up to the root. The extension and the underlying linter will search for the schema in this order and use it for validation if found.

## Usage

1.  Install the extension from the Visual Studio Code Marketplace.
2.  Open a `.csv` file.
3.  Any validation errors will automatically appear in the "Problems" panel (`View > Problems`).

## Requirements

None. The extension handles everything for you.

## Known issues

There are no known issues at this time. If you find a bug, please [file an issue](https://github.com/csvlinter/vscode-extension/issues).

## Release notes

See the [CHANGELOG.md](CHANGELOG.md) file for details on each release.

---

**Enjoy!**
