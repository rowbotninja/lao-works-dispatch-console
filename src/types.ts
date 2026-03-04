export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
};

export type Job = {
  id: string;
  clientId: string;
  clientName?: string | null;
  clientEmail?: string | null;
  clientOrganizationName?: string | null;
  clientDisplayName?: string;
  status: string;
  jobType: string;
  description: string;
  urgency: string;
  requiredSkills: string[];
  personalityPreferences: string[];
  scheduleWindowStart: string | null;
  scheduleWindowEnd: string | null;
  assignedWorkerId?: string | null;
  assignedWorkerName?: string | null;
  assignedWorkerEmail?: string | null;
  assignedWorkerDisplayName?: string | null;
  createdAt: string;
};

export type Candidate = {
  workerId: string;
  workerName?: string | null;
  workerEmail?: string | null;
  workerDisplayName?: string;
  score: number;
  rank: number;
  scoreBreakdown: Record<string, unknown>;
};

export type TimelineEvent = {
  id: string;
  eventType: string;
  actorUserId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type Message = {
  id: string;
  threadId: string;
  senderUserId: string;
  body: string;
  attachmentObjectKey: string | null;
  createdAt: string;
};
