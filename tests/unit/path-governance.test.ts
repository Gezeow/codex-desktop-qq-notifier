import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("path governance", () => {
  it("keeps Vitest and Node temp output under this project", () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const artifactRoot = path.join(projectRoot, "artifacts", "test-temp");
    const fallbackRoot = path.resolve("D:\\AI\\_project-artifacts\\qq-codex-bridge-public");
    const isWithin = (root: string): boolean => {
      const relative = path.relative(root, os.tmpdir());
      return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
    };

    expect(isWithin(artifactRoot) || isWithin(fallbackRoot)).toBe(true);
    expect(process.env.TEMP).toBe(os.tmpdir());
    expect(process.env.TMP).toBe(os.tmpdir());
  });
});
