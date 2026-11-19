-- AlterTable
-- Nullable so keys issued before this change remain valid rows. They carry no
-- verifiable request hash, so a replay is rejected as a mismatch instead of
-- silently returning a donation that may belong to a different request.
ALTER TABLE "DonationIdempotencyKey" ADD COLUMN "requestHash" TEXT;
