# Project commands. Run `just` to list them. Install just once:
# `winget install Casey.Just` (Windows), `brew install just` (macOS).

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# List the recipes
default:
    @just --list

# Install dependencies (also installs the pre-commit hook)
install:
    npm install

# Build the extension and the webview
build:
    npm run build

# Lint, format check, type-check and unit tests (what CI checks first)
check:
    npm run lint
    npm run format:check
    npm run typecheck
    npm test

# Lint the code
lint:
    npm run lint

# Format every file with Prettier
format:
    npm run format

# Tests: `just test` (unit), `just test integration` (real VS Code) or `just test full` (both)
test kind="unit":
    just _test-{{ kind }}

_test-unit:
    npm test

_test-integration:
    npm run test:integration

_test-full: _test-unit _test-integration

# Package the extension as a .vsix
package:
    npm run package

# Set the version for a release, e.g. `just release 0.2.0` (then update CHANGELOG.md)
release version:
    npm version {{ version }} --no-git-tag-version

# Measure graph quality on the Python showcase sample (writes the report to bench/results)
eval-python:
    node scripts/run.mjs scripts/eval-sample.ts samples/python-showcase --out bench/results/eval-python.md
