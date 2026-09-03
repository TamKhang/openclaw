import { describe, expect, it } from "vitest";
import {
  formatAuthoritativeGroupReplyText,
  readTrustedWhatsAppDisplayName,
} from "./group-participant-name.js";

describe("group participant name helpers", () => {
  it("rejects identifier-like names", () => {
    expect(readTrustedWhatsAppDisplayName("155280281211126@lid")).toBeUndefined();
    expect(readTrustedWhatsAppDisplayName("+84905113232")).toBeUndefined();
    expect(readTrustedWhatsAppDisplayName("  ")).toBeUndefined();
    expect(readTrustedWhatsAppDisplayName("Alice")).toBe("Alice");
  });

  it("formats an authoritative reply with the trusted display name", () => {
    expect(
      formatAuthoritativeGroupReplyText({
        body: "Here is the answer",
        displayName: "Alice",
        otherParticipantNames: [],
      }),
    ).toBe("Alice, Here is the answer");
  });

  it("does not double-prefix an existing display name", () => {
    expect(
      formatAuthoritativeGroupReplyText({
        body: "Alice, Here is the answer",
        displayName: "Alice",
        otherParticipantNames: [],
      }),
    ).toBe("Alice, Here is the answer");
  });

  it("strips a leading other-participant guess", () => {
    expect(
      formatAuthoritativeGroupReplyText({
        body: "Văn Here is the answer",
        displayName: "Alice",
        otherParticipantNames: ["Văn"],
      }),
    ).toBe("Alice, Here is the answer");
  });
});
