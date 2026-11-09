import { describe, expect, test } from "bun:test";
import { riskFlags, riskLabel, type RiskFlag } from "../src/client/risk.ts";

const fl = (path: string, status = "M", oldMode?: string, newMode?: string) => {
  const o: { path: string; status: string; oldMode?: string; newMode?: string } = { path, status };
  if (oldMode !== undefined) o.oldMode = oldMode;
  if (newMode !== undefined) o.newMode = newMode;
  return riskFlags(o);
};

describe("riskFlags exec and symlink (AC-5, AC-6)", () => {
  test("executable bit", () => {
    expect(fl("run.sh", "A", undefined, "100755")).toEqual(["exec"]);
    expect(fl("run.sh", "M", "100644", "100755")).toEqual(["exec"]);
    expect(fl("run.sh", "M", "100755", "100755")).toEqual([]);
    expect(fl("run.sh", "M", undefined, "100644")).toEqual([]);
  });
  test("symlink", () => {
    expect(fl("l", "M", "100644", "120000")).toEqual(["symlink"]);
    expect(fl("l", "M", "120000", "120000")).toEqual([]);
    expect(fl("l", "?", undefined, "120000")).toEqual(["symlink"]);
  });
});

describe("riskFlags directory rules (AC-7)", () => {
  const dirs: Array<[string, RiskFlag]> = [
    [".github/workflows/", "ci"], [".github/actions/", "ci"], [".circleci/", "ci"], [".buildkite/", "ci"],
    [".husky/", "hook"], [".githooks/", "hook"],
  ];
  for (const [d, flag] of dirs) {
    test(d, () => {
      expect(fl(`${d}x.yml`)).toEqual([flag]);
      expect(fl(`sub/${d}x.yml`)).toEqual([flag]);
      expect(fl(`x${d}a.yml`)).toEqual([]);
      expect(fl(`${d.slice(0, -1)}X/a.yml`)).toEqual([]);
    });
  }
  test("name rules match the last segment exactly", () => {
    expect(fl("a/Jenkinsfile")).toEqual(["ci"]);
    expect(fl("Jenkinsfile/readme.md")).toEqual([]);
    expect(fl("Jenkinsfile.bak")).toEqual([]);
  });
  const names: Array<[RiskFlag, string[]]> = [
    ["ci", [".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml"]],
    ["hook", [".pre-commit-config.yaml", "lefthook.yml", ".lefthook.yml"]],
    ["lockfile", ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "composer.lock", "go.sum"]],
    ["manifest", ["package.json", "Cargo.toml", "pyproject.toml", "setup.py", "Gemfile", "go.mod", "composer.json", "requirements.txt", "Makefile", "Dockerfile"]],
    ["env", [".env", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc"]],
  ];
  for (const [flag, list] of names) {
    test(`${flag} names at root and nested`, () => {
      for (const n of list) {
        expect(fl(n)).toEqual([flag]);
        expect(fl(`deep/er/${n}`)).toEqual([flag]);
      }
    });
  }
});

describe("riskFlags prefix rules and case (AC-8, AC-9)", () => {
  test("Dockerfile prefix", () => {
    expect(fl("Dockerfile.dev")).toEqual(["manifest"]);
    expect(fl("docker/Dockerfile.prod")).toEqual(["manifest"]);
    expect(fl("Dockerfile")).toEqual(["manifest"]);
    expect(fl("MyDockerfile")).toEqual([]);
  });
  test(".env prefix", () => {
    expect(fl(".env.local")).toEqual(["env"]);
    expect(fl("a/.env.production")).toEqual(["env"]);
    expect(fl(".env")).toEqual(["env"]);
    expect(fl(".envrc")).toEqual([]);
    expect(fl("env")).toEqual([]);
  });
  test("deletions keep path flags", () => {
    expect(fl("package-lock.json", "D", "100644", "000000")).toEqual(["lockfile"]);
  });
  test("case sensitive", () => {
    expect(fl("dockerfile")).toEqual([]);
    expect(fl("makefile")).toEqual([]);
    expect(fl("PACKAGE.JSON")).toEqual([]);
  });
});

describe("riskFlags order, uniqueness and labels (AC-10)", () => {
  test("union order", () => {
    expect(fl(".github/workflows/deploy.sh", "A", undefined, "100755")).toEqual(["exec", "ci"]);
    expect(fl(".husky/pre-commit", "A", undefined, "120000")).toEqual(["symlink", "hook"]);
    expect(fl("Makefile", "M", "100644", "100755")).toEqual(["exec", "manifest"]);
    expect(fl(".env", "A", undefined, "100755")).toEqual(["exec", "env"]);
    expect(fl("deps/uv.lock", "A", undefined, "120000")).toEqual(["symlink", "lockfile"]);
    expect(fl(".husky/.env", "M")).toEqual(["hook", "env"]);
    expect(fl(".github/workflows/Makefile", "M")).toEqual(["ci", "manifest"]);
    expect(fl("scripts/setup.sh", "M", "100644", "100755")).toEqual(["exec"]);
    expect(fl(".github/workflows/deploy.sh", "A", "000000", "100755")).toEqual(["exec", "ci"]);
  });
  test("each flag at most once", () => {
    expect(fl("Jenkinsfile", "M")).toEqual(["ci"]);
  });
  test("labels", () => {
    expect(riskLabel("exec")).toBe("executable bit added");
    expect(riskLabel("symlink")).toBe("new symbolic link");
    expect(riskLabel("ci")).toBe("CI configuration");
    expect(riskLabel("hook")).toBe("git hook");
    expect(riskLabel("lockfile")).toBe("dependency lockfile");
    expect(riskLabel("manifest")).toBe("package manifest or build file");
    expect(riskLabel("env")).toBe("environment or registry configuration");
  });
});

describe("riskFlags hidden", () => {
  test("hidden count above zero flags the file, zero or absent does not", () => {
    expect(riskFlags({ path: "a.txt", status: "M", hidden: 2 })).toEqual(["hidden"]);
    expect(riskFlags({ path: "a.txt", status: "M", hidden: 0 })).toEqual([]);
    expect(riskFlags({ path: "a.txt", status: "M", hidden: undefined })).toEqual([]);
    expect(riskFlags({ path: "a.txt", status: "M" })).toEqual([]);
  });
  test("hidden comes last", () => {
    expect(riskFlags({ path: ".github/workflows/x.sh", status: "A", newMode: "100755", hidden: 1 })).toEqual(["exec", "ci", "hidden"]);
    expect(riskFlags({ path: ".env", status: "M", hidden: 1 })).toEqual(["env", "hidden"]);
  });
  test("label", () => {
    expect(riskLabel("hidden")).toBe("hidden or invisible characters");
  });
});
