# ask-kit-deps

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about the packages a project depends on. A cheap model reads `node_modules`,
the lockfile, a Python environment's `site-packages`, `cargo metadata` and `go list` outside your
agent's context and answers with `package@version` and `path:line` inside the installed package.

Questions it is built for, which agents answer by hand with `npm ls`, `cat
node_modules/x/package.json`, `pip show`, greps through `node_modules` and web lookups:

- Which version of zod is installed, and which does package.json declare?
- Why is es-errors in node_modules, and what requires it?
- What is the signature of `safeParse` in the zod we have installed?
- Which dependencies are behind, and which of those steps are major?
- Are there known vulnerabilities, and through which direct dependency do they come?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up). No package manager is needed
for npm, pnpm, yarn and Python projects: the kit reads the files on disk. Cargo and Go projects
are read through `cargo` and `go` when they are installed, and from `Cargo.lock` and `go.mod`
when they are not.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-deps
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-deps        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-deps --yes  # installs and enables it
```

Restart your agents so `ask` lists `deps`. `ask-kit kit list` says whether it can run on this
machine, and why not. The kit has three settings, all optional: `WORKDIR` (the folder questions
are about; by default the folder the agent runs in), `VENV` (the Python environment, when it is
not `.venv`, `venv` or `env` under the project root) and `OSV_URL` (the advisory API for Cargo
and Go).

## What it can change

When asked, it runs the project's own package manager to install, add, remove, update, sync,
lock, dedupe or prune packages, and `audit fix`. These run only in an ask that asked for a
change (`act: true`): the manifest lists them under `acts` as `deps pm <command>`, so ask-kit
holds them back, and `deps.mjs` holds them back as well.

`deps.pm` runs a command only when it is on a list:

- Reading commands always run: `ls`, `outdated`, `audit`, `view`, `why`, `list`, `show`, `tree`,
  `metadata`, `go doc` and the like.
- Commands that print or change credentials are refused always: `config`, `token`, `whoami`,
  `login`, `logout`, `owner`, bare `go env`. So is `publish`.
- Commands that run the project's own code are refused always: `run`, `exec`, `test`, `build`,
  `start`, `npx`-style commands.
- Any other command is refused, and the error lists what is allowed.

Files that hold credentials are never opened: `.npmrc`, `.pypirc`, `pip.conf`, `.netrc`,
`.yarnrc.yml`, and `.env` or key files inside a package. A URL with a user name and password in
a manifest, a lockfile or a command's output is shown with the credentials replaced.

`outdated` and `audit` ask public registries (registry.npmjs.org, pypi.org, index.crates.io,
proxy.golang.org, api.osv.dev) with package names and versions. They send nothing else, and they
never ask a private registry, because that would need the credentials the kit does not read.

## How well it works

The bench, `bench/questions.json`, holds 17 shots and 1 question for a model. The shots run one
script against the fake project in `bench/fixture` with no model and no network; `ask-kit kit
test deps` on 2026-11-20: 17/17. The model question has not been run on a model.

The scripts were also run by hand on real projects: two npm projects (one with `node_modules`,
one with only a lockfile), pnpm and yarn projects, a `uv` environment, a Cargo crate and a Go
module. The npm advisory counts matched `pnpm audit` on the same project. Cargo and Go
advisories were checked against a stand-in for the OSV API only, because api.osv.dev could not be
reached from the machine the kit was built on.

## What is in it

`deps.mjs` gives the investigator the project (`project`, `direct`, `installed`, `why`), the
files of one installed package (`files`, `read`, `search`), the registries (`registry`,
`advisories`) and the package manager (`pm`) with the refusals above. Its scripts are `overview`
(ecosystems, package manager, direct dependencies, what is inconsistent), `installed` (which
version, where, direct or through what), `why` (the chains from a direct dependency),
`outdated` (current, wanted, latest and the size of the step), `audit` (advisories by severity
with the fix and the direct dependency to update), `api` (entry points, exported names, one
symbol's signature and doc comment, a README section), `changes` (the package's own changelog
between two versions) and `licences` (counts, and the copyleft, missing and unusual ones). The
skill `add-dependency` is the playbook for adding, upgrading or removing a package.

Running the project's tests, typecheck and scripts is the tests kit's job, and a Rust workspace's
crates are the rust kit's. This kit still reads Cargo and Go beside an npm or Python project.
[RECIPE.md](RECIPE.md) says what it reads and runs, and how to rebuild it.

MIT licence.
