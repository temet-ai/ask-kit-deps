export const meta = {
  purpose:
    "Are there known vulnerabilities in what is installed? Advisories for every installed (or pinned) package: package, severity, the vulnerable range, the installed version, the version that fixes it, and the direct dependency it came through; summed by severity. Asks npm's advisory endpoint, PyPI, or OSV for Cargo and Go; when they cannot be reached the result says so.",
  params: { eco: "npm | python | cargo | go, optional (default: every ecosystem found)", dir: "the project folder, optional", max: "advisories listed, default 30", severity: "list only this severity and above: low | moderate | high | critical, optional" },
  returns: "{ok, sources:[{eco, source, checked, error}], counts:{critical, high, moderate, low, unknown}, advisories:[{eco, name, version, severity, title, id, url, vulnerable, fixedIn, direct, dev, through}], more, verdict}",
  example: 'await scripts.run("audit", { severity: "high" })',
};

const RANK = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, unknown: 5 };

export default async function ({ deps }, { eco, dir, max = 30, severity } = {}) {
  const d = dir ? deps.at(dir) : deps;
  const p = await d.project();
  if (!p.ecosystems.length) return { ok: false, sources: [], counts: {}, advisories: [], verdict: p.note };
  const ecos = eco ? [eco] : p.ecosystems.map((e) => e.eco);
  const sources = [];
  let found = [];
  for (const e of ecos) {
    const r = await d.advisories({ eco: e });
    sources.push({ eco: r.eco, source: r.source, checked: r.checked, ...(r.error ? { error: r.error } : {}), ...(r.note ? { note: r.note } : {}) });
    found.push(...r.advisories.map((a) => ({ eco: r.eco, ...a })));
  }
  const counts = {};
  for (const a of found) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  const total = found.length;
  if (severity) {
    if (!(severity in RANK)) throw new Error(`severity is one of low, moderate, high, critical; got "${severity}"`);
    found = found.filter((a) => (RANK[a.severity] ?? 5) <= RANK[severity]);
  }
  found.sort((a, b) => (RANK[a.severity] ?? 5) - (RANK[b.severity] ?? 5) || (b.direct ? 1 : 0) - (a.direct ? 1 : 0) || (a.name < b.name ? -1 : 1));
  const failed = sources.filter((s) => s.error);
  const ok = failed.length < sources.length;
  const packages = new Set(found.map((a) => `${a.name}@${a.version}`)).size;
  return {
    ok,
    sources,
    counts,
    advisories: found.slice(0, max).map(({ aliases, ...a }) => a),
    ...(found.length > max ? { more: found.length - max } : {}),
    verdict: !ok
      ? `the advisory source could not be reached (${failed[0].error}), so nothing is known about vulnerabilities`
      : `${total ? `${total} advisories in ${new Set(found.map((a) => a.name)).size || packages} package(s): ${Object.entries(counts).sort((a, b) => (RANK[a[0]] ?? 5) - (RANK[b[0]] ?? 5)).map(([k, v]) => `${v} ${k === "unknown" ? "of unknown severity" : k}`).join(", ")}` : `no known advisories in ${sources.reduce((n, s) => n + (s.checked ?? 0), 0)} packages`}${failed.length ? `; not checked: ${failed.map((s) => `${s.eco} (${s.error})`).join("; ")}` : ""}`,
  };
}
