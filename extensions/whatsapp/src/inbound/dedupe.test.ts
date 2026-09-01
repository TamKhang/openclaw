// WhatsApp tests cover the persistent inbound dedupe boundary used by
// observation and reply delivery so a replayed source event cannot be
// processed twice through either path.
import { beforeEach, describe, expect, it, vi } from "vitest";

const createClaimableDedupeMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/persistent-dedupe", () => ({
  createClaimableDedupe: createClaimableDedupeMock,
}));

vi.mock("../runtime.js", () => ({
  getOptionalWhatsAppRuntime: () => undefined,
}));

import {
  claimRecentInboundMessageDelivery,
  commitRecentInboundMessage,
  releaseRecentInboundMessage,
  resetWebInboundDedupe,
} from "./dedupe.js";

function currentClaimable() {
  const created = createClaimableDedupeMock.mock.results.at(-1)?.value as {
    claim: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    clearMemory: ReturnType<typeof vi.fn>;
  };
  if (!created) {
    throw new Error("expected claimable dedupe to be created");
  }
  return created;
}

describe("WhatsApp persistent inbound dedupe", () => {
  beforeEach(() => {
    createClaimableDedupeMock.mockReset();
    createClaimableDedupeMock.mockReturnValue({
      claim: vi.fn(),
      commit: vi.fn(),
      release: vi.fn(),
      clearMemory: vi.fn(),
    });
    // The first reset clears the cached singleton from the previous test; the
    // second reset creates the fresh mock-backed instance used by this test.
    resetWebInboundDedupe();
    resetWebInboundDedupe();
  });

  it("claims a stable source key once and reports a replay as duplicate", async () => {
    const dedupe = currentClaimable();
    dedupe.claim
      .mockResolvedValueOnce({ kind: "claimed" })
      .mockResolvedValueOnce({ kind: "duplicate" });

    await expect(
      claimRecentInboundMessageDelivery("default:group@g.us:owner-trigger-1"),
    ).resolves.toBe("claimed");
    await expect(
      claimRecentInboundMessageDelivery("default:group@g.us:owner-trigger-1"),
    ).resolves.toBe("duplicate");

    expect(dedupe.claim).toHaveBeenCalledTimes(2);
    expect(dedupe.claim).toHaveBeenNthCalledWith(2, "default:group@g.us:owner-trigger-1");
  });

  it("commits and releases through the same durable dedupe instance", async () => {
    const dedupe = currentClaimable();
    dedupe.claim.mockResolvedValue({ kind: "claimed" });

    await claimRecentInboundMessageDelivery("default:group@g.us:msg-2");
    await commitRecentInboundMessage("default:group@g.us:msg-2");
    releaseRecentInboundMessage("default:group@g.us:msg-2", new Error("retry"));

    expect(dedupe.commit).toHaveBeenCalledWith("default:group@g.us:msg-2");
    expect(dedupe.release).toHaveBeenCalledWith("default:group@g.us:msg-2", {
      error: expect.any(Error),
    });
  });
});
