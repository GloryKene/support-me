jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn().mockResolvedValue({ deletedAt: null }) },
    creator: {
      findUnique: jest.fn(),
    },
    withdrawal: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";
import { generateToken } from "../../middleware/auth";

const mockedPrisma = prisma as unknown as {
  creator: { findUnique: jest.Mock };
  withdrawal: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
};

describe("GET /api/withdrawals", () => {
  const token = generateToken(1, "GUSERADDRESS");

  it("rejects anonymous requests", async () => {
    const res = await request(app).get("/api/withdrawals");

    expect(res.status).toBe(401);
    expect(mockedPrisma.withdrawal.findMany).not.toHaveBeenCalled();
  });

  it("returns only the authenticated user's withdrawals", async () => {
    const withdrawals = [{ id: 1, creatorId: 1, amountIn: 5, currency: "USDC" }];
    mockedPrisma.withdrawal.findMany.mockResolvedValue(withdrawals);

    const res = await request(app)
      .get("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(withdrawals);
    expect(mockedPrisma.withdrawal.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: { creator: { userId: 1 } },
    });
  });

  it("filters by creatorUsername when provided as a query param", async () => {
    mockedPrisma.withdrawal.findMany.mockResolvedValue([]);

    await request(app)
      .get("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .query({ creatorUsername: "bob" });

    expect(mockedPrisma.withdrawal.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: { creator: { userId: 1, username: "bob" } },
    });
  });
});

describe("POST /api/withdrawals", () => {
  const token = generateToken(1, "GUSERADDRESS");

  it("rejects requests without an auth token", async () => {
    const res = await request(app)
      .post("/api/withdrawals")
      .send({ creatorUsername: "bob", amountIn: 10, anchorTxId: "tx-1" });

    expect(res.status).toBe(401);
  });

  it("rejects a request missing required fields with a validation error", async () => {
    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ amountIn: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the target creator does not exist", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ creatorUsername: "unknown", amountIn: 10, anchorTxId: "tx-1" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("rejects recording a withdrawal for a profile the user does not own", async () => {
    // Token is for userId 1; this profile belongs to userId 2.
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 9, userId: 2, username: "bob" });

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ creatorUsername: "bob", amountIn: 10, anchorTxId: "tx-1" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(mockedPrisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it("creates a withdrawal for the owning creator", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(null);
    const created = {
      id: 1,
      creatorId: 7,
      amountIn: 10,
      amountOut: 9.5,
      currency: "USDC",
      anchorTxId: "tx-1",
      status: "pending_anchor",
    };
    mockedPrisma.withdrawal.create.mockResolvedValue(created);

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        creatorUsername: "bob",
        amountIn: 10,
        amountOut: 9.5,
        fee: 0.5,
        anchorTxId: "tx-1",
        stellarTxId: "stellar-1",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    // The default `status` is "completed", but an unconfirmed self-report
    // can never be stored as completed (#393), so it is downgraded.
    expect(mockedPrisma.withdrawal.create).toHaveBeenCalledWith({
      data: {
        creatorId: 7,
        amountIn: 10,
        amountOut: 9.5,
        fee: 0.5,
        currency: "USDC",
        anchorTxId: "tx-1",
        stellarTxId: "stellar-1",
        status: "pending_anchor",
        verified: false,
      },
    });
  });

  it("downgrades a client-claimed completed status to pending_anchor (#393)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(null);
    mockedPrisma.withdrawal.create.mockResolvedValue({ id: 1 });

    await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        creatorUsername: "bob",
        amountIn: 10,
        anchorTxId: "tx-1",
        status: "completed",
      });

    expect(mockedPrisma.withdrawal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "pending_anchor" }) })
    );
  });

  it("stores a non-completed status as reported (#393)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(null);
    mockedPrisma.withdrawal.create.mockResolvedValue({ id: 1 });

    await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        creatorUsername: "bob",
        amountIn: 10,
        anchorTxId: "tx-1",
        status: "error",
      });

    expect(mockedPrisma.withdrawal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "error" }) })
    );
  });

  it("stores verified: false regardless of the status the client sends (#393)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(null);
    mockedPrisma.withdrawal.create.mockResolvedValue({ id: 1 });

    await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        creatorUsername: "bob",
        amountIn: 10,
        anchorTxId: "tx-1",
        status: "completed",
      });

    expect(mockedPrisma.withdrawal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ verified: false }) })
    );
  });

  it("rejects a status outside the SEP-24 withdraw status enum (#393)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        creatorUsername: "bob",
        amountIn: 10,
        anchorTxId: "tx-1",
        status: "not_a_real_sep24_status",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(mockedPrisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it("accepts every SEP-24 withdraw status value (#393)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(null);

    const sep24Statuses = [
      "incomplete",
      "pending_user_transfer_start",
      "pending_anchor",
      "pending_stellar",
      "pending_external",
      "completed",
      "refunded",
      "expired",
      "no_market",
      "too_small",
      "too_large",
      "error",
    ];

    for (const status of sep24Statuses) {
      mockedPrisma.withdrawal.create.mockResolvedValue({ id: 1, status });

      const res = await request(app)
        .post("/api/withdrawals")
        .set("Authorization", `Bearer ${token}`)
        .send({
          creatorUsername: "bob",
          amountIn: 10,
          anchorTxId: `tx-${status}`,
          status,
        });

      expect(res.status).toBe(201);
    }
  });

  it("is idempotent: a duplicate anchorTxId returns the existing record", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    const existing = { id: 1, creatorId: 7, amountIn: 10, anchorTxId: "tx-1" };
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(existing);

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ creatorUsername: "bob", amountIn: 10, anchorTxId: "tx-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(existing);
    expect(mockedPrisma.withdrawal.create).not.toHaveBeenCalled();
  });
});
