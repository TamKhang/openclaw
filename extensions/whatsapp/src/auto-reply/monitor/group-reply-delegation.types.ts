// WhatsApp plugin defines the durable GroupReplyDelegation contract.
export type GroupReplyOnceTarget = {
  participantId: string;
  displayName?: string;
  e164?: string;
  jid?: string;
  otherParticipantNames?: string[];
};

export type GroupReplyOnceAuthorization = {
  token: string;
  delegationId: string;
  sourceEventId: string;
  triggerVersion: string;
  groupId: string;
  chatId: string;
  quotedMessageId: string;
  quotedBody: string;
  target: GroupReplyOnceTarget;
  ownerTriggerMessageId: string;
  ownerSenderId: string;
  createdAt: number;
  expiresAt: number;
  maxSends: 1;
  consumed: boolean;
  consumedAt?: number;
  outboundMessageId?: string;
};
