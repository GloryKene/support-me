import * as jwt from "jsonwebtoken";
import { z } from "zod";
import { getJwtSecret } from "../config";

export const JWT_ALGORITHM = "HS256" as const;
export const JWT_ISSUER = "support-me";
export const JWT_AUDIENCE = "support-me-api";

/**
 * The only claims this service relies on. Zod validates the decoded payload
 * before anything is attached to `req.user`, so a signed token with a missing
 * or wrong-typed `id` can never reach a route handler (#390).
 */
const tokenPayloadSchema = z.object({
  id: z.number().int().positive(),
  walletAddress: z.string().nullable().optional().default(null),
});

export interface TokenPayload {
  id: number;
  walletAddress: string | null;
}

/** Sign a token with the pinned algorithm and service-scoped claims. */
export function signToken(userId: number, walletAddress: string | null): string {
  return jwt.sign({ id: userId, walletAddress }, getJwtSecret(), {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "7d",
  });
}

/**
 * A token is legacy only when it carries neither `iss` nor `aud`. Tokens that
 * assert a wrong issuer or audience are never downgraded to the legacy path.
 * This bridge is intentional for one release so sessions issued before the
 * claim change keep working; remove it after that release and require a fresh
 * sign-in.
 */
function isLegacyToken(token: string): boolean {
  const decoded = jwt.decode(token);
  if (typeof decoded !== "object" || decoded === null) return false;
  return !("iss" in decoded) && !("aud" in decoded);
}

/**
 * Verify signature, algorithm, issuer and audience, then validate the payload
 * shape. Invalid or unverifiable tokens throw; callers decide how to map that
 * to an HTTP response.
 */
export function verifyToken(token: string): TokenPayload {
  try {
    return tokenPayloadSchema.parse(
      jwt.verify(token, getJwtSecret(), {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      })
    );
  } catch (error) {
    if (!isLegacyToken(token)) throw error;
    return tokenPayloadSchema.parse(
      jwt.verify(token, getJwtSecret(), {
        algorithms: [JWT_ALGORITHM],
      })
    );
  }
}
