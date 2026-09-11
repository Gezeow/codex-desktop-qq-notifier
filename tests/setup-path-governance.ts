import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(projectRoot, "artifacts", "test-temp");
const fallbackRoot = path.resolve("D:\\AI\\_project-artifacts\\qq-codex-bridge-public");
const runRoot = path.resolve(
  process.env.QQ_CODEX_BRIDGE_TEST_TEMP_ROOT
    ?? path.join(artifactRoot, `vitest-${process.pid}-${randomUUID().slice(0, 8)}`)
);
const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};

if (!isWithin(projectRoot, runRoot) && !isWithin(fallbackRoot, runRoot)) {
  throw new Error("QQ bridge public test temp root escaped project path governance");
}

mkdirSync(runRoot, { recursive: true });
process.env.QQ_CODEX_BRIDGE_TEST_TEMP_ROOT = runRoot;
process.env.TEMP = runRoot;
process.env.TMP = runRoot;
process.env.TMPDIR = runRoot;
