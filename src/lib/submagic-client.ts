const SUBMAGIC_BASE = "https://api.submagic.co/v1";

interface CreateProjectParams {
  composedVideoUrl: string;
  title: string;
  templateName: string;
  language: string;
  magicZooms: boolean;
  magicBrolls: boolean;
  magicBrollsPercentage: number;
  removeBadTakes: boolean;
  removeSilencePace: string;
  cleanAudio: boolean;
}

interface ExportParams {
  width: number;
  height: number;
  fps: number;
}

interface SubmagicProject {
  id: string;
  status: string;
  directUrl?: string;
  downloadUrl?: string;
}

async function submagicFetch(apiKey: string, path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${SUBMAGIC_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      ...options.headers,
    },
  });
  return res;
}

export async function createProject(apiKey: string, params: CreateProjectParams): Promise<{ id: string }> {
  const res = await submagicFetch(apiKey, "/projects", {
    method: "POST",
    body: JSON.stringify({
      videoUrl: params.composedVideoUrl,
      title: params.title,
      templateName: params.templateName,
      language: params.language,
      magicZooms: params.magicZooms,
      magicBrolls: params.magicBrolls,
      magicBrollsPercentage: params.magicBrollsPercentage,
      removeBadTakes: params.removeBadTakes,
      removeSilencePace: params.removeSilencePace,
      cleanAudio: params.cleanAudio,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Submagic create project failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { id: string };
  return { id: data.id };
}

export async function pollProjectCompletion(
  apiKey: string,
  projectId: string,
  intervalMs = 7000,
  timeoutMs = 300000,
): Promise<SubmagicProject> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await submagicFetch(apiKey, `/projects/${projectId}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Submagic poll failed (${res.status}): ${body}`);
    }

    const project = await res.json() as SubmagicProject;

    if (project.status === "completed") return project;
    if (project.status === "failed" || project.status === "error") {
      throw new Error(`Submagic project failed with status: ${project.status}`);
    }

    await sleep(intervalMs);
  }

  throw new Error("Submagic project completion timed out after 5 minutes");
}

export async function triggerExport(
  apiKey: string,
  projectId: string,
  params: ExportParams,
): Promise<void> {
  const res = await submagicFetch(apiKey, `/projects/${projectId}/export`, {
    method: "POST",
    body: JSON.stringify({
      width: params.width,
      height: params.height,
      fps: params.fps,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Submagic export trigger failed (${res.status}): ${body}`);
  }
}

export async function pollExportUrl(
  apiKey: string,
  projectId: string,
  intervalMs = 8000,
  timeoutMs = 180000,
): Promise<{ videoUrl: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await submagicFetch(apiKey, `/projects/${projectId}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Submagic export poll failed (${res.status}): ${body}`);
    }

    const project = await res.json() as SubmagicProject;
    const url = project.directUrl || project.downloadUrl;
    if (url) return { videoUrl: url };

    await sleep(intervalMs);
  }

  throw new Error("Submagic export URL timed out after 3 minutes");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
