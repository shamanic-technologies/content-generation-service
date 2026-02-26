import { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { orgs } from "../db/schema.js";

export interface AuthenticatedRequest extends Request {
  orgId?: string;
  externalOrgId?: string;
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
 * Middleware for service calls — resolves org from X-Org-Id header.
 */
export async function serviceAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const externalOrgId = req.headers["x-org-id"] as string;

    if (!externalOrgId) {
      return res.status(400).json({ error: "x-org-id header required" });
    }

    // Find or create org
    let org = await db.query.orgs.findFirst({
      where: eq(orgs.externalOrgId, externalOrgId),
    });

    if (!org) {
      const [newOrg] = await db
        .insert(orgs)
        .values({ externalOrgId })
        .returning();
      org = newOrg;
    }

    req.orgId = org.id;
    req.externalOrgId = externalOrgId;
    next();
  } catch (error) {
    console.error("Auth error:", error);
    return res.status(401).json({ error: "Authentication failed" });
  }
}
