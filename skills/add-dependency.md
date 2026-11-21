Add, upgrade or remove a package and keep one version of it in the tree

1. `await scripts.run("overview")` for the ecosystem and its package manager (`packageManager`).
   Use only that manager: `deps.pm` runs the project's own one.
2. Before adding: `await scripts.run("why", { name })`. If a copy is already installed through
   another package, say which version, and prefer a range that matches it. If a copy has
   `direct: true`, the package is already a direct dependency: say so and stop unless the request
   is an upgrade.
3. Check the name exists before adding it: `await deps.registry(name)` gives `latest`; an `error`
   starting "not on the public npm registry" (or PyPI, crates.io, the Go proxy) means there is no such
   public package. Never add a name you only half remember.
4. Put it in the right place: test, build and type packages (`@types/*`, `vitest`, `eslint`,
   `typescript`) are dev dependencies; runtime packages are dependencies. Pin an exact version only
   if the project already pins its dependencies (the `declared` ranges in `overview` say).
5. Add, only when the caller asked for the change:
   - npm: `deps.pm("install", "zod@4.1.0")`, dev `deps.pm("install", "--save-dev", "vitest")`;
   - pnpm and yarn: `deps.pm("add", "zod")`, dev `deps.pm("add", "-D", "vitest")`;
   - Python with uv: `deps.pm("add", "httpx")`; Go: `deps.pm("get", "example.com/mod@v1.2.3")`.
   Read `code` and the end of `out` and `err`: a non-zero code means nothing changed.
6. Upgrade: `await scripts.run("outdated")` for `current`, `wanted` and `latest`. A step within the
   declared range is `deps.pm("update", name)`. A major step is a new range
   (`deps.pm("install", "name@<major>")`); read `await scripts.run("changes", { name, from: "<current>" })`
   for breaking changes before calling it safe.
7. Remove: `deps.pm("remove", name)` (npm: `deps.pm("uninstall", name)`). First check whether the
   project's code imports it: that is the `code` kit's question (`ask.kit("code", "where is <name> imported?")`).
8. After any change: `await scripts.run("installed", { name })` and report the version now there and
   the range in package.json. Two versions in `why` means a parent pins the older one: name the
   parent from `chains`. `deps.pm("dedupe")` removes duplicates the ranges allow.
9. The project's tests and typecheck after the change are the `tests` kit's job:
   `ask.kit("tests", "do the typecheck and the tests pass?")`, and report what it says.
10. Never edit a lockfile by hand and never delete it to settle a conflict.
