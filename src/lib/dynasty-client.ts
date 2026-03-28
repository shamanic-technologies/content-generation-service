/**
 * HTTP client for resolving dynasty slugs from workflow-service and features-service.
 * Used by stats endpoints to filter/group by dynasty slug.
 */

const WORKFLOW_SERVICE_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:3040";
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY || "";
const FEATURES_SERVICE_URL = process.env.FEATURES_SERVICE_URL || "http://localhost:3050";
const FEATURES_SERVICE_API_KEY = process.env.FEATURES_SERVICE_API_KEY || "";

interface DynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

/**
 * Resolve a workflow dynasty slug into all its versioned slugs.
 * Returns an empty array if the dynasty is not found.
 */
export async function resolveWorkflowDynastySlugs(dynastySlug: string): Promise<string[]> {
  const url = `${WORKFLOW_SERVICE_URL}/workflows/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  const res = await fetch(url, {
    headers: {
      "X-Api-Key": WORKFLOW_SERVICE_API_KEY,
    },
  });

  if (!res.ok) {
    console.warn(`[content-generation-service] Failed to resolve workflow dynasty slug "${dynastySlug}": ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { slugs: string[] };
  return data.slugs ?? [];
}

/**
 * Resolve a feature dynasty slug into all its versioned slugs.
 * Returns an empty array if the dynasty is not found.
 */
export async function resolveFeatureDynastySlugs(dynastySlug: string): Promise<string[]> {
  const url = `${FEATURES_SERVICE_URL}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
  const res = await fetch(url, {
    headers: {
      "X-Api-Key": FEATURES_SERVICE_API_KEY,
    },
  });

  if (!res.ok) {
    console.warn(`[content-generation-service] Failed to resolve feature dynasty slug "${dynastySlug}": ${res.status}`);
    return [];
  }

  const data = (await res.json()) as { slugs: string[] };
  return data.slugs ?? [];
}

/**
 * Fetch all workflow dynasties and build a reverse map: slug -> dynastySlug.
 */
export async function getWorkflowDynastyMap(): Promise<Map<string, string>> {
  const url = `${WORKFLOW_SERVICE_URL}/workflows/dynasties`;
  const res = await fetch(url, {
    headers: {
      "X-Api-Key": WORKFLOW_SERVICE_API_KEY,
    },
  });

  if (!res.ok) {
    console.warn(`[content-generation-service] Failed to fetch workflow dynasties: ${res.status}`);
    return new Map();
  }

  const data = (await res.json()) as { dynasties: DynastyEntry[] };
  return buildSlugToDynastyMap(data.dynasties ?? []);
}

/**
 * Fetch all feature dynasties and build a reverse map: slug -> dynastySlug.
 */
export async function getFeatureDynastyMap(): Promise<Map<string, string>> {
  const url = `${FEATURES_SERVICE_URL}/features/dynasties`;
  const res = await fetch(url, {
    headers: {
      "X-Api-Key": FEATURES_SERVICE_API_KEY,
    },
  });

  if (!res.ok) {
    console.warn(`[content-generation-service] Failed to fetch feature dynasties: ${res.status}`);
    return new Map();
  }

  const data = (await res.json()) as { dynasties: DynastyEntry[] };
  return buildSlugToDynastyMap(data.dynasties ?? []);
}

function buildSlugToDynastyMap(dynasties: DynastyEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) map.set(slug, d.dynastySlug);
  }
  return map;
}
