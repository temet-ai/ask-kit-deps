type Eco = "npm" | "python" | "cargo" | "go"; // "npm" covers pnpm and yarn projects; aliases such as "pip", "rust", "golang" are accepted
interface Package { eco: Eco; name: string; version: string; path: string | null; installed: boolean; direct: boolean; declared?: string; kind?: "prod" | "dev" | "optional" | "peer" | "build"; from?: string; dev: boolean; through?: string | null; deprecated?: string; aliasOf?: string }
interface PmResult { program: string; command: string; code: number; out: string; err: string; timedOut?: boolean }

declare const deps: {
  // The folder questions are about. Every function looks for the project by walking up from it.
  dir: string;

  // The same functions for another folder, relative to `dir`: deps.at("services/api").installed("express").
  at(folder: string): typeof deps;

  // The project: {dir, root, ecosystems:[{eco, root, project:{name, version}, manifests, lockfiles, lockfileVersion,
  // packageManager:{name, version, declared, onPath}, readFrom, installed, direct:{total, dev, notInstalled}, packages, transitive,
  // withSeveralVersions, notes}]}. `readFrom` says where the packages were read: "node_modules", a site-packages folder, a lockfile
  // (then nothing is installed and versions are the pinned ones), "cargo metadata" or "go list -m -json all".
  // With no project: ecosystems is [] and `note` names the folders below that hold one.
  project(): Promise<any>;

  // One row per direct dependency: {eco, name, declared, kind, from, version (null when not installed), installed, path}.
  direct(o?: { eco?: Eco }): Promise<any[]>;

  // Installed packages. With a name: every copy (exact name, else the name without its scope or path, else names containing it;
  // `match` says which: "exact", "basename", "substring" or "none").
  // `through` is the chain of packages from a direct dependency to it. Without a name: all, at most max (default 200).
  // {query, match, readFrom, total, packages: Package[], more, declaredButNotInstalled:[{eco, name, declared, kind, from}]}
  installed(name?: string, o?: { eco?: Eco; max?: number }): Promise<any>;

  // Why a package is there. {query, match, package, copies:[{eco, package:"name@version", path, direct, declared, dev,
  // chains:["direct@1.0.0 (declared ^1.0.0 in package.json) > mid@2.1.0 (wanted ^2.0.0) > name@0.9.1 (wanted ^0.9.0)"],
  // requiredBy:["mid@2.1.0 wants ^0.9.0"]}], candidates (when several names contain the query)}. Unknown name: match "none".
  why(name: string, o?: { eco?: Eco; version?: string; max?: number }): Promise<any>;

  // The files of the installed copy of one package: {package, dir, total, files:[forward-slash paths inside it], more}.
  // glob: "*.d.ts", "dist/**", "src/*.rs". Throws when the name matches nothing, or several packages (it lists them).
  files(name: string, o?: { eco?: Eco; version?: string; glob?: string; max?: number }): Promise<any>;

  // Lines of one file of a package, numbered: {package, path, start, end, totalLines, cite, text, next}. lines default 120, at most 400.
  // A missing file comes back as {error, nearby:[paths]}. Refused: a path outside the package, and .env, .npmrc, key and credential files.
  read(name: string, relPath: string, o?: { eco?: Eco; version?: string; start?: number; lines?: number }): Promise<any>;

  // A regular expression over the package's files: {package, count, matches:[{at:"path:line", text}], more, filesSearched}.
  // Any case unless the pattern has a capital letter. glob narrows the files; context adds lines around (0 to 3); max default 40.
  search(name: string, pattern: string, o?: { eco?: Eco; version?: string; glob?: string; max?: number; context?: number }): Promise<any>;

  // The project's package manager, no shell, each argument separate. The program is the project's own (npm, pnpm, yarn; uv or pip;
  // cargo; go); a last argument {eco, program} picks another: deps.pm("list", {program: "pip"}), deps.pm("tree", "-i", "itoa", {eco: "cargo"}).
  // The command comes first, options after it. Never throws on a non-zero exit.
  //  - Always: ls, list, outdated, audit, view, info, why, explain, query, fund, search, show, freeze, check, tree, metadata,
  //    "pip list", "pip show", "mod graph", "mod why", "doc" (go doc pkg.Symbol), "env GOMODCACHE", --version.
  //  - Only when the caller asked for a change (act: true), otherwise it throws "not in this ask": install, add, remove, uninstall,
  //    update, upgrade, ci, sync, lock, dedupe, prune, "audit fix", link, rebuild, fetch, get, "mod tidy", "pip install".
  //  - Never: publish, login, logout, token, whoami, config, owner (credentials), and run, exec, test, build, start (project code).
  pm(...args: (string | { eco?: Eco; program?: string })[]): Promise<PmResult>;

  // The public registry on one package: {name, eco, ok, latest, wanted, count, recent:[newest releases], deprecated, error}.
  // `wanted` is the highest release inside `range` (default: the range the project declares). Offline: ok false and an error.
  registry(name: string, o?: { eco?: Eco; range?: string }): Promise<any>;

  // Known advisories for everything installed in one ecosystem: {eco, ok, source, checked, error, advisories:[{name, version,
  // severity, title, id, url, vulnerable, fixedIn, direct, dev, through}]}. Offline: ok false and an error.
  advisories(o?: { eco?: Eco }): Promise<any>;

  // Every installed package's stated licence: [{eco, name, version, licence (null when none), direct, dev}].
  licences(o?: { eco?: Eco }): Promise<any[]>;

  // One package's folder and manifest: {eco, package, name, version, dir, direct, manifest (npm: main, types, exports, bin, ...),
  // modules (Python top-level names), summary, homepage, otherVersions}.
  locate(name: string, o?: { eco?: Eco; version?: string }): Promise<any>;

  // The whole text of one file of a package, or null when it is missing, binary or over 3 MB. Same refusals as read().
  // For your own parsing in a cell; print only what you need of it.
  text(name: string, relPath: string, o?: { eco?: Eco; version?: string }): Promise<string | null>;
};
