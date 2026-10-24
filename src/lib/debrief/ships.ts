/**
 * Does this industry debrief render SHIP (DRY-RUN-RENDER-1024)? Only a render that goes on to be
 * published is a delivered `industry_update_video`. A staff dry run (the Social post workflow's
 * `inputs.dryRun: true`, which stops before publishing) is a test: its run opens marked support
 * `staff_experiment` and it declares no outcome.
 *
 * A render ships when the caller did not say `dryRun: true` AND it runs under a campaign: a live
 * Social post run always has its campaign (workflow-service's plan-day refuses a live run without
 * one), so a render with no campaign is a staff probe whatever the body says.
 *
 * The outcome sweep applies the same rule in SQL on the stored row (`pendingRenders` in
 * outcome-declarations.ts): `request.dryRun` and `tracking.campaignId` are both stored at insert.
 * Standalone leaf.
 */
export function renderShips(input: { dryRun?: boolean | null; campaignId?: string | null }): boolean {
  return input.dryRun !== true && typeof input.campaignId === "string" && input.campaignId.length > 0;
}

export const DRY_RUN_SUPPORT = {
  kind: "staff_experiment",
  reason: "industry debrief dry run or render with no campaign: a staff test, never published",
} as const;
