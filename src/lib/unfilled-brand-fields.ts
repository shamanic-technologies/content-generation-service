/**
 * The brand-service extract-fields request for template inputs nothing else filled
 * (`/generate` "Convention 1"): one field per `{{token}}` left, keyed on the token. Shared by
 * `/generate` and `/preview-email`, so a preview asks brand-service the very question a
 * campaign run asks and is answered from the same 30-day cache. Standalone leaf (never
 * `vi.mock`'d).
 */
export function unfilledBrandFieldRequests(keys: readonly string[]): Array<{ key: string; description: string }> {
  return keys.map((key) => ({ key, description: `Value for the "${key}" field needed in content generation` }));
}
