/**
 * Runs one stored script of workflow-service under the caller's identity (`POST /orgs/scripts/run`): the script's own
 * run is a child of the caller's run, its vendors (chat-service) are billed to the caller's org. Used by the signed-out
 * preview (PREVIEW-EMAIL-503-1111) to have the email Engine's script write the example, exactly as a campaign run does.
 */
import { type Tracking, buildTrackingHeaders } from "./tracking.js";

const WORKFLOW_SERVICE_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:3040";
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY || "";

export interface ScriptRunRequest {
  outcome: string;
  dynasty: string;
  version?: number;
  subject: { service: string; id: string };
  units: Record<string, unknown>;
  tactics?: Record<string, unknown>;
  recordedBy?: "content-generation";
  trace?: boolean;
}

/** workflow-service refused or the script failed: carried with the status the caller should answer. */
export class ScriptRunError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ScriptRunError";
  }
}

/** A chat vendor refusal for lack of credit, as the failed run's vendor calls report it. */
function refusedForCredit(details: unknown): boolean {
  const calls = (details as { vendorCalls?: Array<{ ok?: boolean; error?: string }> } | null)?.vendorCalls ?? [];
  return calls.some((c) => c?.ok === false && typeof c.error === "string" && /\b402\b|insufficient credit/i.test(c.error));
}

/** The script run's whole answer (`RunScriptResponse`), whatever its status; a failed run throws `ScriptRunError`. */
export async function runScript(body: ScriptRunRequest, identity: Tracking): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${WORKFLOW_SERVICE_URL}/orgs/scripts/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": WORKFLOW_SERVICE_API_KEY, ...buildTrackingHeaders(identity) },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ScriptRunError(502, `workflow-service unreachable running script ${body.outcome}/${body.dynasty}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let parsed: { error?: string; details?: unknown } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const message = `workflow-service script ${body.outcome}/${body.dynasty} failed: ${res.status} - ${parsed?.error ?? text}`;
    const status = res.status === 402 || refusedForCredit(parsed?.details) ? 402 : 502;
    throw new ScriptRunError(status, message);
  }
  return JSON.parse(text) as Record<string, unknown>;
}
