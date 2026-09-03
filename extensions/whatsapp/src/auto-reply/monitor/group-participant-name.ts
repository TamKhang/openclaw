// WhatsApp plugin resolves the authoritative group participant name for an
// owner-delegated reply. Recent-sender rosters are intentionally not the only
// source: Baileys group metadata participants carry the human names.
import type { GroupMetadata, GroupParticipant } from "baileys";
import {
  identitiesOverlap,
  resolveComparableIdentity,
  type WhatsAppIdentity,
} from "../../identity.js";
import { getReplyContext } from "../../identity.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";

export type WhatsAppGroupMetadataResolver = (
  groupId: string,
) => Promise<GroupMetadata | null | undefined>;

export type GroupReplyAddressee = {
  displayName?: string;
  otherParticipantNames: string[];
};

const WHATSAPP_IDENTIFIER_LOOKALIKE_RE =
  /(?:^\+?[\d\s().-]{5,}$)|@(?:s\.whatsapp\.net|lid|hosted\.lid|g\.us)$/i;

function readNonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function readTrustedWhatsAppDisplayName(value: unknown): string | undefined {
  const trimmed = readNonBlankString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase() === "unknown sender") {
    return undefined;
  }
  if (WHATSAPP_IDENTIFIER_LOOKALIKE_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function pickParticipantDisplayName(participant: GroupParticipant): string | undefined {
  const candidates = [
    participant.verifiedName,
    participant.notify,
    participant.name,
    participant.username,
  ];
  for (const candidate of candidates) {
    const displayName = readTrustedWhatsAppDisplayName(candidate);
    if (displayName) {
      return displayName;
    }
  }
  return undefined;
}

function participantMatchesSender(
  participant: GroupParticipant,
  sender: WhatsAppIdentity | null,
): boolean {
  if (!sender) {
    return false;
  }
  const candidateIdentities: Array<WhatsAppIdentity> = [
    resolveComparableIdentity({
      jid: participant.id ?? null,
      lid: participant.lid ?? null,
      e164: null,
    }),
  ];
  if (participant.phoneNumber && participant.phoneNumber !== participant.id) {
    candidateIdentities.push(
      resolveComparableIdentity({
        jid: participant.phoneNumber,
        lid: participant.lid ?? null,
        e164: null,
      }),
    );
  }
  return candidateIdentities.some((participantIdentity) =>
    identitiesOverlap(sender, participantIdentity),
  );
}

function collectKnownParticipantNames(metadata: GroupMetadata | null | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const participant of metadata?.participants ?? []) {
    const displayName = pickParticipantDisplayName(participant);
    if (!displayName || seen.has(displayName)) {
      continue;
    }
    seen.add(displayName);
    names.push(displayName);
  }
  return names;
}

export function resolveGroupParticipantName(params: {
  metadata: GroupMetadata | null | undefined;
  sender: WhatsAppIdentity | null;
}): GroupReplyAddressee {
  const knownNames = collectKnownParticipantNames(params.metadata);
  if (!params.metadata || !params.sender) {
    return { otherParticipantNames: knownNames };
  }
  const matched = params.metadata.participants.find((participant) =>
    participantMatchesSender(participant, params.sender),
  );
  const displayName = matched ? pickParticipantDisplayName(matched) : undefined;
  return {
    ...(displayName ? { displayName } : {}),
    otherParticipantNames: knownNames.filter((name) => name !== displayName),
  };
}

export async function resolveAuthoritativeGroupReplyTarget(params: {
  msg: AdmittedWebInboundMessage;
  authDir?: string;
  groupId: string;
  resolveGroupMetadata?: WhatsAppGroupMetadataResolver;
}): Promise<GroupReplyAddressee> {
  if (!params.resolveGroupMetadata) {
    return { otherParticipantNames: [] };
  }
  const replyContext = getReplyContext(params.msg, params.authDir);
  if (!replyContext?.id || !replyContext.sender) {
    return { otherParticipantNames: [] };
  }
  let metadata: GroupMetadata | null | undefined;
  try {
    metadata = await params.resolveGroupMetadata(params.groupId);
  } catch {
    return { otherParticipantNames: [] };
  }
  return resolveGroupParticipantName({ metadata, sender: replyContext.sender });
}

export function buildGroupReplyAgentBody(params: { quotedBody: string }): string {
  const quotedBody = params.quotedBody.trim();
  return [
    "Owner delegated you to reply to the quoted group member.",
    "Quoted message:",
    '"""',
    quotedBody,
    '"""',
    "Answer only the quoted message. Do not greet the owner, do not address any person by name, and do not infer or invent a participant name from history, memory, or prior messages. The system controls the addressee.",
  ].join("\n");
}

function startsWithDisplayName(body: string, displayName: string): boolean {
  return body.startsWith(displayName) && /[\s,]/.test(body[displayName.length] ?? " ");
}

function stripLeadingParticipantNameGuess(
  body: string,
  trustedName: string | undefined,
  otherParticipantNames: readonly string[],
): string {
  const candidates = [...otherParticipantNames]
    .filter((name): name is string => Boolean(name) && name !== trustedName)
    .sort((left, right) => right.length - left.length);
  const leading = body.slice(0, 200);
  let bestIndex = -1;
  let bestEnd = 0;
  for (const name of candidates) {
    const index = leading.indexOf(name);
    if (index < 0) {
      continue;
    }
    if (bestIndex === -1 || index < bestIndex) {
      bestIndex = index;
      bestEnd = index + name.length;
    }
  }
  if (bestIndex < 0) {
    return body;
  }
  return body.slice(bestEnd).replace(/^[\s,!.…]*/u, "");
}

export function formatAuthoritativeGroupReplyText(params: {
  body: string;
  displayName?: string;
  otherParticipantNames?: readonly string[];
}): string {
  const trimmed = params.body.trim();
  const body = stripLeadingParticipantNameGuess(
    trimmed,
    params.displayName,
    params.otherParticipantNames ?? [],
  );
  if (!params.displayName) {
    return body;
  }
  if (startsWithDisplayName(body, params.displayName)) {
    return body;
  }
  return `${params.displayName}, ${body}`;
}
