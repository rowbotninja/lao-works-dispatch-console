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
  workflowState?: string;
  publicStatus?: string;
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
  readReceiptsSummary?: {
    changeOrders?: { total: number; unreadForDispatch: number; lastReadAt: string | null };
    paymentRequests?: { total: number; unreadForDispatch: number; lastReadAt: string | null };
    messages?: { total: number; unreadForDispatch: number; lastReadAt: string | null };
  };
  availableWorkflowActions?: string[];
  location?: { lat: number; lon: number } | null;
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
  senderName?: string | null;
  senderRole?: string | null;
  body: string;
  attachmentObjectKey: string | null;
  audience?: "CLIENT" | "WORKER" | "BOTH";
  createdAt: string;
};

export type MapScope = "TODAY" | "FUTURE" | "PAST" | "ALL";

export type DispatchMapOverview = {
  generatedAt: string;
  scope?: MapScope;
  range?: {
    from: string;
    to: string;
  } | null;
  jobs: Array<{
    id: string;
    status: string;
    description: string;
    urgency: string;
    clientDisplayName: string;
    assignedWorkerId: string | null;
    assignedWorkerDisplayName: string | null;
    scheduleWindowStart: string | null;
    scheduleWindowEnd: string | null;
    location: { lat: number; lon: number };
  }>;
  workers: Array<{
    workerId: string;
    workerDisplayName: string;
    tier: string;
    reliabilityScore: number;
    ratingAverage: number;
    location: { lat: number; lon: number };
  }>;
  routeSuggestions: Array<{
    workerId: string;
    workerDisplayName: string;
    from: { lat: number; lon: number };
    toJobId: string;
    toJobDescription: string;
    toJobStatus: string;
    to: { lat: number; lon: number };
    distanceKm: number;
    estimatedDriveMinutes: number;
  }>;
};

export type DispatchCalendar = {
  range: {
    from: string;
    to: string;
  };
  workers: Array<{
    workerId: string;
    workerDisplayName: string;
    tier: string;
    availability: Array<{
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      timezone: string;
    }>;
    timeOff: Array<{
      id: string;
      startAt: string;
      endAt: string;
      reason: string | null;
    }>;
    scheduledJobs: Array<{
      id: string;
      status: string;
      description: string;
      urgency: string;
      scheduleWindowStart: string | null;
      scheduleWindowEnd: string | null;
      location: { lat: number; lon: number } | null;
    }>;
  }>;
  unassignedJobs: Array<{
    id: string;
    status: string;
    description: string;
    urgency: string;
    scheduleWindowStart: string | null;
    scheduleWindowEnd: string | null;
    location: { lat: number; lon: number } | null;
  }>;
};
