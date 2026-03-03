import { FormEvent, useEffect, useMemo, useState } from "react";
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

function App() {
  const [identifier, setIdentifier] = useState("dispatch@laoworks.local");
  const [password, setPassword] = useState("password123");
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [assignWorkerId, setAssignWorkerId] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [messageDraft, setMessageDraft] = useState("");

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId]
  );

  const loadQueue = async () => {
    if (!session) return;
    const queue = await getQueue(session.accessToken);
    setJobs(queue.items ?? []);
    if (!selectedJobId && queue.items.length) {
      setSelectedJobId(queue.items[0].id);
    }
  };

  const loadJobPanels = async () => {
    if (!session || !selectedJobId) return;
    const [candidatePayload, timelinePayload, messagePayload] = await Promise.all([
      getCandidates(session.accessToken, selectedJobId),
      getTimeline(session.accessToken, selectedJobId),
      getMessages(session.accessToken, selectedJobId)
    ]);
    setCandidates(candidatePayload.candidates ?? []);
    setTimeline(timelinePayload.items ?? []);
    setMessages((messagePayload.items ?? []).slice().reverse());
  };

  useEffect(() => {
    void loadQueue();
  }, [session]);

  useEffect(() => {
    void loadJobPanels();
  }, [session, selectedJobId]);

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

  const onRecompute = async () => {
    if (!session || !selectedJobId) return;
    try {
      const payload = await recomputeCandidates(session.accessToken, selectedJobId, 10);
      setCandidates(payload.candidates ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recompute failed");
    }
  };

  const onAssign = async () => {
    if (!session || !selectedJobId || !assignWorkerId) return;
    try {
      await assignWorker(session.accessToken, selectedJobId, assignWorkerId);
      setAssignWorkerId("");
      await Promise.all([loadQueue(), loadJobPanels()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assign failed");
    }
  };

  const onOverride = async () => {
    if (!session || !selectedJobId || !assignWorkerId || !overrideReason) return;
    try {
      await overrideWorker(session.accessToken, selectedJobId, assignWorkerId, overrideReason);
      setAssignWorkerId("");
      setOverrideReason("");
      await Promise.all([loadQueue(), loadJobPanels()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Override failed");
    }
  };

  const onSendMessage = async () => {
    if (!session || !selectedJobId || !messageDraft.trim()) return;
    try {
      await sendMessage(session.accessToken, selectedJobId, messageDraft.trim());
      setMessageDraft("");
      await loadJobPanels();
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
        <button onClick={() => void loadQueue()}>Refresh Queue</button>
      </header>

      {error && <p className="error">{error}</p>}

      <section className="grid-layout">
        <aside className="panel queue">
          <h2>Job Queue</h2>
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  className={job.id === selectedJobId ? "job active" : "job"}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <strong>{job.jobType}</strong>
                  <span>{job.status}</span>
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

              <div className="actions">
                <button onClick={onRecompute}>Recompute Candidates</button>
                <input
                  placeholder="Worker ID"
                  value={assignWorkerId}
                  onChange={(event) => setAssignWorkerId(event.target.value)}
                />
                <button onClick={onAssign}>Assign</button>
                <input
                  placeholder="Override reason"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                />
                <button onClick={onOverride}>Override</button>
              </div>

              <h3>Candidates</h3>
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Worker</th>
                    <th>Score</th>
                    <th>Breakdown</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((candidate) => (
                    <tr key={candidate.workerId}>
                      <td>{candidate.rank}</td>
                      <td>{candidate.workerId}</td>
                      <td>{candidate.score.toFixed(2)}</td>
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

          <h2>Messaging</h2>
          <div className="messages">
            {messages.map((message) => (
              <article key={message.id}>
                <header>{message.senderUserId}</header>
                <p>{message.body}</p>
              </article>
            ))}
          </div>
          <div className="compose">
            <input
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
              placeholder="Send a message to job thread"
            />
            <button onClick={onSendMessage}>Send</button>
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
