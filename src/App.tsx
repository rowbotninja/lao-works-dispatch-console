import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  assignWorker,
  getCandidates,
  getMessages,
  getQueue,
  getTimeline,
  login,
  recomputeCandidates,
  sendMessage,
  overrideWorker
} from "./api";
import { Candidate, Job, Message, TimelineEvent } from "./types";

type Session = {
  accessToken: string;
  refreshToken: string;
};

const JOB_STATUSES = ["REQUESTED", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
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

const STATUS_SORT_PRIORITY: Record<string, number> = {
  REQUESTED: 0,
  ASSIGNED: 1,
  IN_PROGRESS: 2,
  COMPLETED: 3,
  CANCELLED: 4
};

const URGENCY_SORT_PRIORITY: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3
};

const normalizeToken = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, "_");

const formatToken = (value: string): string =>
  value
    .split("_")
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");

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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId]
  );

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
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadJobPanels, loadQueue, selectedJobId, session]);

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
    await Promise.all([loadQueue(), loadJobPanels(selectedJobId)]);
  };

  const onRecompute = async () => {
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
  };

  const onAssign = async () => {
    if (!session || !selectedJobId || !selectedWorkerId) return;
    try {
      await assignWorker(session.accessToken, selectedJobId, selectedWorkerId);
      await refreshPanelsAfterMutation();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assign failed");
    }
  };

  const onOverride = async () => {
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
  };

  const onSendMessage = async () => {
    if (!session || !selectedJobId || !messageDraft.trim()) return;
    try {
      await sendMessage(session.accessToken, selectedJobId, messageDraft.trim());
      setMessageDraft("");
      await loadJobPanels(selectedJobId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send message failed");
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
          <button onClick={() => void refreshPanelsAfterMutation()} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh Queue"}
          </button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

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
                  <strong>{job.jobType}</strong>
                  <span>{job.id}</span>
                  <span>
                    {job.status} · {job.urgency}
                  </span>
                  <small>{job.description}</small>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="panel detail">
          <h2>Job Detail</h2>
          {selectedJob ? (
            <>
              <p><strong>ID:</strong> {selectedJob.id}</p>
              <p><strong>Status:</strong> {selectedJob.status}</p>
              <p><strong>Urgency:</strong> {selectedJob.urgency}</p>
              <p><strong>Description:</strong> {selectedJob.description}</p>
              <p><strong>Skills:</strong> {selectedJob.requiredSkills.join(", ") || "None"}</p>
              <p>
                <strong>Selected Worker:</strong> {selectedWorkerId ?? "Select from candidates"}
              </p>

              <div className="actions">
                <button onClick={onRecompute}>Recompute Candidates</button>
                <button onClick={onAssign} disabled={!selectedWorkerId}>
                  Assign Selected Candidate
                </button>
                <input
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
                      <td>{candidate.workerId}</td>
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
                        <pre>{JSON.stringify(candidate.scoreBreakdown, null, 2)}</pre>
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
          <ul>
            {timeline.map((event) => (
              <li key={event.id}>
                <strong>{event.eventType}</strong>
                <span>{new Date(event.createdAt).toLocaleString()}</span>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </li>
            ))}
          </ul>

          <h2>Messaging {selectedJobId ? `· ${selectedJobId}` : ""}</h2>
          <div className="messages">
            {messages.map((message) => (
              <article key={message.id}>
                <header>
                  {message.senderUserId} · {new Date(message.createdAt).toLocaleString()}
                </header>
                <p>{message.body}</p>
              </article>
            ))}
          </div>
          <div className="compose">
            <input
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
              placeholder="Send a message to job thread"
              disabled={!selectedJobId}
            />
            <button onClick={onSendMessage} disabled={!selectedJobId || !messageDraft.trim()}>
              Send Message
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
