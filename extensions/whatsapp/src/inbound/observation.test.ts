import { describe, expect, it } from "vitest";
import { shouldEmitWhatsAppMessageReceivedHooks } from "./observation.js";

describe("emitBlockedWhatsAppGroupObservation", () => {
  it("does not emit when hooks are not opted in", () => {
    expect(shouldEmitWhatsAppMessageReceivedHooks({ cfg: {} as never })).toBe(false);
  });

  it("honors the opt-in flag", () => {
    expect(
      shouldEmitWhatsAppMessageReceivedHooks({
        cfg: {
          channels: {
            whatsapp: {
              pluginHooks: { messageReceived: true },
            },
          },
        } as never,
      }),
    ).toBe(true);
  });

  it("does not emit an observation-only hook when no valid body/group context exists", () => {
    expect(
      shouldEmitWhatsAppMessageReceivedHooks({
        cfg: {
          channels: {
            whatsapp: {
              accounts: {
                default: {
                  pluginHooks: { messageReceived: false },
                },
              },
            },
          },
        } as never,
        accountId: "default",
      }),
    ).toBe(false);
  });
});
