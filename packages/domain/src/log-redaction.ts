import { createHash } from "node:crypto";

export function hashIdentifierForLog(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `sha256:${digest}`;
}

