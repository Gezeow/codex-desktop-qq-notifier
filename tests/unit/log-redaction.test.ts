import { describe, expect, it } from "vitest";
import { hashIdentifierForLog } from "../../packages/domain/src/log-redaction.js";

describe("log identifier redaction", () => {
  it("produces a stable short hash without retaining the identifier", () => {
    const identifier = "qqbot:default::qq:c2c:fixture-openid";
    const redacted = hashIdentifierForLog(identifier);

    expect(redacted).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(redacted).toBe(hashIdentifierForLog(identifier));
    expect(redacted).not.toContain("fixture-openid");
  });
});

