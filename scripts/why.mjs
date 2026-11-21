export const meta = {
  purpose:
    "Why is a package here, and what requires it? For each installed copy: the shortest chains from a direct dependency down to it, with the range each step asked for, and the packages that require it directly. Use it for 'why do we have X', 'what pulls in X', 'can we remove X', 'why are there two versions of X'.",
  params: { name: "the package name (exact, or part of it when only one package matches)", eco: "npm | python | cargo | go, optional", version: "one installed version, optional", dir: "the project folder, optional", max: "chains per copy, default 3" },
  returns: "{query, match, package, copies:[{eco, package, path, direct, declared, dev, chains:[text], requiredBy:[text]}], candidates, verdict}",
  example: 'await scripts.run("why", { name: "ms" })',
};

export default async function ({ deps }, { name, eco, version, dir, max = 3 } = {}) {
  if (!name) throw new Error("why needs `name`");
  const d = dir ? deps.at(dir) : deps;
  const r = await d.why(String(name), { eco, version, max });
  let verdict;
  if (r.match === "none") verdict = r.note;
  else if (!r.copies.length) verdict = r.note ?? `no copy of ${name}${version ? ` in version ${version}` : ""}`;
  else
    verdict = r.copies
      .map((c) => {
        if (c.direct) return `${c.package} is a direct dependency (${c.declared})${c.requiredBy.length ? `, also required by ${c.requiredBy.length} package(s)` : ""}`;
        if (!c.chains.length) return `${c.package}: nothing in the project requires it`;
        const top = [...new Set(c.chains.map((x) => x.split(" (")[0]))];
        return `${c.package} is there through ${top.join(" and ")}${c.dev ? " (dev only)" : ""}`;
      })
      .join("; ");
  return { ...r, verdict };
}
