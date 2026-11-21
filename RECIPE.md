# Recipe: the deps kit

## What it answers

Which version of a package is installed and which is declared; why a package is there and what requires it; which direct dependencies are behind and by how much; known vulnerabilities, their severity, the fixing version and the direct dependency they come through; licences; how to call an installed package in the installed version (entry points, exported names, signatures, doc comments, README sections); what a package's own changelog says between two versions. It also acts: install, add, remove, update, sync, lock, dedupe, prune, `audit fix`. It took over the npm kit's dependency questions (why, outdated, audit, adding and removing packages) on 2026-11-21.

## What it needs

- Node 22.13 or newer (ask-kit's own requirement). No dependencies.
- ask-kit 0.3.0 or newer (`min_ask_kit = "0.3.0"`).
- Nothing else for npm, pnpm, yarn and Python projects. `cargo` and `go` on PATH give full Cargo and Go answers; without them the kit reads `Cargo.lock`, `Cargo.toml` and `go.mod`.
- A network connection for `outdated` and `audit` only. No tokens.
- Settings, all optional: `WORKDIR`, `VENV`, `OSV_URL`.

## What it reads and runs

It reads, from the nearest project at or above the caller's folder: `package.json` (and workspace members'), `node_modules/**/package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `yarn.lock`; `pyproject.toml`, `requirements*.txt`, `uv.lock`, a virtual environment's `pyvenv.cfg` and `site-packages/*.dist-info/{METADATA,RECORD,top_level.txt}`; `Cargo.toml`, `Cargo.lock`, crate sources under `~/.cargo/registry/src`; `go.mod`, module sources under the Go module cache. Inside one installed package it lists, reads and searches files on request, bounded in lines, size and time.

It runs, with no shell and each argument separate: `cargo metadata --format-version 1` (with `--offline` first), `go list -m -json all` and `go mod graph` (offline first), `<package manager> --version`, and whatever `deps.pm` is asked for from its allow-list. Reading commands always; `install`, `add`, `remove`, `uninstall`, `update`, `upgrade`, `ci`, `sync`, `lock`, `dedupe`, `prune`, `audit fix`, `link`, `rebuild`, `fetch`, `get`, `mod tidy` and the like only with act.

It requests: `registry.npmjs.org/<name>` and its bulk advisory endpoint, `pypi.org/pypi/<name>/json` and `/<name>/<version>/json`, `index.crates.io`, `proxy.golang.org/<module>/@v/list`, and `api.osv.dev/v1/querybatch` and `/v1/vulns/<id>` for Cargo and Go. Each request times out after 15 or 30 seconds. When a direct request fails and `HTTPS_PROXY` is set, it is made once more from a child Node started with `NODE_USE_ENV_PROXY=1`.

Refused because answers go to a cloud model: opening `.npmrc`, `.pypirc`, `pip.conf`, `.netrc`, `.yarnrc.yml`, `.env`, key and credential files; `config`, `token`, `whoami`, `login`, `logout`, `owner`, `access`, `profile`, bare `go env`, `uv export`. Refused always: `publish`, `unpublish`, `yank`, and commands that run project code (`run`, `exec`, `test`, `build`, `start`, `dlx`). URLs with credentials are redacted wherever they appear.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.deps`, name `deps`, `says`, `keywords`, `route_hint`, `cite`, `instructions = "instructions.md"`, `acts` as `deps pm <command>` phrases, settings `WORKDIR` with a `detect` that prints the working folder, `VENV` and `OSV_URL`, one `[[sources]]` of kind `module`, name `deps`, module `deps.mjs`, api `api.d.ts`, and three reading `[[actions]]`: why, installed, outdated). The keywords leave cargo and crates to the rust kit, and a lookbehind on the words that test and Rust questions share (package, npm, outdated, dependency and the like) keeps them from firing when the question names a test, typecheck, lint, build, script, cargo or crate.

`deps.mjs` exports `make({settings, push, act})` returning the `deps` global. It finds each ecosystem's root by walking up from `WORKDIR` and loads one tree per ecosystem: `{nodes: Map(id -> {name, version, dir, licence, deps:[{name, range, to, kind}]}), roots:[{name, range, kind, from, to}]}`. `lib/npm.mjs` builds it from `node_modules` (walking nested folders, scopes, pnpm's `.pnpm` store and workspace links, and resolving each dependency the way Node does: `<folder>/node_modules/<name>`, then each parent) or, with no `node_modules`, from `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`. `lib/python.mjs` builds it from `*.dist-info/METADATA` (`Requires-Dist`, skipping uninstalled extras), or from `uv.lock`, with declared rows from `pyproject.toml` and `requirements*.txt`. `lib/native.mjs` builds it from `cargo metadata` and `go list -m -json all` with `go mod graph`, with narrow fallbacks. `lib/graph.mjs` marks direct and dev-only packages and finds the shortest chains to a package by a breadth-first walk over reverse edges. TOML and YAML are parsed narrowly in `lib/util.mjs` (`tomlTables`, `yamlLite`); the comments there say what is assumed. `lib/util.mjs` also holds version comparison, npm range matching, redaction and the secret-file rule.

Functions: `project()`, `direct()`, `installed(name?)`, `why(name)`, `files(name)`, `read(name, path, {start, lines})`, `search(name, pattern, {glob})`, `pm(...args)`, `registry(name)`, `advisories()`, `licences()`, `locate(name)`, `text(name, path)`, `at(folder)`. A name matches exactly, then without its scope or module path, then as a substring, and the result says which. `pm` classifies each command with `lib/pm.mjs` (per program: reading, acting, refused with the reason; anything else refused) and builds the acting path only when `act` is true. `lib/net.mjs` holds the registry and advisory requests; `lib/api.mjs` holds entry points, exported names (following `export * from`), symbol declarations with doc comments for TypeScript, JavaScript, Python, Rust and Go, README sections and changelog entries.

`skills/add-dependency.md`: the steps for adding, upgrading or removing a package with `deps.pm`, checking the name on the registry first, and handing the checks afterwards to the tests kit.

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and `export default async function ({deps}, params)`, each with a one-line `verdict`): `overview`, `installed`, `why`, `outdated`, `audit`, `api`, `changes`, `licences`. Every script takes `eco` and `dir`.

`instructions.md` has the same structure as the docker kit: how to work (scripts first, the installed files are the source for API questions, `readFrom` says whether versions are installed or pinned, credentials are off limits, how to decide the common verdicts, act only when asked and read the result back), and the answer format (answer first, cite `package@version` and `path:line`).

`bench/fixture` is a hand-written fake install: an npm project with a committed `node_modules` (four packages, a transitive chain, two versions of one package, a declared package that is not installed, type declarations, a README and a CHANGELOG) and its `package-lock.json`, and a Python project (`pyproject.toml`, `uv.lock`, `.venv/lib/python3.12/site-packages` with two `dist-info` folders). A `.gitignore` in the fixture keeps `node_modules` and `.venv` in git. `bench/questions.json` holds `do` questions only, each with `expect` patterns checked against the fixture; run `ask-kit kit test deps` from the kit's folder.

One `q` question (asked of a model) asks why a package is installed in the fixture.

## Results

ask-kit `kit test` on 2026-11-20: 17/17 shots, all answered with no model. No model run has been made yet.
