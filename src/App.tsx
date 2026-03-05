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
  getReadReceipts,
  getTimeline,
  login,
  recomputeCandidates,
  sendMessage,
  overrideWorker,
  runJobAction
} from "./api";
import { Candidate, DispatchCalendar, DispatchMapOverview, Job, JobReadReceipt, MapScope, Message, TimelineEvent } from "./types";
import { t } from "./i18n";

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
type TranslationDisplay = "ORIGINAL" | "TRANSLATED" | "BOTH";
type FocusPanel = "SIGNALS" | "DETAILS" | "MESSAGES" | "TIMELINE" | "PAYMENTS_DISPUTES";
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

type WorkflowActionEvent = {
  event: TimelineEvent;
  action: string;
  workflowActionId: string | null;
  actionPayload: Record<string, unknown>;
};

const WORKFLOW_STATUSES = [
  "DRAFT",
  "REQUESTED",
  "DISPATCHING",
  "OFFERED",
  "OFFER_EXPIRED",
  "WORKER_ACCEPTED",
  "CLIENT_CONFIRMED",
  "SCHEDULED",
  "IN_PROGRESS",
  "WORK_PAUSED",
  "CHANGE_REQUESTED",
  "WORK_SUBMITTED",
  "CLIENT_APPROVED",
  "AUTO_APPROVED",
  "PAYMENT_PENDING",
  "PAYMENT_SUBMITTED",
  "DISPUTED",
  "DISPUTE_REVIEW",
  "DISPUTE_APPROVED",
  "DISPUTE_REJECTED",
  "RESOLVED",
  "NO_SHOW",
  "COMPLETED",
  "CANCELLED"
] as const;
type StatusFilter = "ALL" | (typeof WORKFLOW_STATUSES)[number];

const URGENCY_LEVELS = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;
type UrgencyFilter = "ALL" | (typeof URGENCY_LEVELS)[number];
type LanguageFilter = "ALL" | "ENG" | "LAO" | "NONE";
type RequestPatchLanguage = "UNCHANGED" | "ENG" | "LAO" | "NONE";

const LANGUAGE_OPTIONS = ["ENG", "LAO"] as const;
type AppLanguage = (typeof LANGUAGE_OPTIONS)[number];
const DEFAULT_APP_LANGUAGE: AppLanguage = "ENG";
const APP_LANGUAGE_STORAGE_KEY = "laoWorksDispatchAppLanguage";

const MAP_SCOPES: MapScope[] = ["TODAY", "FUTURE", "PAST", "ALL"];

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
  DRAFT: 0,
  REQUESTED: 1,
  DISPATCHING: 2,
  OFFERED: 3,
  OFFER_EXPIRED: 4,
  WORKER_ACCEPTED: 5,
  CLIENT_CONFIRMED: 6,
  SCHEDULED: 7,
  IN_PROGRESS: 8,
  WORK_PAUSED: 9,
  CHANGE_REQUESTED: 10,
  WORK_SUBMITTED: 11,
  CLIENT_APPROVED: 12,
  AUTO_APPROVED: 13,
  PAYMENT_PENDING: 14,
  PAYMENT_SUBMITTED: 15,
  DISPUTED: 16,
  DISPUTE_REVIEW: 17,
  DISPUTE_APPROVED: 18,
  DISPUTE_REJECTED: 19,
  RESOLVED: 20,
  NO_SHOW: 21,
  COMPLETED: 22,
  CANCELLED: 23
};

const URGENCY_SORT_PRIORITY: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3
};

const TIMELINE_FILTERS: TimelineFilter[] = ["ALL", "ASSIGNMENT", "LIFECYCLE", "MESSAGING", "SYSTEM"];

const timelineFilterLabelKey: Record<TimelineFilter, string> = {
  ALL: "timeline.all",
  ASSIGNMENT: "timeline.assignment",
  LIFECYCLE: "timeline.lifecycle",
  MESSAGING: "timeline.messaging",
  SYSTEM: "timeline.system"
};

const audienceLabelKey: Record<MessageAudience, string> = {
  BOTH: "audience.both",
  WORKER: "audience.worker",
  CLIENT: "audience.client"
};

const mapScopeLabelKey: Record<MapScope, string> = {
  TODAY: "map.scope.today",
  FUTURE: "map.scope.future",
  PAST: "map.scope.past",
  ALL: "map.scope.all"
};

const mapScopeHintKey: Record<MapScope, string> = {
  TODAY: "map.hint.today",
  FUTURE: "map.hint.future",
  PAST: "map.hint.past",
  ALL: "map.hint.all"
};

const normalizeToken = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, "_");

const normalizeLanguageCode = (value: string | null | undefined): "ENG" | "LAO" | null => {
  if (!value) {
    return null;
  }
  const token = value.trim().toUpperCase();
  if (["ENG", "EN", "ENGLISH"].includes(token)) {
    return "ENG";
  }
  if (["LAO", "LO", "LA"].includes(token)) {
    return "LAO";
  }
  return null;
};

const formatLanguageCode = (value: string | null | undefined): string => {
  const normalized = normalizeLanguageCode(value);
  if (normalized === "ENG") {
    return "English (ENG)";
  }
  if (normalized === "LAO") {
    return "Lao (LAO)";
  }
  return "Not set";
};

const getInitialAppLanguage = (): AppLanguage => {
  if (typeof window === "undefined") {
    return DEFAULT_APP_LANGUAGE;
  }
  const stored = window.localStorage.getItem(APP_LANGUAGE_STORAGE_KEY);
  return normalizeLanguageCode(stored) ?? DEFAULT_APP_LANGUAGE;
};

const getMessageTranslationTargets = (sourceLanguage: AppLanguage): Array<"ENG" | "LAO"> =>
  sourceLanguage === "ENG" ? ["LAO"] : ["ENG"];

const formatToken = (value: string): string =>
  value
    .split("_")
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");

const removeSchedulingMetaFromDescription = (description: string | null | undefined): string => {
  if (!description) {
    return "";
  }
  return description
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[Scheduling]"))
    .join(" ")
    .trim();
};

const extractSchedulingMetaLine = (description: string | null | undefined): string | null => {
  if (!description) {
    return null;
  }
  const line = description
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("[Scheduling]"));
  if (!line) {
    return null;
  }
  return line.replace("[Scheduling]", "").trim();
};

const getWindowLabel = (job: Pick<Job, "scheduleWindowStart" | "scheduleWindowEnd">): string => {
  if (job.scheduleWindowStart && job.scheduleWindowEnd) {
    return `${new Date(job.scheduleWindowStart).toLocaleString()} - ${new Date(job.scheduleWindowEnd).toLocaleString()}`;
  }
  if (job.scheduleWindowStart) {
    return new Date(job.scheduleWindowStart).toLocaleString();
  }
  if (job.scheduleWindowEnd) {
    return new Date(job.scheduleWindowEnd).toLocaleString();
  }
  return "Not scheduled";
};

const inferSchedulePreference = (job: Pick<Job, "description" | "scheduleWindowStart" | "scheduleWindowEnd">): string => {
  const schedulingMeta = extractSchedulingMetaLine(job.description);
  if (schedulingMeta) {
    const normalized = schedulingMeta.toLowerCase();
    if (normalized.includes("asap")) {
      return "ASAP (next 6h)";
    }
    if (normalized.includes("6-hour window")) {
      return "6-hour window";
    }
    if (normalized.includes("specific-time premium")) {
      return "Specific time (+ premium)";
    }
    return schedulingMeta;
  }

  if (job.scheduleWindowStart && job.scheduleWindowEnd) {
    const start = Date.parse(job.scheduleWindowStart);
    const end = Date.parse(job.scheduleWindowEnd);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const hours = (end - start) / (1000 * 60 * 60);
      if (hours >= 5.5 && hours <= 6.5) {
        return "6-hour window";
      }
      if (hours <= 1.25) {
        return "Specific time";
      }
    }
    return "Scheduled window";
  }

  return "Not set";
};

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
    case "OFFER_DISPUTE_RESOLUTION":
      return {
        resolution: {
          type: "partial_refund",
          summary: "Offer partial refund and close the dispute."
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
      return {
        resolution: {
          type: "partial_refund",
          summary: "Offer partial refund and close the dispute."
        },
        dispute: {
          decisionReason: "Reviewed by dispatch"
        }
      };
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
  const cleanedDescription = removeSchedulingMetaFromDescription(job.description);
  const description = cleanedDescription || formatToken(job.jobType);
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

const parseWorkflowActionEvent = (event: TimelineEvent): WorkflowActionEvent | null => {
  if (normalizeToken(event.eventType) !== "WORKFLOW_ACTION" || !isRecord(event.payload)) {
    return null;
  }
  const actionRaw = event.payload.action;
  if (typeof actionRaw !== "string" || !actionRaw.trim()) {
    return null;
  }
  return {
    event,
    action: normalizeToken(actionRaw),
    workflowActionId: typeof event.payload.workflowActionId === "string" ? event.payload.workflowActionId : null,
    actionPayload: isRecord(event.payload.actionPayload) ? event.payload.actionPayload : {}
  };
};

const findLatestWorkflowAction = (events: TimelineEvent[], actions: string[]): WorkflowActionEvent | null => {
  const actionSet = new Set(actions.map((action) => normalizeToken(action)));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = parseWorkflowActionEvent(events[index]);
    if (parsed && actionSet.has(parsed.action)) {
      return parsed;
    }
  }
  return null;
};

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
  const workflowState = normalizeToken(job.workflowState ?? job.status);
  return windowEnd < Date.now() && !["COMPLETED", "CANCELLED"].includes(workflowState);
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

const getMessageTranslationLabel = (message: Message, locale: AppLanguage): string | null => {
  const status = normalizeToken(message.translationStatus ?? "NONE");
  if (status === "READY") {
    return locale === "LAO" ? "ແປອັດຕະໂນມັດ" : "Auto-translated";
  }
  if (status === "PENDING") {
    return locale === "LAO" ? "ກໍາລັງແປ" : "Translating";
  }
  if (status === "FAILED") {
    return locale === "LAO" ? "ການແປລົ້ມເຫຼວ" : "Translation failed";
  }
  return null;
};

const getMapPointColor = (point: MapPoint): string => {
  if (point.kind === "WORKER") {
    return "#57cbff";
  }
  const status = normalizeToken(point.status);
  if (
    [
      "IN_PROGRESS",
      "WORK_PAUSED",
      "CHANGE_REQUESTED",
      "WORK_SUBMITTED",
      "CLIENT_APPROVED",
      "AUTO_APPROVED",
      "PAYMENT_PENDING",
      "PAYMENT_SUBMITTED",
      "DISPUTED",
      "DISPUTE_REVIEW",
      "DISPUTE_APPROVED",
      "DISPUTE_REJECTED",
      "RESOLVED"
    ].includes(status)
  ) {
    return "#49dd87";
  }
  if (["WORKER_ACCEPTED", "CLIENT_CONFIRMED", "SCHEDULED"].includes(status)) {
    return "#f0c45f";
  }
  if (["DRAFT", "REQUESTED", "DISPATCHING", "OFFERED", "OFFER_EXPIRED"].includes(status)) {
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
  const [readReceipts, setReadReceipts] = useState<JobReadReceipt[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [overrideReason, setOverrideReason] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [messageAudience, setMessageAudience] = useState<MessageAudience>("BOTH");
  const [messageTranslationDisplay, setMessageTranslationDisplay] = useState<TranslationDisplay>("BOTH");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [urgencyFilter, setUrgencyFilter] = useState<UrgencyFilter>("ALL");
  const [languageFilter, setLanguageFilter] = useState<LanguageFilter>("ALL");
  const [appLanguage, setAppLanguage] = useState<AppLanguage>(() => getInitialAppLanguage());
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
  const [requestPatchLanguage, setRequestPatchLanguage] = useState<RequestPatchLanguage>("UNCHANGED");
  const [rescheduleStartLocal, setRescheduleStartLocal] = useState("");
  const [rescheduleEndLocal, setRescheduleEndLocal] = useState("");
  const [paymentConfirmAmount, setPaymentConfirmAmount] = useState("0");
  const [paymentRejectReasonCode, setPaymentRejectReasonCode] = useState("amount_mismatch");
  const [disputeDecisionReason, setDisputeDecisionReason] = useState("Reviewed by dispatch");
  const [disputeResolutionType, setDisputeResolutionType] = useState("partial_refund");
  const [disputeResolutionSummary, setDisputeResolutionSummary] = useState(
    "Offer partial refund and close the dispute."
  );
  const [requestMoreInfoTargetRole, setRequestMoreInfoTargetRole] = useState("client");
  const [requestMoreInfoMessage, setRequestMoreInfoMessage] = useState("Please provide additional dispute details.");
  const overrideReasonInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);

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
            action !== "PRIORITIZE_JOB" &&
            action !== "EDIT_REQUEST_FIELDS_WITH_AUDIT" &&
            action !== "RESCHEDULE" &&
            action !== "CONFIRM_PAYMENT" &&
            action !== "REJECT_PAYMENT_PROOF" &&
            action !== "BEGIN_DISPUTE_REVIEW" &&
            action !== "OFFER_DISPUTE_RESOLUTION" &&
            action !== "APPROVE_DISPUTE" &&
            action !== "REJECT_DISPUTE" &&
            action !== "REQUEST_MORE_INFO"
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

  const latestChangeOrderAction = useMemo(
    () => findLatestWorkflowAction(timeline, ["SUBMIT_CHANGE_ORDER", "MEDIATE_CHANGE_ORDER", "EMERGENCY_OVERRIDE_APPROVAL"]),
    [timeline]
  );
  const latestWorkSubmissionAction = useMemo(() => findLatestWorkflowAction(timeline, ["SUBMIT_WORK"]), [timeline]);
  const latestPaymentProofAction = useMemo(() => findLatestWorkflowAction(timeline, ["SUBMIT_PAYMENT_PROOF"]), [timeline]);
  const latestDisputeAction = useMemo(
    () =>
      findLatestWorkflowAction(timeline, [
        "OPEN_DISPUTE",
        "OPEN_DISPUTE_DISPATCH",
        "OFFER_DISPUTE_RESOLUTION",
        "APPROVE_DISPUTE",
        "ACCEPT_DISPUTE_RESOLUTION",
        "REJECT_DISPUTE_RESOLUTION",
        "REJECT_DISPUTE"
      ]),
    [timeline]
  );
  const latestRequestMoreInfoAction = useMemo(() => findLatestWorkflowAction(timeline, ["REQUEST_MORE_INFO"]), [timeline]);
  const latestChangeOrderPayload = useMemo(() => {
    const payload = latestChangeOrderAction?.actionPayload;
    if (!payload) return null;
    if (isRecord(payload.changeOrder)) return payload.changeOrder;
    if (isRecord(payload.mediation)) return payload.mediation;
    if (isRecord(payload.override)) return payload.override;
    return null;
  }, [latestChangeOrderAction]);
  const latestCompletionEvidence = useMemo(() => {
    const payload = latestWorkSubmissionAction?.actionPayload;
    if (!payload || !isRecord(payload.completionEvidence)) {
      return null;
    }
    return payload.completionEvidence;
  }, [latestWorkSubmissionAction]);
  const latestPaymentProof = useMemo(() => {
    const payload = latestPaymentProofAction?.actionPayload;
    if (!payload || !isRecord(payload.paymentProof)) {
      return null;
    }
    return payload.paymentProof;
  }, [latestPaymentProofAction]);
  const latestDisputePayload = useMemo(() => {
    const payload = latestDisputeAction?.actionPayload;
    if (!payload || !isRecord(payload.dispute)) {
      return null;
    }
    return payload.dispute;
  }, [latestDisputeAction]);
  const latestResolutionOfferPayload = useMemo(() => {
    const payload = latestDisputeAction?.actionPayload;
    if (!payload || !isRecord(payload.resolution)) {
      return null;
    }
    return payload.resolution;
  }, [latestDisputeAction]);
  const latestRequestInfoPayload = useMemo(() => {
    const payload = latestRequestMoreInfoAction?.actionPayload;
    if (!payload || !isRecord(payload.request)) {
      return null;
    }
    return payload.request;
  }, [latestRequestMoreInfoAction]);

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
      const status = normalizeToken(job.workflowState ?? job.status);
      const urgency = normalizeToken(job.urgency);
      const language = normalizeLanguageCode(job.languagePreference);
      const skillSet = new Set(job.requiredSkills.map(normalizeToken));
      const personalitySet = new Set(job.personalityPreferences.map(normalizeToken));
      const matchesStatus = statusFilter === "ALL" || status === statusFilter;
      const matchesUrgency = urgencyFilter === "ALL" || urgency === urgencyFilter;
      const matchesLanguage =
        languageFilter === "ALL" ||
        (languageFilter === "NONE" ? language === null : language === languageFilter);
      const matchesSkill = skillFilter === "ALL" || skillSet.has(skillFilter);
      const matchesPersonality = personalityFilter === "ALL" || personalitySet.has(personalityFilter);

      return matchesStatus && matchesUrgency && matchesLanguage && matchesSkill && matchesPersonality;
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

      const leftStatus = normalizeToken(left.workflowState ?? left.status);
      const rightStatus = normalizeToken(right.workflowState ?? right.status);
      const leftPriority = STATUS_SORT_PRIORITY[leftStatus] ?? 999;
      const rightPriority = STATUS_SORT_PRIORITY[rightStatus] ?? 999;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    });

    return visibleJobs;
  }, [jobs, languageFilter, personalityFilter, queueSort, skillFilter, statusFilter, urgencyFilter]);

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
      const status = normalizeToken(job.workflowState ?? job.status);
      const urgency = normalizeToken(job.urgency);
      if (["REQUESTED", "DISPATCHING", "OFFERED", "OFFER_EXPIRED"].includes(status)) {
        stats.requested += 1;
      }
      if (["WORKER_ACCEPTED", "CLIENT_CONFIRMED", "SCHEDULED"].includes(status)) {
        stats.assigned += 1;
      }
      if (
        [
          "IN_PROGRESS",
          "WORK_PAUSED",
          "CHANGE_REQUESTED",
          "WORK_SUBMITTED",
          "CLIENT_APPROVED",
          "AUTO_APPROVED",
          "PAYMENT_PENDING",
          "PAYMENT_SUBMITTED",
          "DISPUTED",
          "DISPUTE_REVIEW",
          "DISPUTE_APPROVED",
          "DISPUTE_REJECTED",
          "RESOLVED",
          "NO_SHOW"
        ].includes(status)
      ) {
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

    const status = normalizeToken(selectedJob.workflowState ?? selectedJob.status);
    if (["REQUESTED", "DISPATCHING", "OFFERED", "OFFER_EXPIRED"].includes(status) && Date.now() - Date.parse(selectedJob.createdAt) > 2 * 60 * 60 * 1000) {
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
        return (queue.items ?? []).map((job) => {
          const existing = previousById.get(job.id);
          if (!existing) {
            return job;
          }
          return {
            ...existing,
            ...job,
            availableWorkflowActions:
              existing.availableWorkflowActions ?? job.availableWorkflowActions
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

  const loadJobPanels = useCallback(
    async (jobId: string | null = selectedJobId) => {
      if (!session || !jobId) {
        setCandidates([]);
        setSelectedWorkerId(null);
        setTimeline([]);
        setReadReceipts([]);
        setMessages([]);
        return;
      }
      try {
        const [jobDetail, candidatePayload, timelinePayload, readReceiptsPayload, messagePayload] = await Promise.all([
          getJobDetail(session.accessToken, jobId),
          getCandidates(session.accessToken, jobId),
          getTimeline(session.accessToken, jobId),
          getReadReceipts(session.accessToken, jobId),
          getMessages(session.accessToken, jobId, {
            viewerLanguage: appLanguage,
            translationDisplay: messageTranslationDisplay
          })
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
        setReadReceipts(
          (readReceiptsPayload.items ?? [])
            .slice()
            .sort((left, right) => Date.parse(right.readAt) - Date.parse(left.readAt))
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
    [appLanguage, messageTranslationDisplay, selectedJobId, session]
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
    setRequestPatchLanguage(normalizeLanguageCode(selectedJob.languagePreference) ?? "NONE");
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
    if (typeof window !== "undefined") {
      window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, appLanguage);
    }
  }, [appLanguage]);

  useEffect(() => {
    const paymentProof = latestPaymentProofAction?.actionPayload.paymentProof;
    if (!isRecord(paymentProof)) {
      return;
    }
    const paidAmount = paymentProof.paidAmount;
    if (typeof paidAmount === "number" && Number.isFinite(paidAmount) && paidAmount >= 0) {
      setPaymentConfirmAmount(String(Math.round(paidAmount)));
    }
  }, [latestPaymentProofAction]);

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
    const currentLanguage = normalizeLanguageCode(selectedJob.languagePreference);
    if (requestPatchLanguage !== "UNCHANGED") {
      if (requestPatchLanguage === "NONE" && currentLanguage !== null) {
        patch.languagePreference = null;
      } else if (
        (requestPatchLanguage === "ENG" || requestPatchLanguage === "LAO") &&
        requestPatchLanguage !== currentLanguage
      ) {
        patch.languagePreference = requestPatchLanguage;
      }
    }
    if (Object.keys(patch).length === 0) {
      setError("Set at least one request field change before applying audit edit.");
      return;
    }
    await onRunJobAction("EDIT_REQUEST_FIELDS_WITH_AUDIT", {
      requestPatch: patch,
      audit: { reasonCode: "dispatcher_override" }
    });
  }, [onRunJobAction, requestPatchDescription, requestPatchLanguage, requestPatchUrgency, selectedJob, selectedJobActionSet]);

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

  const onConfirmPayment = useCallback(async () => {
    if (!selectedJobActionSet.has("CONFIRM_PAYMENT")) {
      return;
    }
    const confirmedAmount = Number(paymentConfirmAmount);
    if (!Number.isFinite(confirmedAmount) || confirmedAmount < 0) {
      setError("Enter a valid confirmed payment amount.");
      return;
    }
    await onRunJobAction("CONFIRM_PAYMENT", {
      paymentConfirmation: {
        confirmedAmount: Math.round(confirmedAmount),
        confirmedAt: new Date().toISOString()
      }
    });
  }, [onRunJobAction, paymentConfirmAmount, selectedJobActionSet]);

  const onRejectPaymentProof = useCallback(async () => {
    if (!selectedJobActionSet.has("REJECT_PAYMENT_PROOF")) {
      return;
    }
    await onRunJobAction("REJECT_PAYMENT_PROOF", {
      paymentReject: {
        reasonCode: paymentRejectReasonCode
      }
    });
  }, [onRunJobAction, paymentRejectReasonCode, selectedJobActionSet]);

  const onBeginDisputeReview = useCallback(async () => {
    if (!selectedJobActionSet.has("BEGIN_DISPUTE_REVIEW")) {
      return;
    }
    await onRunJobAction("BEGIN_DISPUTE_REVIEW", {});
  }, [onRunJobAction, selectedJobActionSet]);

  const onOfferDisputeResolution = useCallback(async () => {
    const action = selectedJobActionSet.has("OFFER_DISPUTE_RESOLUTION")
      ? "OFFER_DISPUTE_RESOLUTION"
      : selectedJobActionSet.has("APPROVE_DISPUTE")
        ? "APPROVE_DISPUTE"
        : null;
    if (!action) {
      return;
    }
    const summary = disputeResolutionSummary.trim();
    if (!summary) {
      setError("Resolution summary is required.");
      return;
    }
    await onRunJobAction(action, {
      resolution: {
        type: disputeResolutionType,
        summary
      },
      dispute: {
        decisionReason: disputeDecisionReason.trim() || "Resolution proposed by dispatch"
      }
    });
  }, [disputeDecisionReason, disputeResolutionSummary, disputeResolutionType, onRunJobAction, selectedJobActionSet]);

  const onRejectDispute = useCallback(async () => {
    if (!selectedJobActionSet.has("REJECT_DISPUTE")) {
      return;
    }
    await onRunJobAction("REJECT_DISPUTE", {
      dispute: {
        decisionReason: disputeDecisionReason.trim() || "Rejected after dispatch review"
      }
    });
  }, [disputeDecisionReason, onRunJobAction, selectedJobActionSet]);

  const onRequestMoreInfo = useCallback(async () => {
    if (!selectedJobActionSet.has("REQUEST_MORE_INFO")) {
      return;
    }
    const message = requestMoreInfoMessage.trim();
    if (!message) {
      setError("Request-more-info message cannot be empty.");
      return;
    }
    await onRunJobAction("REQUEST_MORE_INFO", {
      request: {
        targetRole: requestMoreInfoTargetRole,
        message
      }
    });
  }, [onRunJobAction, requestMoreInfoMessage, requestMoreInfoTargetRole, selectedJobActionSet]);

  const onSendMessage = useCallback(async () => {
    if (!session || !selectedJobId || !messageDraft.trim()) return;
    try {
      await sendMessage(session.accessToken, selectedJobId, messageDraft.trim(), messageAudience, {
        sourceLanguage: appLanguage,
        translateTo: getMessageTranslationTargets(appLanguage)
      });
      setMessageDraft("");
      await loadJobPanels(selectedJobId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send message failed");
    }
  }, [appLanguage, loadJobPanels, messageAudience, messageDraft, selectedJobId, session]);

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
          <h1>{t(appLanguage, "auth.title")}</h1>
          <p>{t(appLanguage, "auth.subtitle")}</p>
          <form onSubmit={onLogin}>
            <label>
              {t(appLanguage, "auth.identifier")}
              <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
            </label>
            <label>
              {t(appLanguage, "auth.password")}
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <button type="submit">{t(appLanguage, "auth.signIn")}</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>{t(appLanguage, "topbar.title")}</h1>
        <div className="topbar-actions">
          <label className="topbar-language">
            {t(appLanguage, "topbar.consoleLanguage")}
            <select
              aria-label="Console language"
              value={appLanguage}
              onChange={(event) => setAppLanguage(event.target.value as AppLanguage)}
            >
              {LANGUAGE_OPTIONS.map((language) => (
                <option key={language} value={language}>
                  {formatLanguageCode(language)}
                </option>
              ))}
            </select>
          </label>
          <small>
            {lastRefreshAt
              ? t(appLanguage, "topbar.lastRefresh", { time: new Date(lastRefreshAt).toLocaleTimeString() })
              : t(appLanguage, "topbar.lastRefreshWaiting")}
          </small>
          <button
            className={showShortcutHelp ? "secondary active" : "secondary"}
            onClick={() => setShowShortcutHelp((value) => !value)}
          >
            {t(appLanguage, "topbar.shortcuts")}
          </button>
          <button onClick={() => void refreshPanelsAfterMutation()} disabled={isRefreshing}>
            {isRefreshing ? t(appLanguage, "topbar.refreshing") : t(appLanguage, "topbar.refresh")}
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}
      {showShortcutHelp && (
        <section className="shortcut-panel" aria-label="Keyboard shortcuts">
          <h2>{t(appLanguage, "shortcuts.title")}</h2>
          <div className="shortcut-grid">
            <p><kbd>j</kbd>/<kbd>k</kbd> {t(appLanguage, "shortcuts.queueMove")}</p>
            <p><kbd>r</kbd> {t(appLanguage, "shortcuts.recompute")}</p>
            <p><kbd>a</kbd> {t(appLanguage, "shortcuts.assign")}</p>
            <p><kbd>o</kbd> {t(appLanguage, "shortcuts.override")}</p>
            <p><kbd>m</kbd> {t(appLanguage, "shortcuts.message")}</p>
            <p><kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> {t(appLanguage, "shortcuts.send")}</p>
            <p><kbd>1-5</kbd> {t(appLanguage, "shortcuts.filters")}</p>
            <p><kbd>?</kbd> {t(appLanguage, "shortcuts.toggle")}</p>
          </div>
        </section>
      )}

      <section className="panel queue-top">
        <div className="queue-top-header">
          <div>
            <h2>{t(appLanguage, "queue.title")}</h2>
            <p className="queue-count">{t(appLanguage, "queue.subtitle")}</p>
          </div>
          <div className="queue-summary-metrics">
            <article>
              <span>{t(appLanguage, "queue.unassigned")}</span>
              <strong>{queueStats.requested}</strong>
            </article>
            <article>
              <span>{t(appLanguage, "queue.assigned")}</span>
              <strong>{queueStats.assigned}</strong>
            </article>
            <article>
              <span>{t(appLanguage, "queue.inProgress")}</span>
              <strong>{queueStats.inProgress}</strong>
            </article>
            <article>
              <span>{t(appLanguage, "queue.urgent")}</span>
              <strong>{queueStats.urgent}</strong>
            </article>
          </div>
        </div>

        <div className="queue-controls inline">
          <label>
            {t(appLanguage, "filter.status")}
            <select aria-label="Status filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
              <option value="ALL">{t(appLanguage, "common.all")}</option>
              {WORKFLOW_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {formatToken(status)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t(appLanguage, "filter.urgency")}
            <select aria-label="Urgency filter" value={urgencyFilter} onChange={(event) => setUrgencyFilter(event.target.value as UrgencyFilter)}>
              <option value="ALL">{t(appLanguage, "common.all")}</option>
              {URGENCY_LEVELS.map((urgency) => (
                <option key={urgency} value={urgency}>
                  {formatToken(urgency)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t(appLanguage, "filter.language")}
            <select aria-label="Language filter" value={languageFilter} onChange={(event) => setLanguageFilter(event.target.value as LanguageFilter)}>
              <option value="ALL">{t(appLanguage, "common.all")}</option>
              <option value="ENG">{t(appLanguage, "common.englishCode")}</option>
              <option value="LAO">{t(appLanguage, "common.laoCode")}</option>
              <option value="NONE">{t(appLanguage, "common.notSet")}</option>
            </select>
          </label>
          <label>
            {t(appLanguage, "filter.skill")}
            <select aria-label="Skill filter" value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)}>
              <option value="ALL">{t(appLanguage, "common.all")}</option>
              {skillOptions.map((skill) => (
                <option key={skill} value={skill}>
                  {formatToken(skill)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t(appLanguage, "filter.personality")}
            <select aria-label="Personality filter" value={personalityFilter} onChange={(event) => setPersonalityFilter(event.target.value)}>
              <option value="ALL">{t(appLanguage, "common.all")}</option>
              {personalityTagOptions.map((tag) => (
                <option key={tag} value={tag}>
                  {formatToken(tag)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t(appLanguage, "filter.sort")}
            <select aria-label="Sort queue" value={queueSort} onChange={(event) => setQueueSort(event.target.value as QueueSort)}>
              <option value="NEWEST">{t(appLanguage, "sort.newest")}</option>
              <option value="OLDEST">{t(appLanguage, "sort.oldest")}</option>
              <option value="URGENCY">{t(appLanguage, "sort.urgency")}</option>
              <option value="STATUS">{t(appLanguage, "sort.status")}</option>
            </select>
          </label>
        </div>

        <ul className="queue-grid">
          {filteredJobs.map((job) => (
            <li key={job.id}>
              <button className={job.id === selectedJobId ? "job active" : "job"} onClick={() => setSelectedJobId(job.id)}>
                <div className="job-head">
                  <strong>{formatJobHeadline(job)}</strong>
                  {isPastDue(job) && <span className="signal-pill critical">{t(appLanguage, "queue.overdue")}</span>}
                </div>
                <div className="job-meta">
                  <span className="badge">{getJobStatusLabel(job)}</span>
                  <span className="badge">{job.urgency}</span>
                  <span className="badge">{normalizeLanguageCode(job.languagePreference) ?? "NO_LANG"}</span>
                  <span className="badge">{t(appLanguage, "queue.skills", { count: String(job.requiredSkills.length) })}</span>
                  {getDispatchUnreadCount(job) > 0 && <span className="badge">{t(appLanguage, "queue.unread", { count: String(getDispatchUnreadCount(job)) })}</span>}
                </div>
                <small>
                  {formatToken(job.jobType)} · {new Date(job.createdAt).toLocaleString()}
                </small>
                <small>
                  {t(appLanguage, "queue.languageLabel")}: {formatLanguageCode(job.languagePreference)} ·
                </small>
                <small>
                  {t(appLanguage, "queue.scheduleLabel")}: {inferSchedulePreference(job)} · {getWindowLabel(job)}
                </small>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="dispatch-workbench-layout">
        <section className="panel assignment-panel">
          <h2>{t(appLanguage, "panel.assignment")}</h2>
          {selectedJob ? (
            <>
              <div className="job-summary compact">
                <p><strong>{t(appLanguage, "assignment.job")}:</strong> {formatJobHeadline(selectedJob)}</p>
                <p><strong>{t(appLanguage, "assignment.customer")}:</strong> {formatCustomerLabel(selectedJob)}</p>
                <p data-testid="selected-job-id"><strong>{t(appLanguage, "assignment.internalRef")}:</strong> {selectedJob.id}</p>
                <p><strong>{t(appLanguage, "assignment.status")}:</strong> {getJobStatusLabel(selectedJob)}</p>
                <p><strong>{t(appLanguage, "assignment.workflow")}:</strong> {selectedJob.workflowState ?? "-"}</p>
                <p><strong>{t(appLanguage, "assignment.urgency")}:</strong> {selectedJob.urgency}</p>
                <p><strong>{t(appLanguage, "assignment.language")}:</strong> {formatLanguageCode(selectedJob.languagePreference)}</p>
                <p>
                  <strong>{t(appLanguage, "assignment.readReceipts")}:</strong>{" "}
                  {t(appLanguage, "assignment.readReceiptsSummary", {
                    messages: String(selectedJob.readReceiptsSummary?.messages?.unreadForDispatch ?? 0),
                    changeOrders: String(selectedJob.readReceiptsSummary?.changeOrders?.unreadForDispatch ?? 0),
                    payment: String(selectedJob.readReceiptsSummary?.paymentRequests?.unreadForDispatch ?? 0)
                  })}
                </p>
                <p>
                  <strong>{t(appLanguage, "assignment.schedulePreference")}:</strong> {inferSchedulePreference(selectedJob)}
                </p>
                <p>
                  <strong>{t(appLanguage, "assignment.window")}:</strong>{" "}
                  {getWindowLabel(selectedJob)}
                </p>
                <p><strong>{t(appLanguage, "assignment.selectedWorker")}:</strong> <span data-testid="selected-worker-id">{selectedWorkerLabel}</span></p>
              </div>

              <div className="actions stacked">
                <button onClick={onRecompute}>{t(appLanguage, "assignment.recompute")}</button>
                <button onClick={onAssign} disabled={!selectedWorkerId}>{t(appLanguage, "assignment.assignSelected")}</button>
                <input
                  ref={overrideReasonInputRef}
                  placeholder={t(appLanguage, "assignment.overrideReason")}
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                />
                <button onClick={onOverride} disabled={!selectedWorkerId || !overrideReason.trim()}>
                  {t(appLanguage, "assignment.overrideSelected")}
                </button>
                      {selectedJobActionSet.has("PRIORITIZE_JOB") && (
                  <div className="workflow-action-inline">
                    <label>
                      {t(appLanguage, "assignment.priorityLevel")}
                      <select value={priorityLevel} onChange={(event) => setPriorityLevel(event.target.value)}>
                        <option value="LOW">{t(appLanguage, "common.low")}</option>
                        <option value="NORMAL">{t(appLanguage, "common.normal")}</option>
                        <option value="HIGH">{t(appLanguage, "common.high")}</option>
                        <option value="CRITICAL">{t(appLanguage, "common.critical")}</option>
                      </select>
                    </label>
                    <button className="secondary" onClick={() => void onPrioritizeJob()}>
                      {t(appLanguage, "assignment.prioritizeJob")}
                    </button>
                  </div>
                )}
                {selectedJobActionSet.has("EDIT_REQUEST_FIELDS_WITH_AUDIT") && (
                  <div className="workflow-action-inline">
                    <label>
                      {t(appLanguage, "assignment.requestDescription")}
                      <input
                        value={requestPatchDescription}
                        onChange={(event) => setRequestPatchDescription(event.target.value)}
                      />
                    </label>
                    <label>
                      {t(appLanguage, "assignment.requestUrgency")}
                      <select value={requestPatchUrgency} onChange={(event) => setRequestPatchUrgency(event.target.value)}>
                        <option value="LOW">{t(appLanguage, "common.low")}</option>
                        <option value="MEDIUM">{t(appLanguage, "common.medium")}</option>
                        <option value="HIGH">{t(appLanguage, "common.high")}</option>
                        <option value="CRITICAL">{t(appLanguage, "common.critical")}</option>
                      </select>
                    </label>
                    <label>
                      {t(appLanguage, "assignment.requestLanguage")}
                      <select
                        value={requestPatchLanguage}
                        onChange={(event) => setRequestPatchLanguage(event.target.value as RequestPatchLanguage)}
                      >
                        <option value="UNCHANGED">{t(appLanguage, "common.noChange")}</option>
                        {LANGUAGE_OPTIONS.map((language) => (
                          <option key={language} value={language}>
                            {formatLanguageCode(language)}
                          </option>
                        ))}
                        <option value="NONE">{t(appLanguage, "common.clearLanguage")}</option>
                      </select>
                    </label>
                    <button className="secondary" onClick={() => void onEditRequestWithAudit()}>
                      {t(appLanguage, "assignment.applyRequestEdit")}
                    </button>
                  </div>
                )}
                {selectedJobActionSet.has("RESCHEDULE") && (
                  <div className="workflow-action-inline">
                    <label>
                      {t(appLanguage, "assignment.start")}
                      <input
                        type="datetime-local"
                        value={rescheduleStartLocal}
                        onChange={(event) => setRescheduleStartLocal(event.target.value)}
                      />
                    </label>
                    <label>
                      {t(appLanguage, "assignment.end")}
                      <input
                        type="datetime-local"
                        value={rescheduleEndLocal}
                        onChange={(event) => setRescheduleEndLocal(event.target.value)}
                      />
                    </label>
                    <button className="secondary" onClick={() => void onRescheduleJob()}>
                      {t(appLanguage, "assignment.applyReschedule")}
                    </button>
                  </div>
                )}
                {dispatchActionButtons.length > 0 && (
                  <div className="workflow-action-stack">
                    <small>{t(appLanguage, "assignment.workflowActions")}</small>
                    <div className="workflow-action-grid">
                      {dispatchActionButtons.map(({ action, payload }) => (
                        <button
                          key={action}
                          className="secondary"
                          onClick={() => payload && void onRunJobAction(action, payload)}
                          disabled={!payload}
                          title={!payload ? t(appLanguage, "assignment.selectCandidateFirst") : undefined}
                        >
                          {formatToken(action)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <h3>{t(appLanguage, "assignment.candidates")}</h3>
              <table>
                <thead>
                  <tr>
                    <th>{t(appLanguage, "candidate.rank")}</th>
                    <th>{t(appLanguage, "candidate.worker")}</th>
                    <th>{t(appLanguage, "candidate.score")}</th>
                    <th>{t(appLanguage, "candidate.action")}</th>
                    <th>{t(appLanguage, "candidate.breakdown")}</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((candidate) => (
                    <tr key={candidate.workerId} className={selectedWorkerId === candidate.workerId ? "candidate-selected" : ""}>
                      <td>{candidate.rank}</td>
                      <td>
                        <div>{formatWorkerLabel(candidate)}</div>
                        <small>Score rank #{candidate.rank}</small>
                      </td>
                      <td>{candidate.score.toFixed(2)}</td>
                      <td>
                        <button
                          className={selectedWorkerId === candidate.workerId ? "secondary active" : "secondary"}
                          onClick={() => setSelectedWorkerId(candidate.workerId)}
                        >
                          {selectedWorkerId === candidate.workerId ? t(appLanguage, "candidate.selected") : t(appLanguage, "candidate.select")}
                        </button>
                      </td>
                      <td>
                        <div className="breakdown-stack">
                          <p className="candidate-final-score">
                            {t(appLanguage, "candidate.final")}: {getCandidateFinalScore(candidate.scoreBreakdown, candidate.score).toFixed(2)}
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
            <p>{t(appLanguage, "assignment.selectJob")}</p>
          )}
        </section>

        <section className="panel context-panel">
          <div className="context-nav" role="tablist" aria-label="Job context tabs">
            <button className={focusPanel === "SIGNALS" ? "chip active" : "chip"} onClick={() => setFocusPanel("SIGNALS")}>{t(appLanguage, "panel.signals")}</button>
            <button className={focusPanel === "DETAILS" ? "chip active" : "chip"} onClick={() => setFocusPanel("DETAILS")}>{t(appLanguage, "panel.details")}</button>
            <button className={focusPanel === "PAYMENTS_DISPUTES" ? "chip active" : "chip"} onClick={() => setFocusPanel("PAYMENTS_DISPUTES")}>{t(appLanguage, "panel.paymentsDisputes")}</button>
            <button className={focusPanel === "MESSAGES" ? "chip active" : "chip"} onClick={() => setFocusPanel("MESSAGES")}>{t(appLanguage, "panel.messages")}</button>
            <button className={focusPanel === "TIMELINE" ? "chip active" : "chip"} onClick={() => setFocusPanel("TIMELINE")}>{t(appLanguage, "panel.timeline")}</button>
          </div>

          {focusPanel === "SIGNALS" && (
            <div className="signal-list">
              <h2>{t(appLanguage, "panel.signals")}</h2>
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
              <h2>{t(appLanguage, "context.jobDetail")}</h2>
              {selectedJob ? (
                <>
                  <p><strong>{t(appLanguage, "context.headline")}:</strong> {formatJobHeadline(selectedJob)}</p>
                  <p><strong>{t(appLanguage, "assignment.customer")}:</strong> {formatCustomerLabel(selectedJob)}</p>
                  <p><strong>{t(appLanguage, "assignment.internalRef")}:</strong> {selectedJob.id.slice(0, 8)}</p>
                  <p><strong>{t(appLanguage, "assignment.status")}:</strong> {getJobStatusLabel(selectedJob)}</p>
                  <p><strong>{t(appLanguage, "assignment.workflow")}:</strong> {selectedJob.workflowState ?? "-"}</p>
                  <p><strong>{t(appLanguage, "assignment.urgency")}:</strong> {selectedJob.urgency}</p>
                  <p><strong>{t(appLanguage, "assignment.language")}:</strong> {formatLanguageCode(selectedJob.languagePreference)}</p>
                  <p><strong>{t(appLanguage, "context.skills")}:</strong> {selectedJob.requiredSkills.join(", ") || t(appLanguage, "common.none")}</p>
                  <p><strong>{t(appLanguage, "context.personality")}:</strong> {selectedJob.personalityPreferences.join(", ") || t(appLanguage, "common.none")}</p>
                  <p>
                    <strong>{t(appLanguage, "context.assignedWorker")}:</strong>{" "}
                    {selectedJob.assignedWorkerDisplayName ?? selectedJob.assignedWorkerId ?? t(appLanguage, "common.notAssigned")}
                  </p>
                  <div className="read-receipt-summary">
                    <p>
                      <strong>{t(appLanguage, "context.dispatchReadReceipts")}:</strong>{" "}
                      {t(appLanguage, "context.unreadTotal", { count: String(getDispatchUnreadCount(selectedJob)) })}
                    </p>
                    <p>
                      {t(appLanguage, "context.messagesUnread")}: {selectedJob.readReceiptsSummary?.messages?.unreadForDispatch ?? 0} · {t(appLanguage, "context.lastRead")}{" "}
                      {formatOptionalTimestamp(selectedJob.readReceiptsSummary?.messages?.lastReadAt)}
                    </p>
                    <p>
                      {t(appLanguage, "context.changeOrdersUnread")}: {selectedJob.readReceiptsSummary?.changeOrders?.unreadForDispatch ?? 0} · {t(appLanguage, "context.lastRead")}{" "}
                      {formatOptionalTimestamp(selectedJob.readReceiptsSummary?.changeOrders?.lastReadAt)}
                    </p>
                    <p>
                      {t(appLanguage, "context.paymentUnread")}: {selectedJob.readReceiptsSummary?.paymentRequests?.unreadForDispatch ?? 0} · {t(appLanguage, "context.lastRead")}{" "}
                      {formatOptionalTimestamp(selectedJob.readReceiptsSummary?.paymentRequests?.lastReadAt)}
                    </p>
                  </div>
                  <p>
                    <strong>{t(appLanguage, "assignment.schedulePreference")}:</strong> {inferSchedulePreference(selectedJob)}
                  </p>
                  <p>
                    <strong>{t(appLanguage, "assignment.window")}:</strong>{" "}
                    {getWindowLabel(selectedJob)}
                  </p>
                </>
              ) : (
                <p>{t(appLanguage, "assignment.selectJob")}</p>
              )}
            </div>
          )}

          {focusPanel === "PAYMENTS_DISPUTES" && (
            <div className="job-summary expanded">
              <h2>{t(appLanguage, "payments.title")}</h2>
              {selectedJob ? (
                <>
                  <p><strong>{t(appLanguage, "assignment.job")}:</strong> {formatJobHeadline(selectedJob)}</p>
                  <p><strong>{t(appLanguage, "assignment.status")}:</strong> {getJobStatusLabel(selectedJob)} ({selectedJob.workflowState ?? "-"})</p>

                  <h3>{t(appLanguage, "payments.latestChangeOrder")}</h3>
                  {latestChangeOrderAction && latestChangeOrderPayload ? (
                    <div className="payload-facts">
                      <span className="payload-fact"><strong>{t(appLanguage, "payments.action")}:</strong> {formatToken(latestChangeOrderAction.action)}</span>
                      <span className="payload-fact"><strong>{t(appLanguage, "payments.at")}:</strong> {new Date(latestChangeOrderAction.event.createdAt).toLocaleString()}</span>
                      {Object.entries(latestChangeOrderPayload).map(([key, value]) => (
                        <span key={`change-order-${key}`} className="payload-fact">
                          <strong>{toFactLabel(key)}:</strong> {formatScalar(value)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p>{t(appLanguage, "payments.noChangeOrder")}</p>
                  )}

                  <h3>{t(appLanguage, "payments.latestCompletionEvidence")}</h3>
                  {latestWorkSubmissionAction && latestCompletionEvidence ? (
                    <div className="payload-facts">
                      <span className="payload-fact"><strong>{t(appLanguage, "payments.submitted")}:</strong> {new Date(latestWorkSubmissionAction.event.createdAt).toLocaleString()}</span>
                      {Object.entries(latestCompletionEvidence).map(([key, value]) => (
                        <span key={`completion-${key}`} className="payload-fact">
                          <strong>{toFactLabel(key)}:</strong> {formatScalar(value)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p>{t(appLanguage, "payments.noCompletionEvidence")}</p>
                  )}

                  <h3>{t(appLanguage, "payments.latestPaymentProof")}</h3>
                  {latestPaymentProofAction && latestPaymentProof ? (
                    <div className="payload-facts">
                      <span className="payload-fact"><strong>{t(appLanguage, "payments.submitted")}:</strong> {new Date(latestPaymentProofAction.event.createdAt).toLocaleString()}</span>
                      {Object.entries(latestPaymentProof).map(([key, value]) => (
                        <span key={`payment-${key}`} className="payload-fact">
                          <strong>{toFactLabel(key)}:</strong> {formatScalar(value)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p>{t(appLanguage, "payments.noPaymentProof")}</p>
                  )}

                  {(selectedJobActionSet.has("CONFIRM_PAYMENT") || selectedJobActionSet.has("REJECT_PAYMENT_PROOF")) && (
                    <div className="workflow-action-inline">
                      {selectedJobActionSet.has("CONFIRM_PAYMENT") && (
                        <>
                          <label>
                            {t(appLanguage, "payments.confirmAmount")}
                            <input
                              type="number"
                              min={0}
                              value={paymentConfirmAmount}
                              onChange={(event) => setPaymentConfirmAmount(event.target.value)}
                            />
                          </label>
                          <button className="secondary" onClick={() => void onConfirmPayment()}>
                            {t(appLanguage, "payments.confirmPayment")}
                          </button>
                        </>
                      )}
                      {selectedJobActionSet.has("REJECT_PAYMENT_PROOF") && (
                        <>
                          <label>
                            {t(appLanguage, "payments.rejectReason")}
                            <select value={paymentRejectReasonCode} onChange={(event) => setPaymentRejectReasonCode(event.target.value)}>
                              <option value="amount_mismatch">{t(appLanguage, "payments.rejectReasonAmountMismatch")}</option>
                              <option value="unreadable">{t(appLanguage, "payments.rejectReasonUnreadable")}</option>
                              <option value="wrong_recipient">{t(appLanguage, "payments.rejectReasonWrongRecipient")}</option>
                              <option value="duplicate">{t(appLanguage, "payments.rejectReasonDuplicate")}</option>
                              <option value="suspected_fraud">{t(appLanguage, "payments.rejectReasonFraud")}</option>
                              <option value="other">{t(appLanguage, "payments.rejectReasonOther")}</option>
                            </select>
                          </label>
                          <button className="secondary" onClick={() => void onRejectPaymentProof()}>
                            Reject Payment Proof
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  <h3>{t(appLanguage, "payments.latestDispute")}</h3>
                  {latestDisputeAction && latestDisputePayload ? (
                    <div className="payload-facts">
                      <span className="payload-fact"><strong>{t(appLanguage, "payments.action")}:</strong> {formatToken(latestDisputeAction.action)}</span>
                      <span className="payload-fact"><strong>{t(appLanguage, "payments.at")}:</strong> {new Date(latestDisputeAction.event.createdAt).toLocaleString()}</span>
                      {Object.entries(latestDisputePayload).map(([key, value]) => (
                        <span key={`dispute-${key}`} className="payload-fact">
                          <strong>{toFactLabel(key)}:</strong> {formatScalar(value)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p>{t(appLanguage, "payments.noDispute")}</p>
                  )}
                  {latestResolutionOfferPayload && (
                    <div className="payload-facts">
                      <span className="payload-fact">
                        <strong>{t(appLanguage, "payments.resolutionType")}:</strong> {formatScalar(latestResolutionOfferPayload.type)}
                      </span>
                      <span className="payload-fact">
                        <strong>{t(appLanguage, "payments.resolutionSummary")}:</strong> {formatScalar(latestResolutionOfferPayload.summary)}
                      </span>
                    </div>
                  )}

                  {(selectedJobActionSet.has("BEGIN_DISPUTE_REVIEW") ||
                    selectedJobActionSet.has("REQUEST_MORE_INFO") ||
                    selectedJobActionSet.has("OFFER_DISPUTE_RESOLUTION") ||
                    selectedJobActionSet.has("APPROVE_DISPUTE") ||
                    selectedJobActionSet.has("REJECT_DISPUTE")) && (
                    <div className="workflow-action-stack">
                      <small>{t(appLanguage, "payments.disputeActions")}</small>
                      {selectedJobActionSet.has("BEGIN_DISPUTE_REVIEW") && (
                        <button className="secondary" onClick={() => void onBeginDisputeReview()}>
                          {t(appLanguage, "payments.beginReview")}
                        </button>
                      )}
                      {selectedJobActionSet.has("REQUEST_MORE_INFO") && (
                        <div className="workflow-action-inline">
                          <label>
                            {t(appLanguage, "payments.target")}
                            <select value={requestMoreInfoTargetRole} onChange={(event) => setRequestMoreInfoTargetRole(event.target.value)}>
                              <option value="client">{t(appLanguage, "payments.targetClient")}</option>
                              <option value="worker">{t(appLanguage, "payments.targetWorker")}</option>
                            </select>
                          </label>
                          <label>
                            {t(appLanguage, "payments.message")}
                            <input
                              value={requestMoreInfoMessage}
                              onChange={(event) => setRequestMoreInfoMessage(event.target.value)}
                            />
                          </label>
                          <button className="secondary" onClick={() => void onRequestMoreInfo()}>
                            {t(appLanguage, "payments.requestMoreInfo")}
                          </button>
                        </div>
                      )}
                      {(selectedJobActionSet.has("OFFER_DISPUTE_RESOLUTION") || selectedJobActionSet.has("APPROVE_DISPUTE")) && (
                        <div className="workflow-action-inline">
                          <label>
                            {t(appLanguage, "payments.resolutionType")}
                            <select
                              value={disputeResolutionType}
                              onChange={(event) => setDisputeResolutionType(event.target.value)}
                            >
                              <option value="partial_refund">{t(appLanguage, "payments.resolutionPartialRefund")}</option>
                              <option value="full_refund">{t(appLanguage, "payments.resolutionFullRefund")}</option>
                              <option value="remediation">{t(appLanguage, "payments.resolutionRemediation")}</option>
                              <option value="credit">{t(appLanguage, "payments.resolutionCredit")}</option>
                              <option value="other">{t(appLanguage, "payments.rejectReasonOther")}</option>
                            </select>
                          </label>
                          <label>
                            {t(appLanguage, "payments.resolutionSummary")}
                            <input
                              value={disputeResolutionSummary}
                              onChange={(event) => setDisputeResolutionSummary(event.target.value)}
                            />
                          </label>
                          <button className="secondary" onClick={() => void onOfferDisputeResolution()}>
                            {t(appLanguage, "payments.offerResolution")}
                          </button>
                        </div>
                      )}
                      {selectedJobActionSet.has("REJECT_DISPUTE") && (
                        <div className="workflow-action-inline">
                          <label>
                            {t(appLanguage, "payments.decisionReason")}
                            <input value={disputeDecisionReason} onChange={(event) => setDisputeDecisionReason(event.target.value)} />
                          </label>
                          <button className="secondary" onClick={() => void onRejectDispute()}>
                            {t(appLanguage, "payments.rejectDispute")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <h3>{t(appLanguage, "panel.readReceipts")}</h3>
                  {readReceipts.length > 0 ? (
                    <ul className="route-list">
                      {readReceipts.slice(0, 25).map((item) => (
                        <li key={item.id}>
                          <strong>{formatToken(item.subjectType)}</strong> · {item.subjectId.slice(0, 8)} ·{" "}
                          {item.readerRole} · {new Date(item.readAt).toLocaleString()}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{t(appLanguage, "payments.noReadReceipts")}</p>
                  )}

                  {latestRequestInfoPayload && (
                    <p>
                      <strong>{t(appLanguage, "payments.latestInfoRequest")}:</strong> {formatScalar(latestRequestInfoPayload.message)} (
                      {formatScalar(latestRequestInfoPayload.targetRole)})
                    </p>
                  )}
                </>
              ) : (
                <p>{t(appLanguage, "payments.selectJob")}</p>
              )}
            </div>
          )}

          {focusPanel === "MESSAGES" && (
            <div>
              <h2>{t(appLanguage, "panel.messages")} {selectedJob ? `· ${formatJobHeadline(selectedJob)}` : ""}</h2>
              <div className="compose with-audience">
                <label htmlFor="translation-display">{t(appLanguage, "messages.displayMode")}</label>
                <select
                  id="translation-display"
                  aria-label="Translation display mode"
                  value={messageTranslationDisplay}
                  onChange={(event) => setMessageTranslationDisplay(event.target.value as TranslationDisplay)}
                >
                  <option value="ORIGINAL">{t(appLanguage, "messages.originalOption")}</option>
                  <option value="TRANSLATED">{t(appLanguage, "messages.translatedOption")}</option>
                  <option value="BOTH">{t(appLanguage, "messages.bothOption")}</option>
                </select>
              </div>
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
                            {thread.items.map((message) => {
                              const translationLabel = getMessageTranslationLabel(message, appLanguage);
                              const bodyOriginal = message.bodyOriginal ?? message.body;
                              const bodyTranslated = message.bodyTranslated ?? null;
                              const bodyDisplay = message.bodyDisplay ?? message.body;
                              const shouldShowBoth =
                                messageTranslationDisplay === "BOTH" &&
                                bodyTranslated &&
                                bodyTranslated.trim().length > 0 &&
                                bodyTranslated.trim() !== bodyOriginal.trim();
                              return (
                                <p key={message.id}>
                                  {bodyDisplay}
                                  {shouldShowBoth ? (
                                    <>
                                      <br />
                                      <small>{t(appLanguage, "messages.originalLabel")}: {bodyOriginal}</small>
                                    </>
                                  ) : null}
                                  {translationLabel ? (
                                    <>
                                      <br />
                                      <small>{translationLabel}</small>
                                    </>
                                  ) : null}
                                </p>
                              );
                            })}
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
                  {(["BOTH", "WORKER", "CLIENT"] as MessageAudience[]).map((option) => (
                    <option key={option} value={option}>
                      {t(appLanguage, audienceLabelKey[option])}
                    </option>
                  ))}
                </select>
                <input
                  ref={messageInputRef}
                  value={messageDraft}
                  onChange={(event) => setMessageDraft(event.target.value)}
                  onKeyDown={onMessageInputKeyDown}
                  placeholder={t(appLanguage, "messages.placeholder")}
                  disabled={!selectedJobId}
                />
                <button onClick={onSendMessage} disabled={!selectedJobId || !messageDraft.trim()}>
                  {t(appLanguage, "messages.send")}
                </button>
              </div>
            </div>
          )}

          {focusPanel === "TIMELINE" && (
            <>
              <h2>{t(appLanguage, "panel.timeline")}</h2>
              <div className="timeline-chips" role="group" aria-label="Timeline filters">
                {TIMELINE_FILTERS.map((filter) => (
                  <button key={filter} className={timelineFilter === filter ? "chip active" : "chip"} onClick={() => setTimelineFilter(filter)}>
                    {t(appLanguage, timelineFilterLabelKey[filter])} ({timelineCounts[filter]})
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
                        <span className="timeline-tag">{t(appLanguage, timelineFilterLabelKey[eventCategory])}</span>
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
                            {t(appLanguage, "timeline.selectWorker", { worker: workerLabel })}
                          </button>
                        )}
                        {reason && (
                          <button className="chip secondary" onClick={() => onUseTimelineReason(reason)}>
                            {t(appLanguage, "timeline.useReason")}
                          </button>
                        )}
                        <button className="chip secondary" onClick={() => onQuoteTimelineEvent(event)}>
                          {t(appLanguage, "timeline.quote")}
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
          <h2>{t(appLanguage, "ops.title")}</h2>
          <div className="ops-tab-switch">
            <button className={opsTab === "ROUTING" ? "chip active" : "chip"} onClick={() => setOpsTab("ROUTING")}>{t(appLanguage, "ops.routing")}</button>
            <button className={opsTab === "SCHEDULING" ? "chip active" : "chip"} onClick={() => setOpsTab("SCHEDULING")}>{t(appLanguage, "ops.scheduling")}</button>
          </div>
        </div>

        {opsTab === "ROUTING" && (
          <div className="ops-content routing-view">
            <div className="routing-toolbar">
              <div className="map-scope-selector" role="group" aria-label="Map time scope">
                {MAP_SCOPES.map((scopeOption) => (
                  <button
                    key={scopeOption}
                    className={mapScope === scopeOption ? "chip active" : "chip"}
                    onClick={() => setMapScope(scopeOption)}
                    title={t(appLanguage, mapScopeHintKey[scopeOption])}
                  >
                    {t(appLanguage, mapScopeLabelKey[scopeOption])}
                  </button>
                ))}
              </div>
              <p className="queue-count">
                {mapOverview
                  ? t(appLanguage, "ops.mapSummary", {
                      jobs: String(mapOverview.jobs.length),
                      workers: String(mapOverview.workers.length),
                      scope: formatToken(mapOverview.scope ?? mapScope)
                    })
                  : t(appLanguage, "map.loading")}
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
                              {t(appLanguage, "ops.openJob")}
                            </button>
                          )}
                        </div>
                      </LeafletPopup>
                    </LeafletCircleMarker>
                  ))}
                </LeafletMapContainer>
              ) : (
                <div className="map-empty-state">{t(appLanguage, "map.empty")}</div>
              )}
            </div>

            <h3>{t(appLanguage, "ops.optimalPaths")}</h3>
            <ul className="route-list">
              {(mapOverview?.routeSuggestions ?? []).slice(0, 10).map((route) => (
                <li key={`${route.workerId}-${route.toJobId}`}>
                  <strong>{route.workerDisplayName}</strong> →{" "}
                  <button className="linkish" onClick={() => setSelectedJobId(route.toJobId)}>
                    {route.toJobDescription}
                  </button>
                  <small>{t(appLanguage, "ops.routeDistanceEta", { km: route.distanceKm.toFixed(1), minutes: String(route.estimatedDriveMinutes) })}</small>
                </li>
              ))}
              {mapOverview && mapOverview.routeSuggestions.length === 0 && (
                <li><small>{t(appLanguage, "ops.noRouteSuggestions")}</small></li>
              )}
            </ul>
          </div>
        )}

        {opsTab === "SCHEDULING" && (
          <div className="ops-content">
            <h3>{t(appLanguage, "ops.scheduling")}</h3>
            {calendar ? (
              <p className="queue-count">
                {new Date(calendar.range.from).toLocaleDateString()} - {new Date(calendar.range.to).toLocaleDateString()}
              </p>
            ) : (
              <p className="queue-count">{t(appLanguage, "ops.loadingSchedule")}</p>
            )}
            <div className="schedule-workers">
              {(calendar?.workers ?? []).map((worker) => (
                <article key={worker.workerId} className="schedule-worker-card">
                  <header>
                    <strong>{worker.workerDisplayName}</strong>
                    <span>{formatToken(worker.tier)}</span>
                  </header>
                  <p>
                    <strong>{t(appLanguage, "ops.availability")}:</strong>{" "}
                    {worker.availability.length > 0
                      ? worker.availability
                          .map((slot) => `${weekdayLabel(slot.dayOfWeek)} ${slot.startTime}-${slot.endTime}`)
                          .join(", ")
                      : t(appLanguage, "common.notSet")}
                  </p>
                  <p>
                    <strong>{t(appLanguage, "ops.timeOff")}:</strong>{" "}
                    {worker.timeOff.length > 0
                      ? worker.timeOff
                          .map((timeOff) => `${new Date(timeOff.startAt).toLocaleDateString()}-${new Date(timeOff.endAt).toLocaleDateString()}`)
                          .join(", ")
                      : t(appLanguage, "common.none")}
                  </p>
                  <p><strong>{t(appLanguage, "ops.scheduledJobs")}:</strong> {worker.scheduledJobs.length}</p>
                  <ul>
                    {worker.scheduledJobs.slice(0, 3).map((job) => (
                      <li key={job.id}>
                        <button className="linkish" onClick={() => setSelectedJobId(job.id)}>
                          {removeSchedulingMetaFromDescription(job.description) || job.description}
                        </button>{" "}
                        <small>{job.scheduleWindowStart ? new Date(job.scheduleWindowStart).toLocaleString() : t(appLanguage, "common.noWindow")}</small>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>

            <h3>{t(appLanguage, "ops.unassignedJobs")}</h3>
            <ul className="route-list">
              {(calendar?.unassignedJobs ?? []).slice(0, 10).map((job) => (
                <li key={job.id}>
                  <button className="linkish" onClick={() => setSelectedJobId(job.id)}>
                    {removeSchedulingMetaFromDescription(job.description) || job.description}
                  </button>
                  <small> · {job.status} · {job.urgency}</small>
                </li>
              ))}
              {calendar && calendar.unassignedJobs.length === 0 && (
                <li><small>{t(appLanguage, "ops.noUnassignedInRange")}</small></li>
              )}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
