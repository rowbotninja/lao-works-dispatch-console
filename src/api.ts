import { AuthTokens, Candidate, Job, Message, TimelineEvent } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/v1";

async function apiRequest<T>(
  path: string,
  init: RequestInit,
  accessToken?: string
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers ?? {})
    }
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload?.message ?? `Request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

export const login = (identifier: string, password: string): Promise<AuthTokens> =>
  apiRequest<AuthTokens>(
    "/auth/login",
    {
      method: "POST",
      body: JSON.stringify({ identifier, password })
    }
  );

export const getQueue = (accessToken: string): Promise<{ items: Job[] }> =>
  apiRequest<{ items: Job[] }>("/dispatch/jobs/queue", { method: "GET" }, accessToken);

export const getCandidates = (accessToken: string, jobId: string): Promise<{ candidates: Candidate[] }> =>
  apiRequest<{ candidates: Candidate[] }>(
    `/dispatch/jobs/${jobId}/candidates`,
    { method: "GET" },
    accessToken
  );

export const recomputeCandidates = (
  accessToken: string,
  jobId: string,
  maxCandidates = 10
): Promise<{ candidates: Candidate[] }> =>
  apiRequest<{ candidates: Candidate[] }>(
    `/dispatch/jobs/${jobId}/candidates/recompute`,
    {
      method: "POST",
      body: JSON.stringify({ maxCandidates })
    },
    accessToken
  );

export const assignWorker = (accessToken: string, jobId: string, workerId: string): Promise<Job> =>
  apiRequest<Job>(
    `/dispatch/jobs/${jobId}/assign`,
    {
      method: "POST",
      body: JSON.stringify({ workerId })
    },
    accessToken
  );

export const overrideWorker = (
  accessToken: string,
  jobId: string,
  workerId: string,
  reason: string
): Promise<Job> =>
  apiRequest<Job>(
    `/dispatch/jobs/${jobId}/override`,
    {
      method: "POST",
      body: JSON.stringify({ workerId, reason })
    },
    accessToken
  );

export const getTimeline = (accessToken: string, jobId: string): Promise<{ items: TimelineEvent[] }> =>
  apiRequest<{ items: TimelineEvent[] }>(`/jobs/${jobId}/timeline`, { method: "GET" }, accessToken);

export const getMessages = (accessToken: string, jobId: string): Promise<{ items: Message[] }> =>
  apiRequest<{ items: Message[] }>(`/jobs/${jobId}/messages`, { method: "GET" }, accessToken);

export const sendMessage = (accessToken: string, jobId: string, body: string): Promise<Message> =>
  apiRequest<Message>(
    `/jobs/${jobId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body })
    },
    accessToken
  );
