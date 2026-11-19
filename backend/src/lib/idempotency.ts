import { createHash } from "node:crypto";

/**
 * The donation fields that identify a request for idempotency purposes (#391).
 * `message` is deliberately excluded: changing a display-only note must not
 * turn a retry of the same donation into a conflict.
 */
export interface DonationRequestIdentity {
  creatorUsername: string;
  senderAddress: string;
  amount: number;
  currency: string;
  transactionHash: string;
}

/**
 * Build a stable SHA-256 fingerprint of the canonical donation identity.
 * The object literal fixes key order so equivalent requests always hash the
 * same way, regardless of the order of keys in the incoming JSON body.
 */
export function hashDonationRequest(identity: DonationRequestIdentity): string {
  const canonical = JSON.stringify({
    creatorUsername: identity.creatorUsername,
    senderAddress: identity.senderAddress,
    amount: identity.amount,
    currency: identity.currency,
    transactionHash: identity.transactionHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
