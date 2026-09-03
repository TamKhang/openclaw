// Gateway RPC adapters for the fixed read-projection boundary.
//
// Both methods accept only the empty parameter object. They never accept a
// caller-selected plugin, tool, path, command, provider, source, or JSON
// payload; the fixed projection identity is host-owned.

import {
  FIXED_READ_PROJECTION_ID,
  getFixedReadProjectionStatus,
  invokeFixedReadProjection,
  resolveReadProjectionWorkspaceDir,
  type ReadProjectionOutcome,
} from "../read-projection.js";
import type { GatewayRequestHandlers } from "./types.js";

function readProjectionPayload(outcome: ReadProjectionOutcome): unknown {
  if (outcome.ok) {
    return {
      ok: true,
      projection: outcome.projection,
      result: outcome.result,
    };
  }
  return {
    ok: false,
    projection: outcome.projection,
    error: outcome.error,
  };
}

export const readProjectionHandlers: GatewayRequestHandlers = {
  "projection.read": async ({ params, respond, context }) => {
    const outcome = await invokeFixedReadProjection({
      projectionId: FIXED_READ_PROJECTION_ID,
      input: params,
      config: context.getRuntimeConfig(),
      workspaceDir: resolveReadProjectionWorkspaceDir(),
    });
    respond(true, readProjectionPayload(outcome));
  },
  "projection.status": async ({ params, respond, context }) => {
    const emptyParams = Object.keys(params).length === 0;
    if (!emptyParams) {
      respond(true, {
        ok: false,
        projection: FIXED_READ_PROJECTION_ID,
        error: {
          code: "invalid_input",
          message: "read projection accepts empty input only",
        },
      });
      return;
    }
    respond(true, {
      ok: true,
      projections: getFixedReadProjectionStatus({
        config: context.getRuntimeConfig(),
        workspaceDir: resolveReadProjectionWorkspaceDir(),
      }),
    });
  },
};
