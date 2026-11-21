export const meta = {
  purpose:
    "Which version of a package is installed, and which is declared? Give a name or part of one: every installed copy with its version, its path, whether it is a direct dependency (and the declared range) or came through another package (and which), and whether it is dev only. Also says when a package is declared but not installed.",
  params: { name: "a package name or part of one", eco: "npm | python | cargo | go, optional (default: every ecosystem found)", dir: "the project folder, optional", max: "rows, default 40" },
  returns: "{query, match: exact|basename|substring|none, total, packages:[{eco, name, version, path, direct, declared, kind, dev, through}], declaredButNotInstalled, verdict}",
  example: 'await scripts.run("installed", { name: "zod" })',
};

export default async function ({ deps }, { name, eco, dir, max = 40 } = {}) {
  if (!name) throw new Error("installed needs `name` (a package name or part of one); the overview script lists every direct dependency");
  const d = dir ? deps.at(dir) : deps;
  const r = await d.installed(String(name), { eco, max });
  const versions = [...new Set(r.packages.filter((p) => p.name === r.packages[0]?.name).map((p) => p.version))];
  let verdict;
  if (r.match === "none") {
    const miss = r.declaredButNotInstalled?.[0];
    verdict = miss ? `${miss.name} is declared (${miss.declared} in ${miss.from}) but not installed` : `no package matches "${name}" in ${r.readFrom.join("; ")}`;
  } else if (r.match === "exact" || r.match === "basename") {
    const p = r.packages[0];
    const where = r.packages.some((x) => !x.installed) ? "pinned" : "installed";
    verdict = `${p.name}: ${versions.join(" and ")} ${where}${versions.length > 1 ? ` (${versions.length} versions)` : ""}; ${r.packages.map((x) => (x.direct ? `${x.version} is direct, declared ${x.declared}${x.kind === "prod" ? "" : ` (${x.kind})`}` : `${x.version} comes through ${x.through ?? "nothing"}`)).slice(0, 4).join("; ")}`;
  } else verdict = `no package is named exactly "${name}"; ${r.total} contain it: ${[...new Set(r.packages.map((p) => p.name))].slice(0, 12).join(", ")}`;
  return { ...r, verdict };
}
