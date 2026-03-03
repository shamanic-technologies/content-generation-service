import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  orgId?: string;
  userId?: string;
  runId?: string;
}

const API_KEY = process.env.CONTENT_GENERATION_SERVICE_API_KEY;

/**
 * Global middleware — validates X-Api-Key header on every request.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) {
    console.error("[auth] CONTENT_GENERATION_SERVICE_API_KEY is not set — rejecting request");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  const provided = req.headers["x-api-key"] as string | undefined;
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }

  next();
}

/**
 * Middleware for service calls — extracts internal org/user UUIDs from headers.
 * x-org-id and x-user-id carry internal UUIDs directly from client-service.
 */
export async function serviceAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const runId = req.headers["x-run-id"] as string;

  if (!orgId) {
    return res.status(400).json({ error: "x-org-id header required" });
  }

  if (!userId) {
    return res.status(400).json({ error: "x-user-id header required" });
  }

  if (!runId) {
    return res.status(400).json({ error: "x-run-id header required" });
  }

  req.orgId = orgId;
  req.userId = userId;
  req.runId = runId;
  next();
}
