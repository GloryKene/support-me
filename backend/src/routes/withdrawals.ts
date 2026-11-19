import { Router } from "express";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import { createWithdrawalSchema, listWithdrawalsQuerySchema } from "../schemas/withdrawals";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../errors/AppError";

const router = Router();

router.get(
  "/",
  authMiddleware,
  validate({ query: listWithdrawalsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { creatorUsername } = req.query as { creatorUsername?: string };

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const withdrawals = await prisma.withdrawal.findMany({
      orderBy: { createdAt: "desc" },
      where: {
        creator: {
          userId: req.user.id,
          ...(creatorUsername ? { username: creatorUsername } : {}),
        },
      },
    });

    return res.json(withdrawals);
  })
);

router.post(
  "/",
  authMiddleware,
  validate({ body: createWithdrawalSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { creatorUsername, amountIn, amountOut, fee, currency, anchorTxId, stellarTxId, status } =
      req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const creator = await prisma.creator.findUnique({ where: { username: creatorUsername } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    // Withdrawals are self-reported by the account holder after a cash-out, so
    // only the owner may record one against their own history.
    if (creator.userId !== req.user.id) {
      throw new ForbiddenError("You can only record withdrawals for your own profile");
    }

    // Idempotent on the anchor transaction id: the completion path can fire more
    // than once, but a given cash-out should appear exactly once in the feed.
    const existing = await prisma.withdrawal.findUnique({
      where: { creatorId_anchorTxId: { creatorId: creator.id, anchorTxId } },
    });
    if (existing) {
      return res.status(200).json(existing);
    }

    // Self-reported, never trusted as real (#393): a withdrawal can only
    // become `verified: true` through an independent confirmation against
    // the anchor's `/transaction` endpoint or Horizon. That lookup isn't
    // implemented yet, so every withdrawal is stored unverified, matching
    // how donations already treat a client report, and is excluded from the
    // dashboard's verified-only totals regardless of the status the client
    // sent.
    //
    // A client claiming `completed` is the strongest case for mistrust: it
    // asserts the cash-out already finished with no way here to confirm that
    // against the anchor or chain. Store it as `pending_anchor` (SEP-24's
    // "anchor hasn't confirmed yet" status) instead, so a completed record
    // always reflects a real confirmation rather than a bare self-report.
    // Any other status (`error`, `refunded`, etc.) is stored as reported.
    const storedStatus = status === "completed" ? "pending_anchor" : status;

    const withdrawal = await prisma.withdrawal.create({
      data: {
        creatorId: creator.id,
        amountIn,
        amountOut,
        fee,
        currency,
        anchorTxId,
        stellarTxId,
        status: storedStatus,
        verified: false,
      },
    });

    return res.status(201).json(withdrawal);
  })
);

export default router;
