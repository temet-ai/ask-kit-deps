// What the package managers may do through deps.pm(). Each program has an allow-list of commands
// that only read, a list that changes the project (run only with act), and everything else is
// refused: commands that print credentials, publish, or run the project's own code.
import { deny } from "./util.mjs";

const SECRET = "it prints or changes credentials, and what you read goes to a model";
const RUNS = "it runs the project's own code; this kit only reads and manages packages";
const PUBLISH = "publishing is never done from an ask";

const node = {
  reads: ["ls", "list", "ll", "la", "outdated", "audit", "audit signatures", "view", "info", "show", "v", "why", "explain", "query", "fund", "search", "root", "prefix", "sbom", "diff", "dist-tag ls", "dist-tag list", "pkg get", "licenses", "licenses list", "licenses ls", "peers", "--version", "-v"],
  acts: ["install", "i", "add", "ci", "clean-install", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "dedupe", "prune", "link", "unlink", "rebuild", "audit fix", "import", "fetch", "sync"],
  refused: {
    publish: PUBLISH, unpublish: PUBLISH, deprecate: PUBLISH, "dist-tag add": PUBLISH, "dist-tag rm": PUBLISH,
    config: SECRET, c: SECRET, get: SECRET, set: SECRET, token: SECRET, whoami: SECRET, login: SECRET, logout: SECRET, adduser: SECRET, owner: SECRET, access: SECRET, profile: SECRET, team: SECRET, org: SECRET, hook: SECRET, "npm login": SECRET, "npm logout": SECRET, "npm whoami": SECRET, "npm publish": PUBLISH, "npm tag": PUBLISH,
    run: RUNS, "run-script": RUNS, exec: RUNS, x: RUNS, dlx: RUNS, start: RUNS, test: RUNS, t: RUNS, restart: RUNS, stop: RUNS, create: RUNS, init: RUNS, node: RUNS, "install-test": RUNS, it: RUNS, "install-ci-test": RUNS, cit: RUNS,
  },
};

export const PROGRAMS = {
  npm: node,
  pnpm: node,
  yarn: { ...node, reads: [...node.reads, "check", "versions", "workspaces list", "workspaces info", "npm audit", "npm info", "explain", "explain peer-requirements"], acts: [...node.acts.filter((a) => a !== "sync")] },
  bun: { reads: ["pm ls", "outdated", "why", "audit", "--version", "-v"], acts: ["install", "i", "add", "remove", "rm", "update", "link", "unlink"], refused: { publish: PUBLISH, run: RUNS, x: RUNS, test: RUNS, create: RUNS, init: RUNS, build: RUNS, "pm whoami": SECRET } },
  pip: {
    reads: ["show", "list", "freeze", "check", "inspect", "index versions", "--version", "-V"],
    acts: ["install", "uninstall", "download"],
    refused: { config: SECRET, debug: SECRET, cache: "it is not needed to answer about packages" },
  },
  uv: {
    reads: ["pip list", "pip show", "pip freeze", "pip check", "pip tree", "tree", "python list", "--version", "-V", "self version"],
    acts: ["add", "remove", "sync", "lock", "pip install", "pip uninstall", "pip sync", "pip compile", "venv"],
    refused: { publish: PUBLISH, auth: SECRET, run: RUNS, tool: RUNS, x: RUNS, init: RUNS, build: RUNS, export: "it prints index URLs, which can hold credentials; read uv.lock through deps.installed() instead" },
  },
  poetry: {
    reads: ["show", "check", "--version", "version"],
    acts: ["add", "remove", "install", "update", "lock", "sync"],
    refused: { publish: PUBLISH, config: SECRET, run: RUNS, shell: RUNS, build: RUNS, self: "it changes poetry itself" },
  },
  cargo: {
    reads: ["metadata", "tree", "search", "info", "pkgid", "locate-project", "audit", "outdated", "--version", "-V", "version"],
    acts: ["add", "remove", "rm", "update", "upgrade", "install", "uninstall", "fetch", "generate-lockfile", "vendor", "audit fix"],
    refused: { publish: PUBLISH, yank: PUBLISH, login: SECRET, logout: SECRET, owner: SECRET, run: RUNS, r: RUNS, build: RUNS, b: RUNS, test: RUNS, t: RUNS, bench: RUNS, check: RUNS, c: RUNS, clippy: RUNS, doc: RUNS, fix: RUNS, rustc: RUNS, init: RUNS, new: RUNS },
    badFlags: [/^--config/, /^-Z/],
  },
  go: {
    reads: ["list", "mod graph", "mod why", "mod verify", "version", "doc", "env"],
    acts: ["get", "install", "mod tidy", "mod download", "mod vendor", "mod edit", "work sync"],
    refused: { run: RUNS, build: RUNS, test: RUNS, generate: RUNS, tool: RUNS, vet: RUNS, fix: RUNS, bug: RUNS, telemetry: "it is not needed to answer about packages" },
    badFlags: [/^-{1,2}(exec|toolexec|overlay|modfile)\b/, /^-{1,2}mod=mod$/],
  },
};

/** The acting commands of every program, as the phrases ask-kit.toml lists after "deps pm". */
export const ACT_PHRASES = [...new Set(Object.values(PROGRAMS).flatMap((p) => p.acts))].sort();

/**
 * What a call is: {kind: "read"|"act", phrase}. Throws for a refused or unknown command, naming what is allowed.
 * The command is the first one or two arguments that are not options; an option that takes a value must come after it.
 */
export function classify(program, args) {
  const p = PROGRAMS[program];
  if (!p) deny(`deps.pm does not run ${program}; it runs ${Object.keys(PROGRAMS).join(", ")}`);
  const a = args.map(String);
  if (!a.length) deny(`deps.pm needs a command, for example deps.pm("${p.reads[0]}"); bare ${program} is not run`);
  for (const x of a) {
    if ((p.badFlags ?? []).some((re) => re.test(x))) deny(`${program} ${x}: this option can run or rewrite things outside the command`);
    if (/^--?(call|c)$/.test(x) && program !== "go" && program !== "cargo" && program !== "pip" && program !== "uv") deny(`${program} ${x} runs a shell command`);
  }
  const pos = a.filter((x) => !x.startsWith("-"));
  const flagOnly = pos.length === 0 ? a[0] : null;
  const one = flagOnly ?? pos[0];
  const two = pos.length > 1 ? `${pos[0]} ${pos[1]}` : null;
  for (const phrase of [two, one]) {
    if (!phrase) continue;
    if (p.refused[phrase]) deny(`${program} ${phrase}: ${p.refused[phrase]}`);
    if (p.acts.includes(phrase)) return { kind: "act", phrase };
    if (p.reads.includes(phrase)) {
      if (program === "go" && phrase === "env") {
        const names = pos.slice(1);
        if (!names.length || names.some((n) => /PROXY|AUTH|NETRC|PRIVATE|FLAGS|NOSUM/i.test(n))) deny("go env prints proxy and auth settings; name the variables you need, for example deps.pm(\"env\", \"GOMODCACHE\", \"GOVERSION\")");
      }
      return { kind: "read", phrase };
    }
  }
  deny(`${program} ${one} is not a command deps.pm runs. Reading: ${p.reads.join(", ")}. Changing (with act: true): ${p.acts.join(", ")}`);
}
