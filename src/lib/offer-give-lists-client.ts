/**
 * Reads an offer's confirmed give lists (`giveForFree`, `neverGive`) from
 * brand-service's user-fields view.
 *
 * Read here, by the `offerId` + `brandId` every campaign generation already
 * carries (workflow-service injects `offerId` into every `/generate` body at
 * compile time), rather than threaded through the workflow DAGs: every active
 * cold-email workflow picks the lists up at once, with no DAG edited.
 *
 * Deliberately NOT extract-fields: that route answers an unconfirmed key by
 * extracting a value from the brand's website, which would put an invented
 * "free audit" in the customer's mouth. The user-fields view does no extraction,
 * and only its CONFIRMED half is used (see offer-give-lists.ts).
 */

import { type Tracking, buildTrackingHeaders } from "./tracking.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { type OfferGiveLists, parseOfferGiveLists } from "./offer-give-lists.js";

const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL || "http://localhost:3030";
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY || "";

/** brand-service refused the user-fields read; carries its status so a caller can answer in kind. */
export class OfferGiveListsError extends Error {
  constructor(public status: number, public body: string) {
    super(`brand-service user-fields read failed: ${status} - ${body}`);
    this.name = "OfferGiveListsError";
  }
}

/**
 * The offer's confirmed give lists. With `offerId`, that offer's; without it, the
 * brand's sole offer (brand-service answers 409 SEVERAL_OFFERS for a brand selling
 * several — an offer is never guessed here).
 *
 * Returns null when the request names no single brand: an offer belongs to ONE
 * brand, so a multi-brand generation has no lists to read. Throws
 * `OfferGiveListsError` on any brand-service refusal; the caller decides whether
 * that fails its request.
 */
export async function fetchOfferGiveLists(identity: Tracking): Promise<OfferGiveLists | null> {
  const brandId = identity.brandId;
  if (!brandId || brandId.includes(",")) return null;

  const path = identity.offerId
    ? `/orgs/brands/${encodeURIComponent(brandId)}/offers/${encodeURIComponent(identity.offerId)}/user-fields`
    : `/orgs/brands/${encodeURIComponent(brandId)}/user-fields`;

  const response = await fetchWithRetry(
    `${BRAND_SERVICE_URL}${path}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": BRAND_SERVICE_API_KEY,
        ...buildTrackingHeaders(identity),
      },
    },
    { label: "brand-service GET user-fields" }
  );

  if (!response.ok) {
    throw new OfferGiveListsError(response.status, await response.text());
  }
  return parseOfferGiveLists(await response.json());
}
