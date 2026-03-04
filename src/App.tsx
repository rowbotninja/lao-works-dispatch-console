import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assignWorker,
  getCandidates,
  getDispatchCalendar,
  getMapOverview,
  getMessages,
  getQueue,
  getTimeline,
  login,
  recomputeCandidates,
  sendMessage,
  overrideWorker
} from "./api";
import { Candidate, DispatchCalendar, DispatchMapOverview, Job, Message, TimelineEvent } from "./types";

type Session = {
  accessToken: string;
  refreshToken: string;
};

type MessageThreadGroup = {
  senderUserId: string;
  startedAt: string;
  endedAt: string;
  items: Message[];
};

type MessageDayGroup = {
  dayKey: string;
  dayLabel: string;
  threads: MessageThreadGroup[];
};

type CandidateFactor = {
  label: string;
  score: number | null;
  weight: number | null;
  weighted: number | null;
  fallback: string | null;
};

type PayloadFact = {
  label: string;
  value: string;
};

const JOB_STATUSES = ["REQUESTED", "TRIAGED", "OFFERED", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
type StatusFilter = "ALL" | (typeof JOB_STATUSES)[number];

const URGENCY_LEVELS = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
type UrgencyFilter = "ALL" | (typeof URGENCY_LEVELS)[number];

const DEFAULT_SKILLS = [
  "ELECTRICAL",
  "PLUMBING",
  "HVAC",
  "CLEANING",
  "CARPENTRY",
  "PAINTING",
  "GENERAL_MAINTENANCE"
] as const;

const DEFAULT_PERSONALITY_TAGS = [
  "QUIET_FOCUSED",
  "TALKATIVE_FRIENDLY",
  "DETAIL_ORIENTED",
  "TEACHER_TYPE"
] as const;

type QueueSort = "NEWEST" | "OLDEST" | "URGENCY" | "STATUS";
type TimelineFilter = "ALL" | "ASSIGNMENT" | "LIFECYCLE" | "MESSAGING" | "SYSTEM";

const STATUS_SORT_PRIORITY: Record<string, number> = {
  REQUESTED: 0,
  TRIAGED: 1,
  OFFERED: 2,
  ASSIGNED: 3,
  IN_PROGRESS: 4,
  COMPLETED: 5,
  CANCELLED: 6
};

const URGENCY_SORT_PRIORITY: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3
};

const TIMELINE_FILTERS: TimelineFilter[] = [
  "ALL",
  "ASSIGNMENT",
  "LIFECYCLE",
  "MESSAGING",
  "SYSTEM"
];

const TIMELINE_FILTER_LABELS: Record<TimelineFilter, string> = {
  ALL: "All",
  ASSIGNMENT: "Assignment",
  LIFECYCLE: "Lifecycle",
  MESSAGING: "Messaging",
  SYSTEM: "System"
};

const normalizeToken = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, "_");

const formatToken = (value: string): string =>
  value
    .split("_")
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");

const formatJobHeadline = (job: Job): string => {
  const description = job.description?.trim() || formatToken(job.jobType);
  const business = job.clientOrganizationName?.trim();
  if (business) {
    return `${business} - ${description}`;
  }
  return description;
};

const formatCustomerLabel = (job: Job): string =>
  job.clientOrganizationName?.trim() ||
  job.clientName?.trim() ||
  job.clientEmail?.trim() ||
  job.clientId;

const formatWorkerLabel = (candidate: Candidate): string =>
  candidate.workerDisplayName?.trim() ||
  candidate.workerName?.trim() ||
  candidate.workerEmail?.trim() ||
  candidate.workerId;

const formatLatLon = (lat: number, lon: number): string =>
  `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

const weekdayLabel = (dayOfWeek: number): string =>
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayOfWeek] ?? `Day ${dayOfWeek}`;

const getTimelineCategory = (eventType: string): Exclude<TimelineFilter, "ALL"> => {
  const normalized = normalizeToken(eventType);
  if (normalized.includes("ASSIGN") || normalized.includes("CANDIDATE") || normalized.includes("OVERRIDE")) {
    return "ASSIGNMENT";
  }
  if (
    normalized.includes("STATUS") ||
    normalized.includes("REQUESTED") ||
    normalized.includes("IN_PROGRESS") ||
    normalized.includes("COMPLETED") ||
    normalized.includes("CANCELLED")
  ) {
    return "LIFECYCLE";
  }
  if (normalized.includes("MESSAGE") || normalized.includes("THREAD")) {
    return "MESSAGING";
  }
  return "SYSTEM";
};

const extractPayloadString = (payload: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const getEventWorkerId = (event: TimelineEvent): string | null =>
  extractPayloadString(event.payload, ["workerId", "assignedWorkerId", "overrideWorkerId", "selectedWorkerId"]);

const getEventReason = (event: TimelineEvent): string | null =>
  extractPayloadString(event.payload, ["reason", "overrideReason", "override_reason", "dispatchNote"]);

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
};

const formatScalar = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toFixed(2) : String(value);
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (value === null || value === undefined) {
    return "-";
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatScalar(item)).join(", ");
  }
  return JSON.stringify(value);
};

const formatFactorLabel = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());

const getCandidateFactors = (scoreBreakdown: Record<string, unknown>): CandidateFactor[] => {
  return Object.entries(scoreBreakdown)
    .filter(([name]) => name !== "finalScore")
    .map(([name, value]) => {
      if (isRecord(value)) {
        return {
          label: formatFactorLabel(name),
          score: toNumberOrNull(value.score),
          weight: toNumberOrNull(value.weight),
          weighted: toNumberOrNull(value.weighted),
          fallback: null
        };
      }
      if (typeof value === "number") {
        return {
          label: formatFactorLabel(name),
          score: Number.isFinite(value) ? value : null,
          weight: null,
          weighted: null,
          fallback: null
        };
      }
      return {
        label: formatFactorLabel(name),
        score: null,
        weight: null,
        weighted: null,
        fallback: formatScalar(value)
      };
    });
};

const getCandidateFinalScore = (
  scoreBreakdown: Record<string, unknown>,
  fallback: number
): number => {
  const breakdownFinal = toNumberOrNull(scoreBreakdown.finalScore);
  if (breakdownFinal !== null) {
    return breakdownFinal;
  }
  return fallback;
};

const preferredPayloadKeys = [
  "workerId",
  "assignmentType",
  "reason",
  "fromStatus",
  "toStatus",
  "note",
  "body",
  "objectKey",
  "contentType"
];

const toFactLabel = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());

const getPayloadFacts = (payload: Record<string, unknown>): PayloadFact[] => {
  const facts: PayloadFact[] = [];
  for (const key of preferredPayloadKeys) {
    if (!(key in payload)) {
      continue;
    }
    facts.push({ label: toFactLabel(key), value: formatScalar(payload[key]) });
  }

  if (facts.length > 0) {
    return facts.slice(0, 5);
  }

  return Object.entries(payload)
    .slice(0, 5)
    .map(([key, value]) => ({ label: toFactLabel(key), value: formatScalar(value) }));
};

function App() {
  const [identifier, setIdentifier] = useState("dispatch@laoworks.local");
  const [password, setPassword] = useState("password123");
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [overrideReason, setOverrideReason] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>("ALL");
  const [skillFilter, setSkillFilter] = useState("ALL");
  const [personalityFilter, setPersonalityFilter] = useState("ALL");
  const [queueSort, setQueueSort] = useState<QueueSort>("NEWEST");
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("ALL");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [mapOverview, setMapOverview] = useState<DispatchMapOverview | null>(null);
  const [calendar, setCalendar] = useState<DispatchCalendar | null>(null);
  const overrideReasonInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId]
  );
  const workerLabelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const candidate of candidates) {
      labels.set(candidate.workerId, formatWorkerLabel(candidate));
    }
    if (selectedJob?.assignedWorkerId) {
      labels.set(
        selectedJob.assignedWorkerId,
        selectedJob.assignedWorkerDisplayName?.trim() ||
          selectedJob.assignedWorkerName?.trim() ||
          selectedJob.assignedWorkerEmail?.trim() ||
          selectedJob.assignedWorkerId
      );
    }
    return labels;
  }, [candidates, selectedJob]);
  const selectedWorkerLabel = useMemo(() => {
    if (!selectedWorkerId) {
      return "Select from candidates";
    }
    return workerLabelById.get(selectedWorkerId) ?? selectedWorkerId;
  }, [selectedWorkerId, workerLabelById]);

  const timelineCounts = useMemo(() => {
    const counts: Record<TimelineFilter, number> = {
      ALL: timeline.length,
      ASSIGNMENT: 0,
      LIFECYCLE: 0,
      MESSAGING: 0,
      SYSTEM: 0
    };
    for (const event of timeline) {
      const category = getTimelineCategory(event.eventType);
      counts[category] += 1;
    }
    return counts;
  }, [timeline]);

  const visibleTimeline = useMemo(() => {
    if (timelineFilter === "ALL") {
      return timeline;
    }
    return timeline.filter((event) => getTimelineCategory(event.eventType) === timelineFilter);
  }, [timeline, timelineFilter]);

  const groupedMessages = useMemo(() => {
    const groups: MessageDayGroup[] = [];

    for (const message of messages) {
      const createdAt = new Date(message.createdAt);
      const dayKey = createdAt.toISOString().slice(0, 10);
      const dayLabel = createdAt.toLocaleDateString();
      let dayGroup = groups[groups.length - 1];
      if (!dayGroup || dayGroup.dayKey !== dayKey) {
        dayGroup = { dayKey, dayLabel, threads: [] };
        groups.push(dayGroup);
      }

      const thread = dayGroup.threads[dayGroup.threads.length - 1];
      const previousEndedAt = thread ? Date.parse(thread.endedAt) : 0;
      const currentCreatedAt = Date.parse(message.createdAt);
      const shouldMerge =
        Boolean(thread) &&
        thread.senderUserId === message.senderUserId &&
        currentCreatedAt - previousEndedAt <= 5 * 60 * 1000;

      if (thread && shouldMerge) {
        thread.items.push(message);
        thread.endedAt = message.createdAt;
      } else {
        dayGroup.threads.push({
          senderUserId: message.senderUserId,
          startedAt: message.createdAt,
          endedAt: message.createdAt,
          items: [message]
        });
      }
    }

    return groups;
  }, [messages]);

  const skillOptions = useMemo(() => {
    const dynamicSkills = jobs.flatMap((job) => job.requiredSkills.map(normalizeToken));
    return Array.from(new Set([...DEFAULT_SKILLS, ...dynamicSkills])).sort();
  }, [jobs]);

  const personalityTagOptions = useMemo(() => {
    const dynamicTags = jobs.flatMap((job) => job.personalityPreferences.map(normalizeToken));
    return Array.from(new Set([...DEFAULT_PERSONALITY_TAGS, ...dynamicTags])).sort();
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const visibleJobs = jobs.filter((job) => {
      const status = normalizeToken(job.status);
      const urgency = normalizeToken(job.urgency);
      const skillSet = new Set(job.requiredSkills.map(normalizeToken));
      const personalitySet = new Set(job.personalityPreferences.map(normalizeToken));
      const matchesStatus = statusFilter === "ALL" || status === statusFilter;
      const matchesUrgency = urgencyFilter === "ALL" || urgency === urgencyFilter;
      const matchesSkill = skillFilter === "ALL" || skillSet.has(skillFilter);
      const matchesPersonality =
        personalityFilter === "ALL" || personalitySet.has(personalityFilter);

      return matchesStatus && matchesUrgency && matchesSkill && matchesPersonality;
    });

    visibleJobs.sort((left, right) => {
      if (queueSort === "NEWEST") {
        return Date.parse(right.createdAt) - Date.parse(left.createdAt);
      }
      if (queueSort === "OLDEST") {
        return Date.parse(left.createdAt) - Date.parse(right.createdAt);
      }
      if (queueSort === "URGENCY") {
        const leftPriority = URGENCY_SORT_PRIORITY[normalizeToken(left.urgency)] ?? 999;
        const rightPriority = URGENCY_SORT_PRIORITY[normalizeToken(right.urgency)] ?? 999;
        return leftPriority - rightPriority;
      }

      const leftPriority = STATUS_SORT_PRIORITY[normalizeToken(left.status)] ?? 999;
      const rightPriority = STATUS_SORT_PRIORITY[normalizeToken(right.status)] ?? 999;
      return leftPriority - rightPriority;
    });

    return visibleJobs;
  }, [jobs, personalityFilter, queueSort, skillFilter, statusFilter, urgencyFilter]);

  const mapPoints = useMemo(() => {
    if (!mapOverview) {
      return [] as Array<{
        id: string;
        kind: "JOB" | "WORKER";
        lat: number;
        lon: number;
        label: string;
        status: string;
      }>;
    }

    const jobPoints = mapOverview.jobs.map((job) => ({
      id: `job-${job.id}`,
      kind: "JOB" as const,
      lat: job.location.lat,
      lon: job.location.lon,
      label: `${job.description} (${job.status})`,
      status: job.status
    }));

    const workerPoints = mapOverview.workers.map((worker) => ({
      id: `worker-${worker.workerId}`,
      kind: "WORKER" as const,
      lat: worker.location.lat,
      lon: worker.location.lon,
      label: `${worker.workerDisplayName} (${formatToken(worker.tier)})`,
      status: worker.tier
    }));

    return [...jobPoints, ...workerPoints];
  }, [mapOverview]);

  const mapBounds = useMemo(() => {
    if (!mapPoints.length) {
      return null;
    }
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let minLon = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;

    for (const point of mapPoints) {
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
      minLon = Math.min(minLon, point.lon);
      maxLon = Math.max(maxLon, point.lon);
    }

    return { minLat, maxLat, minLon, maxLon };
  }, [mapPoints]);

  const loadQueue = useCallback(async () => {
    if (!session) return;
    setIsRefreshing(true);
    try {
      const queue = await getQueue(session.accessToken);
      setJobs(queue.items ?? []);
      setLastRefreshAt(new Date().toISOString());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Queue refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }, [session]);

  const loadOperationsView = useCallback(async () => {
    if (!session) {
      return;
    }
    try {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + 7);
      const [mapPayload, calendarPayload] = await Promise.all([
        getMapOverview(session.accessToken),
        getDispatchCalendar(session.accessToken, from.toISOString(), to.toISOString())
      ]);
      setMapOverview(mapPayload);
      setCalendar(calendarPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operations map/calendar refresh failed");
    }
  }, [session]);

  const loadJobPanels = useCallback(
    async (jobId: string | null = selectedJobId) => {
      if (!session || !jobId) {
        setCandidates([]);
        setSelectedWorkerId(null);
        setTimeline([]);
        setMessages([]);
        return;
      }
      try {
        const [candidatePayload, timelinePayload, messagePayload] = await Promise.all([
          getCandidates(session.accessToken, jobId),
          getTimeline(session.accessToken, jobId),
          getMessages(session.accessToken, jobId)
        ]);
        const nextCandidates = (candidatePayload.candidates ?? [])
          .slice()
          .sort((left, right) => left.rank - right.rank);
        setCandidates(nextCandidates);
        setSelectedWorkerId((previous) => {
          if (previous && nextCandidates.some((candidate) => candidate.workerId === previous)) {
            return previous;
          }
          return nextCandidates[0]?.workerId ?? null;
        });
        setTimeline(
          (timelinePayload.items ?? [])
            .slice()
            .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
        );
        setMessages(
          (messagePayload.items ?? [])
            .slice()
            .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
        );
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Job panel refresh failed");
      }
    },
    [selectedJobId, session]
  );

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    void loadOperationsView();
  }, [loadOperationsView]);

  useEffect(() => {
    void loadJobPanels(selectedJobId);
  }, [loadJobPanels, selectedJobId]);

  useEffect(() => {
    if (!filteredJobs.length) {
      setSelectedJobId(null);
      return;
    }
    if (!selectedJobId || !filteredJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(filteredJobs[0].id);
    }
  }, [filteredJobs, selectedJobId]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      void loadQueue();
      void loadJobPanels(selectedJobId);
      void loadOperationsView();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadJobPanels, loadOperationsView, loadQueue, selectedJobId, session]);

  const selectJobByOffset = useCallback(
    (offset: number) => {
      if (!filteredJobs.length) {
        return;
      }
      const currentIndex = filteredJobs.findIndex((job) => job.id === selectedJobId);
      const startIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (startIndex + offset + filteredJobs.length) % filteredJobs.length;
      setSelectedJobId(filteredJobs[nextIndex].id);
    },
    [filteredJobs, selectedJobId]
  );

  const onLogin = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const tokens = await login(identifier, password);
      setSession({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    }
  };

  const refreshPanelsAfterMutation = async () => {
    await Promise.all([loadQueue(), loadJobPanels(selectedJobId), loadOperationsView()]);
  };

  const onRecompute = useCallback(async () => {
    if (!session || !selectedJobId) return;
    try {
      const payload = await recomputeCandidates(session.accessToken, selectedJobId, 10);
      const nextCandidates = (payload.candidates ?? []).slice().sort((left, right) => left.rank - right.rank);
      setCandidates(nextCandidates);
      setSelectedWorkerId(nextCandidates[0]?.workerId ?? null);
      await refreshPanelsAfterMutation();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recompute failed");
    }
  }, [selectedJobId, session]);

  const onAssign = useCallback(async () => {
    if (!session || !selectedJobId || !selectedWorkerId) return;
    try {
      await assignWorker(session.accessToken, selectedJobId, selectedWorkerId);
      await refreshPanelsAfterMutation();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assign failed");
    }
  }, [selectedJobId, selectedWorkerId, session]);

  const onOverride = useCallback(async () => {
    if (!session || !selectedJobId || !selectedWorkerId || !overrideReason.trim()) return;
    try {
      await overrideWorker(
        session.accessToken,
        selectedJobId,
        selectedWorkerId,
        overrideReason.trim()
      );
      setOverrideReason("");
      await refreshPanelsAfterMutation();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Override failed");
    }
  }, [overrideReason, selectedJobId, selectedWorkerId, session]);

  const onSendMessage = useCallback(async () => {
    if (!session || !selectedJobId || !messageDraft.trim()) return;
    try {
      await sendMessage(session.accessToken, selectedJobId, messageDraft.trim());
      setMessageDraft("");
      await loadJobPanels(selectedJobId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send message failed");
    }
  }, [loadJobPanels, messageDraft, selectedJobId, session]);

  const onUseTimelineReason = useCallback((reason: string) => {
    setOverrideReason(reason);
    overrideReasonInputRef.current?.focus();
  }, []);

  const onQuoteTimelineEvent = useCallback((event: TimelineEvent) => {
    const payloadSummary = JSON.stringify(event.payload);
    const line = `[${event.eventType}] ${payloadSummary.length > 150 ? `${payloadSummary.slice(0, 147)}...` : payloadSummary}`;
    setMessageDraft((current) => (current ? `${current}\n${line}` : line));
    messageInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (event.key === "Escape" && showShortcutHelp) {
        event.preventDefault();
        setShowShortcutHelp(false);
        return;
      }

      if (isEditableTarget(event.target)) {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          void onSendMessage();
        }
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        setShowShortcutHelp((value) => !value);
        return;
      }

      if (key === "j" || key === "arrowdown") {
        event.preventDefault();
        selectJobByOffset(1);
        return;
      }
      if (key === "k" || key === "arrowup") {
        event.preventDefault();
        selectJobByOffset(-1);
        return;
      }
      if (key === "r") {
        event.preventDefault();
        void onRecompute();
        return;
      }
      if (key === "a") {
        event.preventDefault();
        void onAssign();
        return;
      }
      if (key === "o") {
        event.preventDefault();
        overrideReasonInputRef.current?.focus();
        return;
      }
      if (key === "m") {
        event.preventDefault();
        messageInputRef.current?.focus();
        return;
      }
      if (key === "1") {
        event.preventDefault();
        setTimelineFilter("ALL");
        return;
      }
      if (key === "2") {
        event.preventDefault();
        setTimelineFilter("ASSIGNMENT");
        return;
      }
      if (key === "3") {
        event.preventDefault();
        setTimelineFilter("LIFECYCLE");
        return;
      }
      if (key === "4") {
        event.preventDefault();
        setTimelineFilter("MESSAGING");
        return;
      }
      if (key === "5") {
        event.preventDefault();
        setTimelineFilter("SYSTEM");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onAssign, onRecompute, onSendMessage, selectJobByOffset, session, showShortcutHelp]);

  const onMessageInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void onSendMessage();
    }
  };

  const pointStyle = (lat: number, lon: number): { left: string; top: string } => {
    if (!mapBounds) {
      return { left: "50%", top: "50%" };
    }
    const lonSpan = Math.max(0.001, mapBounds.maxLon - mapBounds.minLon);
    const latSpan = Math.max(0.001, mapBounds.maxLat - mapBounds.minLat);
    const x = ((lon - mapBounds.minLon) / lonSpan) * 100;
    const y = 100 - ((lat - mapBounds.minLat) / latSpan) * 100;
    return { left: `${x}%`, top: `${y}%` };
  };

  if (!session) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Lao-Works Dispatch</h1>
          <p>Sign in with dispatcher credentials.</p>
          <form onSubmit={onLogin}>
            <label>
              Identifier
              <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button type="submit">Sign In</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>Dispatch Console</h1>
        <div className="topbar-actions">
          <small>
            {lastRefreshAt
              ? `Last refresh: ${new Date(lastRefreshAt).toLocaleTimeString()}`
              : "Waiting for first refresh"}
          </small>
          <button
            className={showShortcutHelp ? "secondary active" : "secondary"}
            onClick={() => setShowShortcutHelp((value) => !value)}
          >
            Shortcuts (?)
          </button>
          <button onClick={() => void refreshPanelsAfterMutation()} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh Queue"}
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {showShortcutHelp && (
        <section className="shortcut-panel" aria-label="Keyboard shortcuts">
          <h2>Keyboard Shortcuts</h2>
          <div className="shortcut-grid">
            <p><kbd>j</kbd> or <kbd>↓</kbd> Next job</p>
            <p><kbd>k</kbd> or <kbd>↑</kbd> Previous job</p>
            <p><kbd>r</kbd> Recompute candidates</p>
            <p><kbd>a</kbd> Assign selected candidate</p>
            <p><kbd>o</kbd> Focus override reason</p>
            <p><kbd>m</kbd> Focus message draft</p>
            <p><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> Send message</p>
            <p><kbd>1-5</kbd> Switch timeline chips</p>
          </div>
        </section>
      )}

      <section className="grid-layout">
        <aside className="panel queue">
          <h2>Job Queue</h2>
          <div className="queue-controls">
            <label>
              Status
              <select
                aria-label="Status filter"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              >
                <option value="ALL">All</option>
                {JOB_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {formatToken(status)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Urgency
              <select
                aria-label="Urgency filter"
                value={urgencyFilter}
                onChange={(event) => setUrgencyFilter(event.target.value as UrgencyFilter)}
              >
                <option value="ALL">All</option>
                {URGENCY_LEVELS.map((urgency) => (
                  <option key={urgency} value={urgency}>
                    {formatToken(urgency)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Skill
              <select
                aria-label="Skill filter"
                value={skillFilter}
                onChange={(event) => setSkillFilter(event.target.value)}
              >
                <option value="ALL">All</option>
                {skillOptions.map((skill) => (
                  <option key={skill} value={skill}>
                    {formatToken(skill)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Personality
              <select
                aria-label="Personality filter"
                value={personalityFilter}
                onChange={(event) => setPersonalityFilter(event.target.value)}
              >
                <option value="ALL">All</option>
                {personalityTagOptions.map((tag) => (
                  <option key={tag} value={tag}>
                    {formatToken(tag)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sort
              <select
                aria-label="Sort queue"
                value={queueSort}
                onChange={(event) => setQueueSort(event.target.value as QueueSort)}
              >
                <option value="NEWEST">Newest</option>
                <option value="OLDEST">Oldest</option>
                <option value="URGENCY">Urgency</option>
                <option value="STATUS">Status</option>
              </select>
            </label>
          </div>
          <p className="queue-count">
            Showing {filteredJobs.length} of {jobs.length} jobs
          </p>
          <ul>
            {filteredJobs.map((job) => (
              <li key={job.id}>
                <button
                  className={job.id === selectedJobId ? "job active" : "job"}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <div className="job-head">
                    <strong>{formatJobHeadline(job)}</strong>
                    <span className="job-id">{job.id.slice(0, 8)}</span>
                  </div>
                  <div className="job-meta">
                    <span className="badge">{job.status}</span>
                    <span className="badge">{job.urgency}</span>
                    <span className="badge">{job.requiredSkills.length} skills</span>
                  </div>
                  <small>{formatToken(job.jobType)} · {new Date(job.createdAt).toLocaleString()}</small>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="panel detail">
          <h2>Job Detail</h2>
          {selectedJob ? (
            <>
              <div className="job-summary">
                <p><strong>Job:</strong> {formatJobHeadline(selectedJob)}</p>
                <p><strong>Customer:</strong> {formatCustomerLabel(selectedJob)}</p>
                <p data-testid="selected-job-id"><strong>Record ID:</strong> {selectedJob.id}</p>
                <p><strong>Status:</strong> {selectedJob.status}</p>
                <p><strong>Urgency:</strong> {selectedJob.urgency}</p>
                <p>
                  <strong>Window:</strong>{" "}
                  {selectedJob.scheduleWindowStart && selectedJob.scheduleWindowEnd
                    ? `${new Date(selectedJob.scheduleWindowStart).toLocaleString()} - ${new Date(selectedJob.scheduleWindowEnd).toLocaleString()}`
                    : "Not scheduled"}
                </p>
                <p><strong>Skills:</strong> {selectedJob.requiredSkills.join(", ") || "None"}</p>
                <p><strong>Personality:</strong> {selectedJob.personalityPreferences.join(", ") || "None"}</p>
                <p>
                  <strong>Assigned Worker:</strong>{" "}
                  {selectedJob.assignedWorkerDisplayName ?? selectedJob.assignedWorkerId ?? "Not assigned"}
                </p>
                <p data-testid="selected-worker-id">
                  <strong>Selected Worker:</strong> {selectedWorkerLabel}
                </p>
              </div>

              <div className="actions">
                <button onClick={onRecompute}>Recompute Candidates</button>
                <button onClick={onAssign} disabled={!selectedWorkerId}>
                  Assign Selected Candidate
                </button>
                <input
                  ref={overrideReasonInputRef}
                  placeholder="Override reason"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                />
                <button onClick={onOverride} disabled={!selectedWorkerId || !overrideReason.trim()}>
                  Override Selected Candidate
                </button>
              </div>

              <h3>Candidates</h3>
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Worker</th>
                    <th>Score</th>
                    <th>Actions</th>
                    <th>Breakdown</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((candidate) => (
                    <tr
                      key={candidate.workerId}
                      className={selectedWorkerId === candidate.workerId ? "candidate-selected" : ""}
                    >
                      <td>{candidate.rank}</td>
                      <td>
                        <div>{formatWorkerLabel(candidate)}</div>
                        <small className="job-id">{candidate.workerId.slice(0, 8)}</small>
                      </td>
                      <td>{candidate.score.toFixed(2)}</td>
                      <td>
                        <button
                          className={selectedWorkerId === candidate.workerId ? "secondary active" : "secondary"}
                          onClick={() => setSelectedWorkerId(candidate.workerId)}
                        >
                          {selectedWorkerId === candidate.workerId ? "Selected" : "Select"}
                        </button>
                      </td>
                      <td>
                        <div className="breakdown-stack">
                          <p className="candidate-final-score">
                            Final: {getCandidateFinalScore(candidate.scoreBreakdown, candidate.score).toFixed(2)}
                          </p>
                          {getCandidateFactors(candidate.scoreBreakdown).map((factor) => (
                            <div key={factor.label} className="factor-row">
                              <span className="factor-name">{factor.label}</span>
                              {factor.score !== null && <span>S {factor.score.toFixed(2)}</span>}
                              {factor.weight !== null && <span>W {factor.weight.toFixed(2)}</span>}
                              {factor.weighted !== null && <span>WS {factor.weighted.toFixed(2)}</span>}
                              {factor.fallback && <span>{factor.fallback}</span>}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p>Select a job to inspect details.</p>
          )}
        </section>

        <section className="panel timeline">
          <h2>Timeline</h2>
          <div className="timeline-chips" role="group" aria-label="Timeline filters">
            {TIMELINE_FILTERS.map((filter) => (
              <button
                key={filter}
                className={timelineFilter === filter ? "chip active" : "chip"}
                onClick={() => setTimelineFilter(filter)}
              >
                {TIMELINE_FILTER_LABELS[filter]} ({timelineCounts[filter]})
              </button>
            ))}
          </div>
          <ul className="timeline-list">
            {visibleTimeline.map((event) => {
              const eventCategory = getTimelineCategory(event.eventType);
              const workerId = getEventWorkerId(event);
              const reason = getEventReason(event);
              const workerLabel = workerId ? workerLabelById.get(workerId) ?? workerId : null;
              return (
                <li key={event.id} className="timeline-item">
                  <div className="timeline-item-head">
                    <strong>{event.eventType}</strong>
                    <span className="timeline-tag">{TIMELINE_FILTER_LABELS[eventCategory]}</span>
                    <span>{new Date(event.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="payload-facts">
                    {getPayloadFacts(event.payload).map((fact) => (
                      <span key={`${event.id}-${fact.label}`} className="payload-fact">
                        <strong>{fact.label}:</strong> {fact.value}
                      </span>
                    ))}
                  </div>
                  <div className="timeline-inline-actions">
                    {workerId && workerLabel && (
                      <button className="chip secondary" onClick={() => setSelectedWorkerId(workerId)}>
                        Select {workerLabel}
                      </button>
                    )}
                    {reason && (
                      <button className="chip secondary" onClick={() => onUseTimelineReason(reason)}>
                        Use reason
                      </button>
                    )}
                    <button className="chip secondary" onClick={() => onQuoteTimelineEvent(event)}>
                      Quote in message
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <h2>Messaging {selectedJob ? `· ${formatJobHeadline(selectedJob)}` : ""}</h2>
          <div className="messages grouped">
            {groupedMessages.map((dayGroup) => (
              <section key={dayGroup.dayKey} className="message-day-group">
                <h3>{dayGroup.dayLabel}</h3>
                {dayGroup.threads.map((thread, index) => (
                  <article
                    key={`${dayGroup.dayKey}-${thread.senderUserId}-${thread.startedAt}-${index}`}
                    className="message-thread"
                  >
                    <header>
                      {thread.senderUserId} · {new Date(thread.startedAt).toLocaleTimeString()}
                    </header>
                    <div className="message-thread-lines">
                      {thread.items.map((message) => (
                        <p key={message.id}>{message.body}</p>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
          <div className="compose">
            <input
              ref={messageInputRef}
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
              onKeyDown={onMessageInputKeyDown}
              placeholder="Send a message to job thread"
              disabled={!selectedJobId}
            />
            <button onClick={onSendMessage} disabled={!selectedJobId || !messageDraft.trim()}>
              Send Message
            </button>
          </div>
        </section>
      </section>

      <section className="ops-grid-layout">
        <section className="panel ops-map">
          <h2>Operations Map</h2>
          <p className="queue-count">
            {mapOverview
              ? `${mapOverview.jobs.length} mapped jobs · ${mapOverview.workers.length} workers`
              : "Loading map overview..."}
          </p>
          <div className="map-legend">
            <span><i className="legend-dot job" /> Job</span>
            <span><i className="legend-dot worker" /> Worker</span>
          </div>
          <div className="map-canvas" aria-label="Dispatch map overview">
            {mapPoints.map((point) => (
              <button
                key={point.id}
                className={point.kind === "JOB" ? "map-point job" : "map-point worker"}
                style={pointStyle(point.lat, point.lon)}
                title={`${point.label} · ${formatLatLon(point.lat, point.lon)}`}
                onClick={() => {
                  if (point.kind === "JOB") {
                    const jobId = point.id.replace("job-", "");
                    setSelectedJobId(jobId);
                  }
                }}
              >
                {point.kind === "JOB" ? "J" : "W"}
              </button>
            ))}
          </div>

          <h3>Optimal Next-Job Paths</h3>
          <ul className="route-list">
            {(mapOverview?.routeSuggestions ?? []).slice(0, 8).map((route) => (
              <li key={`${route.workerId}-${route.toJobId}`}>
                <strong>{route.workerDisplayName}</strong> →{" "}
                <button
                  className="linkish"
                  onClick={() => setSelectedJobId(route.toJobId)}
                >
                  {route.toJobDescription}
                </button>
                <small>
                  {" "}
                  · {route.distanceKm.toFixed(1)} km · ~{route.estimatedDriveMinutes} min
                </small>
              </li>
            ))}
            {mapOverview && mapOverview.routeSuggestions.length === 0 && (
              <li><small>No route suggestions available.</small></li>
            )}
          </ul>
        </section>

        <section className="panel ops-schedule">
          <h2>Scheduling Calendar</h2>
          {calendar ? (
            <p className="queue-count">
              {new Date(calendar.range.from).toLocaleDateString()} -{" "}
              {new Date(calendar.range.to).toLocaleDateString()}
            </p>
          ) : (
            <p className="queue-count">Loading schedule...</p>
          )}
          <div className="schedule-workers">
            {(calendar?.workers ?? []).map((worker) => (
              <article key={worker.workerId} className="schedule-worker-card">
                <header>
                  <strong>{worker.workerDisplayName}</strong>
                  <span>{formatToken(worker.tier)}</span>
                </header>
                <p>
                  <strong>Availability:</strong>{" "}
                  {worker.availability.length > 0
                    ? worker.availability
                        .map((slot) => `${weekdayLabel(slot.dayOfWeek)} ${slot.startTime}-${slot.endTime}`)
                        .join(", ")
                    : "Not set"}
                </p>
                <p>
                  <strong>Time Off:</strong>{" "}
                  {worker.timeOff.length > 0
                    ? worker.timeOff
                        .map(
                          (timeOff) =>
                            `${new Date(timeOff.startAt).toLocaleDateString()}-${new Date(timeOff.endAt).toLocaleDateString()}`
                        )
                        .join(", ")
                    : "None"}
                </p>
                <p>
                  <strong>Scheduled Jobs:</strong> {worker.scheduledJobs.length}
                </p>
                <ul>
                  {worker.scheduledJobs.slice(0, 3).map((job) => (
                    <li key={job.id}>
                      <button className="linkish" onClick={() => setSelectedJobId(job.id)}>
                        {job.description}
                      </button>{" "}
                      <small>{job.scheduleWindowStart ? new Date(job.scheduleWindowStart).toLocaleString() : "No window"}</small>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <h3>Unassigned Jobs</h3>
          <ul className="route-list">
            {(calendar?.unassignedJobs ?? []).slice(0, 10).map((job) => (
              <li key={job.id}>
                <button className="linkish" onClick={() => setSelectedJobId(job.id)}>
                  {job.description}
                </button>
                <small> · {job.status} · {job.urgency}</small>
              </li>
            ))}
            {calendar && calendar.unassignedJobs.length === 0 && (
              <li><small>No unassigned jobs in range.</small></li>
            )}
          </ul>
        </section>
      </section>
    </main>
  );
}

export default App;
