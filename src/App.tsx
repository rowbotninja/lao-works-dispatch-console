import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import {
  assignWorker,
  getJobDetail,
  getCandidates,
  getDispatchCalendar,
  getMapOverview,
  getMessages,
  getQueue,
  getTimeline,
  login,
  recomputeCandidates,
  sendMessage,
  overrideWorker,
  runJobAction
} from "./api";
import { Candidate, DispatchCalendar, DispatchMapOverview, Job, MapScope, Message, TimelineEvent } from "./types";

const LeafletMapContainer = MapContainer as unknown as (props: any) => JSX.Element;
const LeafletTileLayer = TileLayer as unknown as (props: any) => JSX.Element;
const LeafletCircleMarker = CircleMarker as unknown as (props: any) => JSX.Element;
const LeafletPolyline = Polyline as unknown as (props: any) => JSX.Element;
const LeafletPopup = Popup as unknown as (props: any) => JSX.Element;

type Session = {
  accessToken: string;
  refreshToken: string;
};

type MessageAudience = "CLIENT" | "WORKER" | "BOTH";
type FocusPanel = "SIGNALS" | "DETAILS" | "MESSAGES" | "TIMELINE";
type OpsTab = "ROUTING" | "SCHEDULING";

type MessageThreadGroup = {
  senderUserId: string;
  senderName: string | null;
  senderRole: string | null;
  audience: MessageAudience;
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

type SignalLevel = "CRITICAL" | "WARNING" | "INFO";

type DispatchSignal = {
  id: string;
  level: SignalLevel;
  label: string;
  detail: string;
  actionHint?: string;
};

type MapPoint = {
  id: string;
  kind: "JOB" | "WORKER";
  lat: number;
  lon: number;
  label: string;
  status: string;
};

const JOB_STATUSES = ["REQUESTED", "TRIAGED", "OFFERED", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
type StatusFilter = "ALL" | (typeof JOB_STATUSES)[number];

const URGENCY_LEVELS = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
type UrgencyFilter = "ALL" | (typeof URGENCY_LEVELS)[number];

const MAP_SCOPES: Array<{ scope: MapScope; label: string; hint: string }> = [
  { scope: "TODAY", label: "Today", hint: "Active and unscheduled jobs for today" },
  { scope: "FUTURE", label: "Future", hint: "Upcoming scheduled jobs" },
  { scope: "PAST", label: "Past", hint: "Missed and historical scheduled jobs" },
  { scope: "ALL", label: "All", hint: "All active jobs regardless of date" }
];

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

const TIMELINE_FILTERS: TimelineFilter[] = ["ALL", "ASSIGNMENT", "LIFECYCLE", "MESSAGING", "SYSTEM"];

const TIMELINE_FILTER_LABELS: Record<TimelineFilter, string> = {
  ALL: "All",
  ASSIGNMENT: "Assignment",
  LIFECYCLE: "Lifecycle",
  MESSAGING: "Messaging",
  SYSTEM: "System"
};

const MESSAGE_AUDIENCE_OPTIONS: Array<{ value: MessageAudience; label: string }> = [
  { value: "BOTH", label: "Customer + Tech" },
  { value: "WORKER", label: "Tech Only" },
  { value: "CLIENT", label: "Customer Only" }
];

const normalizeToken = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, "_");

const formatToken = (value: string): string =>
  value
    .split("_")
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");

const workflowToLegacyStatus = (workflowState: string): string => {
  const state = normalizeToken(workflowState);
  if (state === "REQUESTED" || state === "DRAFT") return "REQUESTED";
  if (state === "DISPATCHING" || state === "OFFER_EXPIRED") return "TRIAGED";
  if (state === "OFFERED") return "OFFERED";
  if (state === "WORKER_ACCEPTED" || state === "CLIENT_CONFIRMED" || state === "SCHEDULED") return "ASSIGNED";
  if (state === "COMPLETED") return "COMPLETED";
  if (state === "CANCELLED") return "CANCELLED";
  return "IN_PROGRESS";
};

const getJobLegacyStatus = (job: Job): string =>
  job.workflowState ? workflowToLegacyStatus(job.workflowState) : normalizeToken(job.status);

const getJobStatusLabel = (job: Job): string =>
  job.publicStatus?.trim() || formatToken(job.workflowState ?? job.status);

const getDispatchUnreadCount = (job: Job): number =>
  (job.readReceiptsSummary?.messages?.unreadForDispatch ?? 0) +
  (job.readReceiptsSummary?.paymentRequests?.unreadForDispatch ?? 0) +
  (job.readReceiptsSummary?.changeOrders?.unreadForDispatch ?? 0);

const formatOptionalTimestamp = (value: string | null | undefined): string => {
  if (!value) {
    return "Never";
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
};

const toLocalDateTimeInputValue = (value: string | Date | null | undefined): string => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (segment: number) => String(segment).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
};

const localDateTimeInputToIso = (value: string): string | null => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
};

const getDefaultDispatchActionPayload = (
  action: string,
  selectedJob: Job | null,
  selectedWorkerId: string | null
): Record<string, unknown> | null => {
  const now = Date.now();
  const defaultScheduleStart = selectedJob?.scheduleWindowStart ?? new Date(now + 60 * 60 * 1000).toISOString();
  const defaultScheduleEnd = selectedJob?.scheduleWindowEnd ?? new Date(now + 2 * 60 * 60 * 1000).toISOString();

  switch (action) {
    case "EDIT_REQUEST_FIELDS_WITH_AUDIT":
      return {
        requestPatch: {},
        audit: { reasonCode: "dispatcher_override" }
      };
    case "PRIORITIZE_JOB":
      return { priority: { level: "high" }, audit: { reasonCode: "dispatcher_override" } };
    case "ADJUST_PRICING":
      return {
        pricingAdjustment: {
          type: "set_urgency_surcharge",
          amount: 0,
          note: "Dispatch adjustment"
        },
        audit: { reasonCode: "pricing_correction" }
      };
    case "APPLY_OVERRIDES":
      return {
        overrides: {
          radiusOverrideKm: 50
        },
        audit: { reasonCode: "dispatcher_override" }
      };
    case "FORCE_ASSIGN_WORKER":
      if (!selectedWorkerId) {
        return null;
      }
      return {
        workerId: selectedWorkerId,
        audit: { reasonCode: "dispatcher_override" }
      };
    case "OVERRIDE_CONFIRMATION":
      return { audit: { reasonCode: "dispatcher_override" } };
    case "RESCHEDULE":
      return {
        schedule: {
          startAt: defaultScheduleStart,
          endAt: defaultScheduleEnd
        },
        audit: { reasonCode: "dispatcher_override" }
      };
    case "REASSIGN_WORKER":
      return { audit: { reasonCode: "dispatcher_override" } };
    case "CANCEL_OFFER_AND_REDISPATCH":
      return { audit: { reasonCode: "dispatcher_override" } };
    case "MEDIATE_CHANGE_ORDER":
      return {
        mediation: {
          proposedAddedLaborCost: 0,
          proposedAddedMaterialCost: 0,
          proposedAddedTimeEstimateMinutes: 60,
          dispatcherNotes: "Mediated by dispatch"
        },
        audit: { reasonCode: "dispute_resolution" }
      };
    case "EMERGENCY_OVERRIDE_APPROVAL":
      return {
        override: {
          reasonCode: "urgent",
          note: "Emergency override approved by dispatch"
        }
      };
    case "UNLOCK_EVIDENCE_FOR_CORRECTION":
      return {
        unlock: {
          windowMinutes: 60
        },
        audit: { reasonCode: "missing_required_photos" }
      };
    case "REQUEST_MORE_INFO":
      return {
        request: {
          targetRole: "client",
          message: "Please provide additional dispute details."
        }
      };
    case "OPEN_DISPUTE_DISPATCH":
      return {
        dispute: {
          type: "invoice_dispute",
          reasonCode: "dispatcher_override",
          description: "Dispatch opened dispute for manual review."
        }
      };
    case "CONFIRM_PAYMENT":
      return {
        paymentConfirmation: {
          confirmedAmount: 0,
          confirmedAt: new Date().toISOString()
        }
      };
    case "REJECT_PAYMENT_PROOF":
      return {
        paymentReject: {
          reasonCode: "amount_mismatch"
        }
      };
    case "CANCEL_JOB":
    case "CANCEL_JOB_WITH_REASON":
      return { audit: { reasonCode: "dispatcher_override" } };
    case "RECORD_NO_SHOW":
      return { noShowParty: "worker" };
    case "APPROVE_DISPUTE":
    case "REJECT_DISPUTE":
      return {
        dispute: {
          decisionReason: "Reviewed by dispatch"
        }
      };
    case "SCHEDULE_REMEDIATION":
      return {
        remediation: {
          scheduleWindow: {
            startAt: defaultScheduleStart,
            endAt: defaultScheduleEnd
          }
        }
      };
    case "APPLY_REFUND_ADJUSTMENT":
      return {
        adjustment: {
          amount: 0,
          reasonCode: "dispute_resolution"
        }
      };
    case "COMPLETE_JOB":
      return { note: "Completed by dispatch action" };
    default:
      return {};
  }
};

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

const formatLatLon = (lat: number, lon: number): string => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

const weekdayLabel = (dayOfWeek: number): string => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dayOfWeek] ?? `Day ${dayOfWeek}`;

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

const getCandidateFinalScore = (scoreBreakdown: Record<string, unknown>, fallback: number): number => {
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

const isPastDue = (job: Job): boolean => {
  if (!job.scheduleWindowEnd) {
    return false;
  }
  const windowEnd = Date.parse(job.scheduleWindowEnd);
  if (Number.isNaN(windowEnd)) {
    return false;
  }
  return windowEnd < Date.now() && !["COMPLETED", "CANCELLED"].includes(getJobLegacyStatus(job));
};

const getAudienceLabel = (audience: MessageAudience): string => {
  if (audience === "WORKER") {
    return "Tech";
  }
  if (audience === "CLIENT") {
    return "Customer";
  }
  return "Both";
};

const formatSenderRole = (role: string | null | undefined): string => {
  const normalized = normalizeToken(role ?? "");
  if (normalized === "CLIENT") {
    return "Customer";
  }
  if (normalized === "WORKER") {
    return "Tech";
  }
  if (normalized === "DISPATCH" || normalized === "ADMIN") {
    return "Dispatch";
  }
  return "Participant";
};

const formatMessageSender = (message: Message): string => {
  const roleLabel = formatSenderRole(message.senderRole);
  const name = message.senderName?.trim();
  if (name) {
    return `${name} (${roleLabel})`;
  }
  return roleLabel;
};

const getMapPointColor = (point: MapPoint): string => {
  if (point.kind === "WORKER") {
    return "#57cbff";
  }
  const status = normalizeToken(point.status);
  if (status === "IN_PROGRESS") {
    return "#49dd87";
  }
  if (status === "ASSIGNED") {
    return "#f0c45f";
  }
  if (status === "REQUESTED" || status === "TRIAGED" || status === "OFFERED") {
    return "#ff9d73";
  }
  return "#c7d8e7";
};

const FitMapBounds = ({ points }: { points: MapPoint[] }) => {
  const map = useMap();

  useEffect(() => {
    if (!points.length) {
      return;
    }

    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 12);
      return;
    }

    const bounds = points.map((point) => [point.lat, point.lon] as [number, number]);
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
  }, [map, points]);

  return null;
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
  const [messageAudience, setMessageAudience] = useState<MessageAudience>("BOTH");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>("ALL");
  const [skillFilter, setSkillFilter] = useState("ALL");
  const [personalityFilter, setPersonalityFilter] = useState("ALL");
  const [queueSort, setQueueSort] = useState<QueueSort>("NEWEST");
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("ALL");
  const [focusPanel, setFocusPanel] = useState<FocusPanel>("SIGNALS");
  const [opsTab, setOpsTab] = useState<OpsTab>("ROUTING");
  const [mapScope, setMapScope] = useState<MapScope>("TODAY");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [mapOverview, setMapOverview] = useState<DispatchMapOverview | null>(null);
  const [calendar, setCalendar] = useState<DispatchCalendar | null>(null);
  const [priorityLevel, setPriorityLevel] = useState("HIGH");
  const [requestPatchDescription, setRequestPatchDescription] = useState("");
  const [requestPatchUrgency, setRequestPatchUrgency] = useState("HIGH");
  const [rescheduleStartLocal, setRescheduleStartLocal] = useState("");
  const [rescheduleEndLocal, setRescheduleEndLocal] = useState("");
  const overrideReasonInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const selectedJobIdRef = useRef<string | null>(null);

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedJobId) ?? null, [jobs, selectedJobId]);
  const selectedJobActionSet = useMemo(
    () => new Set((selectedJob?.availableWorkflowActions ?? []).map((action) => normalizeToken(action))),
    [selectedJob?.availableWorkflowActions]
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

  const dispatchActionButtons = useMemo(
    () =>
      Array.from(selectedJobActionSet)
        .filter(
          (action) =>
            action !== "PRIORITIZE_JOB" && action !== "EDIT_REQUEST_FIELDS_WITH_AUDIT" && action !== "RESCHEDULE"
        )
        .sort()
        .map((action) => ({
          action,
          payload: getDefaultDispatchActionPayload(action, selectedJob, selectedWorkerId)
        })),
    [selectedJob, selectedJobActionSet, selectedWorkerId]
  );

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
      const currentAudience = message.audience ?? "BOTH";
      const shouldMerge =
        Boolean(thread) &&
        thread.senderUserId === message.senderUserId &&
        thread.audience === currentAudience &&
        currentCreatedAt - previousEndedAt <= 5 * 60 * 1000;

      if (thread && shouldMerge) {
        thread.items.push(message);
        thread.endedAt = message.createdAt;
      } else {
        dayGroup.threads.push({
          senderUserId: message.senderUserId,
          senderName: message.senderName ?? null,
          senderRole: message.senderRole ?? null,
          audience: currentAudience,
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
      const status = getJobLegacyStatus(job);
      const urgency = normalizeToken(job.urgency);
      const skillSet = new Set(job.requiredSkills.map(normalizeToken));
      const personalitySet = new Set(job.personalityPreferences.map(normalizeToken));
      const matchesStatus = statusFilter === "ALL" || status === statusFilter;
      const matchesUrgency = urgencyFilter === "ALL" || urgency === urgencyFilter;
      const matchesSkill = skillFilter === "ALL" || skillSet.has(skillFilter);
      const matchesPersonality = personalityFilter === "ALL" || personalitySet.has(personalityFilter);

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

      const leftPriority = STATUS_SORT_PRIORITY[getJobLegacyStatus(left)] ?? 999;
      const rightPriority = STATUS_SORT_PRIORITY[getJobLegacyStatus(right)] ?? 999;
      return leftPriority - rightPriority;
    });

    return visibleJobs;
  }, [jobs, personalityFilter, queueSort, skillFilter, statusFilter, urgencyFilter]);

  const mapPoints = useMemo(() => {
    if (!mapOverview) {
      return [] as MapPoint[];
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

  const queueStats = useMemo(() => {
    const stats = {
      requested: 0,
      assigned: 0,
      inProgress: 0,
      urgent: 0
    };
    for (const job of filteredJobs) {
      const status = getJobLegacyStatus(job);
      const urgency = normalizeToken(job.urgency);
      if (status === "REQUESTED" || status === "TRIAGED" || status === "OFFERED") {
        stats.requested += 1;
      }
      if (status === "ASSIGNED") {
        stats.assigned += 1;
      }
      if (status === "IN_PROGRESS") {
        stats.inProgress += 1;
      }
      if (urgency === "CRITICAL" || urgency === "HIGH") {
        stats.urgent += 1;
      }
    }
    return stats;
  }, [filteredJobs]);

  const dispatchSignals = useMemo(() => {
    if (!selectedJob) {
      return [] as DispatchSignal[];
    }

    const signals: DispatchSignal[] = [];
    if (isPastDue(selectedJob)) {
      signals.push({
        id: "overdue",
        level: "CRITICAL",
        label: "Overdue schedule window",
        detail: `Job should have completed by ${new Date(selectedJob.scheduleWindowEnd!).toLocaleString()}`,
        actionHint: "Review worker status and re-route immediately"
      });
    }

    const status = getJobLegacyStatus(selectedJob);
    if (["REQUESTED", "TRIAGED", "OFFERED"].includes(status) && Date.now() - Date.parse(selectedJob.createdAt) > 2 * 60 * 60 * 1000) {
      signals.push({
        id: "stale-unassigned",
        level: "WARNING",
        label: "Unassigned for over 2 hours",
        detail: "This request has been waiting in queue",
        actionHint: "Recompute and assign best nearby skilled worker"
      });
    }

    if (!selectedJob.assignedWorkerId && candidates.length === 0) {
      signals.push({
        id: "no-candidates",
        level: "WARNING",
        label: "No candidates scored yet",
        detail: "Candidate table is empty for this job",
        actionHint: "Run Recompute Candidates"
      });
    }

    const latestMessage = messages[messages.length - 1];
    if (latestMessage && normalizeToken(latestMessage.senderRole ?? "") === "CLIENT") {
      signals.push({
        id: "customer-message",
        level: "INFO",
        label: "Latest message from customer",
        detail: latestMessage.body.length > 120 ? `${latestMessage.body.slice(0, 117)}...` : latestMessage.body,
        actionHint: "Respond in Messages panel"
      });
    }

    if (signals.length === 0) {
      signals.push({
        id: "healthy",
        level: "INFO",
        label: "No active dispatch alerts",
        detail: "Current job state looks healthy",
        actionHint: "Monitor timeline and scheduling"
      });
    }

    return signals;
  }, [candidates.length, messages, selectedJob]);

  const loadQueue = useCallback(async () => {
    if (!session) return;
    setIsRefreshing(true);
    try {
      const queue = await getQueue(session.accessToken);
      setJobs((previous) => {
        const previousById = new Map(previous.map((job) => [job.id, job]));
        const preserveJobId = selectedJobIdRef.current;
        return (queue.items ?? []).map((job) => {
          if (!preserveJobId || job.id !== preserveJobId) {
            return job;
          }
          const existing = previousById.get(job.id);
          if (!existing) {
            return job;
          }
          return {
            ...job,
            workflowState: existing.workflowState ?? job.workflowState,
            publicStatus: existing.publicStatus ?? job.publicStatus,
            availableWorkflowActions: existing.availableWorkflowActions ?? job.availableWorkflowActions,
            readReceiptsSummary: existing.readReceiptsSummary ?? job.readReceiptsSummary
          };
        });
      });
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
        getMapOverview(session.accessToken, mapScope),
        getDispatchCalendar(session.accessToken, from.toISOString(), to.toISOString())
      ]);
      setMapOverview(mapPayload);
      setCalendar(calendarPayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operations map/calendar refresh failed");
    }
  }, [mapScope, session]);

  useEffect(() => {
    selectedJobIdRef.current = selectedJobId;
  }, [selectedJobId]);

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
        const [jobDetail, candidatePayload, timelinePayload, messagePayload] = await Promise.all([
          getJobDetail(session.accessToken, jobId),
          getCandidates(session.accessToken, jobId),
          getTimeline(session.accessToken, jobId),
          getMessages(session.accessToken, jobId)
        ]);
        setJobs((previous) => previous.map((job) => (job.id === jobId ? { ...job, ...jobDetail } : job)));
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
    if (!selectedJob) {
      return;
    }
    setPriorityLevel(normalizeToken(selectedJob.urgency));
    setRequestPatchDescription(selectedJob.description ?? "");
    setRequestPatchUrgency(normalizeToken(selectedJob.urgency));
    const now = Date.now();
    setRescheduleStartLocal(
      toLocalDateTimeInputValue(
        selectedJob.scheduleWindowStart ?? new Date(now + 60 * 60 * 1000)
      )
    );
    setRescheduleEndLocal(
      toLocalDateTimeInputValue(
        selectedJob.scheduleWindowEnd ?? new Date(now + 2 * 60 * 60 * 1000)
      )
    );
  }, [selectedJob?.id]);

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
      void (async () => {
        await loadQueue();
        await loadJobPanels(selectedJobId);
        await loadOperationsView();
      })();
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
    await loadQueue();
    await loadJobPanels(selectedJobId);
    await loadOperationsView();
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
      await overrideWorker(session.accessToken, selectedJobId, selectedWorkerId, overrideReason.trim());
      setOverrideReason("");
      await refreshPanelsAfterMutation();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Override failed");
    }
  }, [overrideReason, selectedJobId, selectedWorkerId, session]);

  const onRunJobAction = useCallback(
    async (action: string, payload: Record<string, unknown>) => {
      if (!session || !selectedJobId) return;
      try {
        await runJobAction(session.accessToken, selectedJobId, action, payload);
        await refreshPanelsAfterMutation();
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Action ${action} failed`);
      }
    },
    [selectedJobId, session]
  );

  const onPrioritizeJob = useCallback(async () => {
    if (!selectedJobActionSet.has("PRIORITIZE_JOB")) {
      return;
    }
    const normalized = normalizeToken(priorityLevel);
    const level =
      normalized === "CRITICAL"
        ? "critical"
        : normalized === "HIGH"
          ? "high"
          : normalized === "LOW"
            ? "low"
            : "normal";
    await onRunJobAction("PRIORITIZE_JOB", {
      priority: { level },
      audit: { reasonCode: "dispatcher_override" }
    });
  }, [onRunJobAction, priorityLevel, selectedJobActionSet]);

  const onEditRequestWithAudit = useCallback(async () => {
    if (!selectedJobActionSet.has("EDIT_REQUEST_FIELDS_WITH_AUDIT") || !selectedJob) {
      return;
    }
    const patch: Record<string, unknown> = {};
    const nextDescription = requestPatchDescription.trim();
    if (nextDescription && nextDescription !== selectedJob.description.trim()) {
      patch.description = nextDescription;
    }
    const nextUrgency = normalizeToken(requestPatchUrgency);
    if (nextUrgency && nextUrgency !== normalizeToken(selectedJob.urgency)) {
      patch.urgency = nextUrgency;
    }
    if (Object.keys(patch).length === 0) {
      setError("Set at least one request field change before applying audit edit.");
      return;
    }
    await onRunJobAction("EDIT_REQUEST_FIELDS_WITH_AUDIT", {
      requestPatch: patch,
      audit: { reasonCode: "dispatcher_override" }
    });
  }, [onRunJobAction, requestPatchDescription, requestPatchUrgency, selectedJob, selectedJobActionSet]);

  const onRescheduleJob = useCallback(async () => {
    if (!selectedJobActionSet.has("RESCHEDULE")) {
      return;
    }
    const startAt = localDateTimeInputToIso(rescheduleStartLocal);
    const endAt = localDateTimeInputToIso(rescheduleEndLocal);
    if (!startAt || !endAt) {
      setError("Select valid schedule start and end times.");
      return;
    }
    if (Date.parse(endAt) <= Date.parse(startAt)) {
      setError("Schedule end must be after the start time.");
      return;
    }
    await onRunJobAction("RESCHEDULE", {
      schedule: { startAt, endAt },
      audit: { reasonCode: "dispatcher_override" }
    });
  }, [onRunJobAction, rescheduleEndLocal, rescheduleStartLocal, selectedJobActionSet]);

  const onSendMessage = useCallback(async () => {
    if (!session || !selectedJobId || !messageDraft.trim()) return;
    try {
      await sendMessage(session.accessToken, selectedJobId, messageDraft.trim(), messageAudience);
      setMessageDraft("");
      await loadJobPanels(selectedJobId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send message failed");
    }
  }, [loadJobPanels, messageAudience, messageDraft, selectedJobId, session]);

  const onUseTimelineReason = useCallback((reason: string) => {
    setOverrideReason(reason);
    overrideReasonInputRef.current?.focus();
  }, []);

  const onQuoteTimelineEvent = useCallback((event: TimelineEvent) => {
    const payloadSummary = JSON.stringify(event.payload);
    const line = `[${event.eventType}] ${payloadSummary.length > 150 ? `${payloadSummary.slice(0, 147)}...` : payloadSummary}`;
    setFocusPanel("MESSAGES");
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
        setFocusPanel("MESSAGES");
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
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
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
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {showShortcutHelp && (
        <section className="shortcut-panel" aria-label="Keyboard shortcuts">
          <h2>Keyboard Shortcuts</h2>
          <div className="shortcut-grid">
            <p><kbd>j</kbd>/<kbd>k</kbd> Move queue selection</p>
            <p><kbd>r</kbd> Recompute candidates</p>
            <p><kbd>a</kbd> Assign selected candidate</p>
            <p><kbd>o</kbd> Focus override reason</p>
            <p><kbd>m</kbd> Focus message draft</p>
            <p><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> Send message</p>
            <p><kbd>1-5</kbd> Timeline signal filters</p>
            <p><kbd>?</kbd> Toggle this panel</p>
          </div>
        </section>
      )}

      <section className="panel queue-top">
        <div className="queue-top-header">
          <div>
            <h2>Dispatch Queue</h2>
            <p className="queue-count">Prioritize urgent and unassigned jobs first.</p>
          </div>
          <div className="queue-summary-metrics">
            <article>
              <span>Unassigned</span>
              <strong>{queueStats.requested}</strong>
            </article>
            <article>
              <span>Assigned</span>
              <strong>{queueStats.assigned}</strong>
            </article>
            <article>
              <span>In Progress</span>
              <strong>{queueStats.inProgress}</strong>
            </article>
            <article>
              <span>Urgent</span>
              <strong>{queueStats.urgent}</strong>
            </article>
          </div>
        </div>

        <div className="queue-controls inline">
          <label>
            Status
            <select aria-label="Status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
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
            <select aria-label="Urgency filter" value={urgencyFilter} onChange={(event) => setUrgencyFilter(event.target.value as UrgencyFilter)}>
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
            <select aria-label="Skill filter" value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)}>
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
            <select aria-label="Personality filter" value={personalityFilter} onChange={(event) => setPersonalityFilter(event.target.value)}>
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
            <select aria-label="Sort queue" value={queueSort} onChange={(event) => setQueueSort(event.target.value as QueueSort)}>
              <option value="NEWEST">Newest</option>
              <option value="OLDEST">Oldest</option>
              <option value="URGENCY">Urgency</option>
              <option value="STATUS">Status</option>
            </select>
          </label>
        </div>

        <ul className="queue-grid">
          {filteredJobs.map((job) => (
            <li key={job.id}>
              <button className={job.id === selectedJobId ? "job active" : "job"} onClick={() => setSelectedJobId(job.id)}>
                <div className="job-head">
                  <strong>{formatJobHeadline(job)}</strong>
                  {isPastDue(job) && <span className="signal-pill critical">Overdue</span>}
                </div>
                <div className="job-meta">
                  <span className="badge">{getJobStatusLabel(job)}</span>
                  <span className="badge">{job.urgency}</span>
                  <span className="badge">{job.requiredSkills.length} skills</span>
                  {getDispatchUnreadCount(job) > 0 && <span className="badge">Unread {getDispatchUnreadCount(job)}</span>}
                </div>
                <small>
                  {formatToken(job.jobType)} · {new Date(job.createdAt).toLocaleString()}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="dispatch-workbench-layout">
        <section className="panel assignment-panel">
          <h2>Assignment Workbench</h2>
          {selectedJob ? (
            <>
              <div className="job-summary compact">
                <p><strong>Job:</strong> {formatJobHeadline(selectedJob)}</p>
                <p><strong>Customer:</strong> {formatCustomerLabel(selectedJob)}</p>
                <p data-testid="selected-job-id"><strong>Record ID:</strong> {selectedJob.id}</p>
                <p><strong>Status:</strong> {getJobStatusLabel(selectedJob)}</p>
                <p><strong>Workflow:</strong> {selectedJob.workflowState ?? "-"}</p>
                <p><strong>Urgency:</strong> {selectedJob.urgency}</p>
                <p>
                  <strong>Read Receipts:</strong>{" "}
                  Msg unread {selectedJob.readReceiptsSummary?.messages?.unreadForDispatch ?? 0} ·
                  Change orders unread {selectedJob.readReceiptsSummary?.changeOrders?.unreadForDispatch ?? 0} ·
                  Payment unread {selectedJob.readReceiptsSummary?.paymentRequests?.unreadForDispatch ?? 0}
                </p>
                <p>
                  <strong>Window:</strong>{" "}
                  {selectedJob.scheduleWindowStart && selectedJob.scheduleWindowEnd
                    ? `${new Date(selectedJob.scheduleWindowStart).toLocaleString()} - ${new Date(selectedJob.scheduleWindowEnd).toLocaleString()}`
                    : "Not scheduled"}
                </p>
                <p><strong>Selected Worker:</strong> <span data-testid="selected-worker-id">{selectedWorkerLabel}</span></p>
              </div>

              <div className="actions stacked">
                <button onClick={onRecompute}>Recompute Candidates</button>
                <button onClick={onAssign} disabled={!selectedWorkerId}>Assign Selected Candidate</button>
                <input
                  ref={overrideReasonInputRef}
                  placeholder="Override reason"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                />
                <button onClick={onOverride} disabled={!selectedWorkerId || !overrideReason.trim()}>
                  Override Selected Candidate
                </button>
                {selectedJobActionSet.has("PRIORITIZE_JOB") && (
                  <div className="workflow-action-inline">
                    <label>
                      Priority level
                      <select value={priorityLevel} onChange={(event) => setPriorityLevel(event.target.value)}>
                        <option value="LOW">Low</option>
                        <option value="NORMAL">Normal</option>
                        <option value="HIGH">High</option>
                        <option value="CRITICAL">Critical</option>
                      </select>
                    </label>
                    <button className="secondary" onClick={() => void onPrioritizeJob()}>
                      Prioritize Job
                    </button>
                  </div>
                )}
                {selectedJobActionSet.has("EDIT_REQUEST_FIELDS_WITH_AUDIT") && (
                  <div className="workflow-action-inline">
                    <label>
                      Request description
                      <input
                        value={requestPatchDescription}
                        onChange={(event) => setRequestPatchDescription(event.target.value)}
                      />
                    </label>
                    <label>
                      Request urgency
                      <select value={requestPatchUrgency} onChange={(event) => setRequestPatchUrgency(event.target.value)}>
                        <option value="LOW">Low</option>
                        <option value="MEDIUM">Medium</option>
                        <option value="HIGH">High</option>
                        <option value="CRITICAL">Critical</option>
                      </select>
                    </label>
                    <button className="secondary" onClick={() => void onEditRequestWithAudit()}>
                      Apply Request Edit (Audit)
                    </button>
                  </div>
                )}
                {selectedJobActionSet.has("RESCHEDULE") && (
                  <div className="workflow-action-inline">
                    <label>
                      Start
                      <input
                        type="datetime-local"
                        value={rescheduleStartLocal}
                        onChange={(event) => setRescheduleStartLocal(event.target.value)}
                      />
                    </label>
                    <label>
                      End
                      <input
                        type="datetime-local"
                        value={rescheduleEndLocal}
                        onChange={(event) => setRescheduleEndLocal(event.target.value)}
                      />
                    </label>
                    <button className="secondary" onClick={() => void onRescheduleJob()}>
                      Apply Reschedule
                    </button>
                  </div>
                )}
                {dispatchActionButtons.length > 0 && (
                  <div className="workflow-action-stack">
                    <small>Workflow actions</small>
                    <div className="workflow-action-grid">
                      {dispatchActionButtons.map(({ action, payload }) => (
                        <button
                          key={action}
                          className="secondary"
                          onClick={() => payload && void onRunJobAction(action, payload)}
                          disabled={!payload}
                          title={!payload ? "Select a candidate first" : undefined}
                        >
                          {formatToken(action)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <h3>Candidates</h3>
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Worker</th>
                    <th>Score</th>
                    <th>Action</th>
                    <th>Breakdown</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((candidate) => (
                    <tr key={candidate.workerId} className={selectedWorkerId === candidate.workerId ? "candidate-selected" : ""}>
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

        <section className="panel context-panel">
          <div className="context-nav" role="tablist" aria-label="Job context tabs">
            <button className={focusPanel === "SIGNALS" ? "chip active" : "chip"} onClick={() => setFocusPanel("SIGNALS")}>Signals</button>
            <button className={focusPanel === "DETAILS" ? "chip active" : "chip"} onClick={() => setFocusPanel("DETAILS")}>Details</button>
            <button className={focusPanel === "MESSAGES" ? "chip active" : "chip"} onClick={() => setFocusPanel("MESSAGES")}>Messages</button>
            <button className={focusPanel === "TIMELINE" ? "chip active" : "chip"} onClick={() => setFocusPanel("TIMELINE")}>Timeline</button>
          </div>

          {focusPanel === "SIGNALS" && (
            <div className="signal-list">
              <h2>Dispatch Signals</h2>
              {dispatchSignals.map((signal) => (
                <article key={signal.id} className={`signal-card ${signal.level.toLowerCase()}`}>
                  <header>
                    <span className={`signal-pill ${signal.level.toLowerCase()}`}>{signal.level}</span>
                    <strong>{signal.label}</strong>
                  </header>
                  <p>{signal.detail}</p>
                  {signal.actionHint && <small>{signal.actionHint}</small>}
                </article>
              ))}
            </div>
          )}

          {focusPanel === "DETAILS" && (
            <div className="job-summary expanded">
              <h2>Job Detail</h2>
              {selectedJob ? (
                <>
                  <p><strong>Headline:</strong> {formatJobHeadline(selectedJob)}</p>
                  <p><strong>Customer:</strong> {formatCustomerLabel(selectedJob)}</p>
                  <p><strong>Record ID:</strong> {selectedJob.id}</p>
                  <p><strong>Status:</strong> {getJobStatusLabel(selectedJob)}</p>
                  <p><strong>Workflow:</strong> {selectedJob.workflowState ?? "-"}</p>
                  <p><strong>Urgency:</strong> {selectedJob.urgency}</p>
                  <p><strong>Skills:</strong> {selectedJob.requiredSkills.join(", ") || "None"}</p>
                  <p><strong>Personality:</strong> {selectedJob.personalityPreferences.join(", ") || "None"}</p>
                  <p>
                    <strong>Assigned Worker:</strong>{" "}
                    {selectedJob.assignedWorkerDisplayName ?? selectedJob.assignedWorkerId ?? "Not assigned"}
                  </p>
                  <div className="read-receipt-summary">
                    <p>
                      <strong>Dispatch Read Receipts:</strong>{" "}
                      {getDispatchUnreadCount(selectedJob)} unread total
                    </p>
                    <p>
                      Messages: {selectedJob.readReceiptsSummary?.messages?.unreadForDispatch ?? 0} unread · last read{" "}
                      {formatOptionalTimestamp(selectedJob.readReceiptsSummary?.messages?.lastReadAt)}
                    </p>
                    <p>
                      Change orders: {selectedJob.readReceiptsSummary?.changeOrders?.unreadForDispatch ?? 0} unread · last read{" "}
                      {formatOptionalTimestamp(selectedJob.readReceiptsSummary?.changeOrders?.lastReadAt)}
                    </p>
                    <p>
                      Payment requests: {selectedJob.readReceiptsSummary?.paymentRequests?.unreadForDispatch ?? 0} unread · last read{" "}
                      {formatOptionalTimestamp(selectedJob.readReceiptsSummary?.paymentRequests?.lastReadAt)}
                    </p>
                  </div>
                  <p>
                    <strong>Window:</strong>{" "}
                    {selectedJob.scheduleWindowStart && selectedJob.scheduleWindowEnd
                      ? `${new Date(selectedJob.scheduleWindowStart).toLocaleString()} - ${new Date(selectedJob.scheduleWindowEnd).toLocaleString()}`
                      : "Not scheduled"}
                  </p>
                </>
              ) : (
                <p>Select a job to inspect details.</p>
              )}
            </div>
          )}

          {focusPanel === "MESSAGES" && (
            <div>
              <h2>Messaging {selectedJob ? `· ${formatJobHeadline(selectedJob)}` : ""}</h2>
              <div className="messages grouped">
                {groupedMessages.map((dayGroup) => (
                  <section key={dayGroup.dayKey} className="message-day-group">
                    <h3>{dayGroup.dayLabel}</h3>
                    {dayGroup.threads.map((thread, index) => {
                      const senderPreview: Message = {
                        id: `${dayGroup.dayKey}-${index}`,
                        threadId: "",
                        senderUserId: thread.senderUserId,
                        senderName: thread.senderName,
                        senderRole: thread.senderRole,
                        body: "",
                        attachmentObjectKey: null,
                        audience: thread.audience,
                        createdAt: thread.startedAt
                      };
                      return (
                        <article key={`${dayGroup.dayKey}-${thread.senderUserId}-${thread.startedAt}-${index}`} className="message-thread">
                          <header>
                            <strong>{formatMessageSender(senderPreview)}</strong>
                            <span className="message-tag">{getAudienceLabel(thread.audience)}</span>
                            <span>{new Date(thread.startedAt).toLocaleTimeString()}</span>
                          </header>
                          <div className="message-thread-lines">
                            {thread.items.map((message) => (
                              <p key={message.id}>{message.body}</p>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                  </section>
                ))}
              </div>
              <div className="compose with-audience">
                <select
                  aria-label="Message audience"
                  value={messageAudience}
                  onChange={(event) => setMessageAudience(event.target.value as MessageAudience)}
                  disabled={!selectedJobId}
                >
                  {MESSAGE_AUDIENCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
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
            </div>
          )}

          {focusPanel === "TIMELINE" && (
            <>
              <h2>Timeline</h2>
              <div className="timeline-chips" role="group" aria-label="Timeline filters">
                {TIMELINE_FILTERS.map((filter) => (
                  <button key={filter} className={timelineFilter === filter ? "chip active" : "chip"} onClick={() => setTimelineFilter(filter)}>
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
            </>
          )}
        </section>
      </section>

      <section className="panel ops-shell">
        <div className="ops-nav">
          <h2>Operations</h2>
          <div className="ops-tab-switch">
            <button className={opsTab === "ROUTING" ? "chip active" : "chip"} onClick={() => setOpsTab("ROUTING")}>Routing</button>
            <button className={opsTab === "SCHEDULING" ? "chip active" : "chip"} onClick={() => setOpsTab("SCHEDULING")}>Scheduling</button>
          </div>
        </div>

        {opsTab === "ROUTING" && (
          <div className="ops-content routing-view">
            <div className="routing-toolbar">
              <div className="map-scope-selector" role="group" aria-label="Map time scope">
                {MAP_SCOPES.map((scopeOption) => (
                  <button
                    key={scopeOption.scope}
                    className={mapScope === scopeOption.scope ? "chip active" : "chip"}
                    onClick={() => setMapScope(scopeOption.scope)}
                    title={scopeOption.hint}
                  >
                    {scopeOption.label}
                  </button>
                ))}
              </div>
              <p className="queue-count">
                {mapOverview
                  ? `${mapOverview.jobs.length} jobs · ${mapOverview.workers.length} workers · scope ${formatToken(mapOverview.scope ?? mapScope)}`
                  : "Loading map overview..."}
              </p>
            </div>

            <div className="map-panel">
              {mapPoints.length > 0 ? (
                <LeafletMapContainer center={[mapPoints[0].lat, mapPoints[0].lon]} zoom={10} scrollWheelZoom className="routing-map">
                  <LeafletTileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <FitMapBounds points={mapPoints} />
                  {(mapOverview?.routeSuggestions ?? []).slice(0, 12).map((route) => (
                    <LeafletPolyline
                      key={`${route.workerId}-${route.toJobId}`}
                      positions={[
                        [route.from.lat, route.from.lon],
                        [route.to.lat, route.to.lon]
                      ]}
                      pathOptions={{ color: "#5cb3ff", weight: 2, dashArray: "6 6" }}
                    />
                  ))}
                  {mapPoints.map((point) => (
                    <LeafletCircleMarker
                      key={point.id}
                      center={[point.lat, point.lon]}
                      radius={point.kind === "JOB" ? 9 : 7}
                      pathOptions={{
                        color: "#00131f",
                        weight: 1,
                        fillColor: getMapPointColor(point),
                        fillOpacity: 0.92
                      }}
                      eventHandlers={{
                        click: () => {
                          if (point.kind === "JOB") {
                            const jobId = point.id.replace("job-", "");
                            setSelectedJobId(jobId);
                          }
                        }
                      }}
                    >
                      <LeafletPopup>
                        <div className="popup-content">
                          <strong>{point.label}</strong>
                          <p>{formatLatLon(point.lat, point.lon)}</p>
                          {point.kind === "JOB" && (
                            <button className="secondary" onClick={() => setSelectedJobId(point.id.replace("job-", ""))}>
                              Open Job
                            </button>
                          )}
                        </div>
                      </LeafletPopup>
                    </LeafletCircleMarker>
                  ))}
                </LeafletMapContainer>
              ) : (
                <div className="map-empty-state">No map points available for selected scope.</div>
              )}
            </div>

            <h3>Optimal Next-Job Paths</h3>
            <ul className="route-list">
              {(mapOverview?.routeSuggestions ?? []).slice(0, 10).map((route) => (
                <li key={`${route.workerId}-${route.toJobId}`}>
                  <strong>{route.workerDisplayName}</strong> →{" "}
                  <button className="linkish" onClick={() => setSelectedJobId(route.toJobId)}>
                    {route.toJobDescription}
                  </button>
                  <small> · {route.distanceKm.toFixed(1)} km · ~{route.estimatedDriveMinutes} min</small>
                </li>
              ))}
              {mapOverview && mapOverview.routeSuggestions.length === 0 && (
                <li><small>No route suggestions available.</small></li>
              )}
            </ul>
          </div>
        )}

        {opsTab === "SCHEDULING" && (
          <div className="ops-content">
            <h3>Scheduling Calendar</h3>
            {calendar ? (
              <p className="queue-count">
                {new Date(calendar.range.from).toLocaleDateString()} - {new Date(calendar.range.to).toLocaleDateString()}
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
                          .map((timeOff) => `${new Date(timeOff.startAt).toLocaleDateString()}-${new Date(timeOff.endAt).toLocaleDateString()}`)
                          .join(", ")
                      : "None"}
                  </p>
                  <p><strong>Scheduled Jobs:</strong> {worker.scheduledJobs.length}</p>
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
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
