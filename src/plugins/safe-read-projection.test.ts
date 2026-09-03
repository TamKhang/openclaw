import { describe, expect, it } from "vitest";
import {
  normalizeSafeReadProjection,
  SAFE_READ_PROJECTION_CAPABILITIES,
} from "./safe-read-projection.js";

describe("safe-read projection declaration", () => {
  it("accepts a supported read capability", () => {
    const result = normalizeSafeReadProjection({
      capabilities: [SAFE_READ_PROJECTION_CAPABILITIES[0]],
    });

    expect(result).toEqual({
      ok: true,
      value: { capabilities: ["status-read"] },
    });
  });

  it("rejects unsupported capability families", () => {
    for (const capabilities of [["retrieval"], ["message"], ["shell"], ["provider"]]) {
      expect(normalizeSafeReadProjection({ capabilities })).toMatchObject({
        ok: false,
      });
    }
  });

  it("rejects missing or duplicate capabilities", () => {
    expect(normalizeSafeReadProjection({ capabilities: [] })).toMatchObject({
      ok: false,
    });
    expect(
      normalizeSafeReadProjection({ capabilities: ["status-read", "status-read"] }),
    ).toMatchObject({ ok: false });
  });
});
