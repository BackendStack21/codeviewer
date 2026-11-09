// Risk flags for Changes rows: hints for attention, never a safety verdict.
export type RiskFlag = "exec" | "symlink" | "ci" | "hook" | "lockfile" | "manifest" | "env" | "hidden";

const DIRS: Array<[RiskFlag, string[]]> = [
  ["ci", [".github/workflows/", ".github/actions/", ".circleci/", ".buildkite/"]],
  ["hook", [".husky/", ".githooks/"]],
];
const NAMES: Array<[RiskFlag, string[]]> = [
  ["ci", [".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml"]],
  ["hook", [".pre-commit-config.yaml", "lefthook.yml", ".lefthook.yml"]],
  ["lockfile", ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "composer.lock", "go.sum"]],
  ["manifest", ["package.json", "Cargo.toml", "pyproject.toml", "setup.py", "Gemfile", "go.mod", "composer.json", "requirements.txt", "Makefile", "Dockerfile"]],
  ["env", [".env", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc"]],
];
const PREFIXES: Array<[RiskFlag, string]> = [["manifest", "Dockerfile."], ["env", ".env."]];
const ORDER: RiskFlag[] = ["exec", "symlink", "ci", "hook", "lockfile", "manifest", "env", "hidden"];

export function riskFlags(f: { path: string; status: string; oldMode?: string; newMode?: string; hidden?: number }): RiskFlag[] {
  const hit = new Set<RiskFlag>();
  if (f.newMode === "100755" && f.oldMode !== "100755") hit.add("exec");
  if (f.newMode === "120000" && f.oldMode !== "120000") hit.add("symlink");
  const p = f.path;
  const name = p.slice(p.lastIndexOf("/") + 1);
  for (const [flag, dirs] of DIRS) {
    if (dirs.some((d) => p.startsWith(d) || p.includes("/" + d))) hit.add(flag);
  }
  for (const [flag, names] of NAMES) if (names.includes(name)) hit.add(flag);
  for (const [flag, pre] of PREFIXES) if (name.startsWith(pre)) hit.add(flag);
  if (f.hidden !== undefined && f.hidden > 0) hit.add("hidden");
  return ORDER.filter((x) => hit.has(x));
}

const LABELS: Record<RiskFlag, string> = {
  exec: "executable bit added",
  symlink: "new symbolic link",
  ci: "CI configuration",
  hook: "git hook",
  lockfile: "dependency lockfile",
  manifest: "package manifest or build file",
  env: "environment or registry configuration",
  hidden: "hidden or invisible characters",
};

export function riskLabel(flag: RiskFlag): string {
  return LABELS[flag];
}
