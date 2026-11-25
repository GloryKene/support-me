const mockLog = jest.fn();
jest.mock("../../lib/logger", () => ({ log: mockLog }));

import express, { Request, Response, Router } from "express";
import request from "supertest";
import { getRequestPath, requestLogger } from "../../middleware/requestLogger";
import { errorHandler } from "../../middleware/errorHandler";

function mockReqRes(headers: Record<string, string> = {}) {
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    method: "GET",
    path: "/api/goals/bob",
    query: { secret: "shh" },
  } as unknown as Request;

  const finishHandlers: Array<() => void> = [];
  const res = {
    statusCode: 200,
    setHeader: jest.fn(),
    on: jest.fn((event: string, handler: () => void) => {
      if (event === "finish") finishHandlers.push(handler);
    }),
  } as unknown as Response;

  const next = jest.fn();
  const finish = () => finishHandlers.forEach((h) => h());

  return { req, res, next, finish };
}

describe("requestLogger middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("generates a requestId when no X-Request-Id header is present and echoes it back", () => {
    const { req, res, next } = mockReqRes();

    requestLogger(req, res, next);

    expect(req.requestId).toBeDefined();
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", req.requestId);
    expect(next).toHaveBeenCalledWith();
  });

  it("honours an inbound X-Request-Id instead of generating a new one", () => {
    const { req, res, next } = mockReqRes({ "x-request-id": "client-provided-id" });

    requestLogger(req, res, next);

    expect(req.requestId).toBe("client-provided-id");
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", "client-provided-id");
  });

  it("truncates an inbound X-Request-Id longer than 64 characters", () => {
    const longId = "a".repeat(100);
    const { req, res, next } = mockReqRes({ "x-request-id": longId });

    requestLogger(req, res, next);

    expect(req.requestId).toHaveLength(64);
    expect(req.requestId).toBe(longId.slice(0, 64));
  });

  it("logs exactly one line per request, on response finish, with method/path/status/duration/requestId", () => {
    const { req, res, next, finish } = mockReqRes({ "x-request-id": "req-abc" });

    requestLogger(req, res, next);
    res.statusCode = 201;
    finish();

    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledWith(
      "info",
      "request completed",
      expect.objectContaining({
        requestId: "req-abc",
        method: "GET",
        path: "/api/goals/bob",
        status: 201,
        durationMs: expect.any(Number),
      })
    );
  });

  it("logs at 'warn' for a 4xx response and 'error' for a 5xx response", () => {
    const { req, res, next, finish } = mockReqRes();
    requestLogger(req, res, next);

    res.statusCode = 404;
    finish();
    expect(mockLog).toHaveBeenLastCalledWith("warn", "request completed", expect.any(Object));

    const { req: req2, res: res2, next: next2, finish: finish2 } = mockReqRes();
    requestLogger(req2, res2, next2);
    res2.statusCode = 500;
    finish2();
    expect(mockLog).toHaveBeenLastCalledWith("error", "request completed", expect.any(Object));
  });

  it("never includes the query string or request body in the log line", () => {
    const { req, res, next, finish } = mockReqRes();

    requestLogger(req, res, next);
    finish();

    const [, , context] = mockLog.mock.calls[0];
    expect(context).not.toHaveProperty("query");
    expect(context).not.toHaveProperty("body");
    expect(JSON.stringify(context)).not.toContain("shh");
  });

  describe("getRequestPath helper", () => {
    it("extracts path from req.originalUrl and strips query parameters", () => {
      const req = { originalUrl: "/api/creators/bob?tab=activity&token=123" } as Request;
      expect(getRequestPath(req)).toBe("/api/creators/bob");
    });

    it("returns originalUrl as-is when no query string is present", () => {
      const req = { originalUrl: "/api/creators/bob" } as Request;
      expect(getRequestPath(req)).toBe("/api/creators/bob");
    });

    it("falls back to req.url or req.path if originalUrl is undefined", () => {
      const reqWithUrl = { url: "/api/donations?page=1" } as Request;
      expect(getRequestPath(reqWithUrl)).toBe("/api/donations");

      const reqWithPath = { path: "/api/health" } as Request;
      expect(getRequestPath(reqWithPath)).toBe("/api/health");
    });
  });

  describe("mounted router integration (Issue #535)", () => {
    it("logs the full route path when response ends in a mounted router, excluding query strings", async () => {
      const app = express();
      app.use(requestLogger);

      const creatorRouter = Router();
      creatorRouter.get("/bob", (_req, res) => {
        res.status(200).json({ name: "bob" });
      });
      app.use("/api/creators", creatorRouter);

      const response = await request(app).get("/api/creators/bob?secret=token&view=compact");
      expect(response.status).toBe(200);

      expect(mockLog).toHaveBeenCalledWith(
        "info",
        "request completed",
        expect.objectContaining({
          method: "GET",
          path: "/api/creators/bob",
          status: 200,
        })
      );
    });

    it("logs consistent full paths for both error handler and request completion on mounted routers", async () => {
      const app = express();
      app.use(requestLogger);

      const creatorRouter = Router();
      creatorRouter.get("/error-route", (_req, _res, next) => {
        next(new Error("unexpected failure"));
      });
      app.use("/api/creators", creatorRouter);
      app.use(errorHandler);

      const response = await request(app).get("/api/creators/error-route?query=test");
      expect(response.status).toBe(500);

      // Verify errorHandler logged full path
      expect(mockLog).toHaveBeenCalledWith(
        "error",
        "unhandled error",
        expect.objectContaining({
          path: "/api/creators/error-route",
        })
      );

      // Verify requestLogger logged the same full path
      expect(mockLog).toHaveBeenCalledWith(
        "error",
        "request completed",
        expect.objectContaining({
          path: "/api/creators/error-route",
          status: 500,
        })
      );
    });
  });
});
