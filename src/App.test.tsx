import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import { Candidate, Job, Message, TimelineEvent } from "./types";

vi.mock("./api", () => ({
  login: vi.fn(),
  getQueue: vi.fn(),
  getCandidates: vi.fn(),
  getTimeline: vi.fn(),
  getMessages: vi.fn(),
  recomputeCandidates: vi.fn(),
  assignWorker: vi.fn(),
  overrideWorker: vi.fn(),
  sendMessage: vi.fn()
}));

const mockedApi = vi.mocked(api);

const jobsFixture: Job[] = [
  {
    id: "job-1",
    clientId: "client-1",
    status: "REQUESTED",
    jobType: "Generator Repair",
    description: "Repair backup generator unit",
    urgency: "HIGH",
    requiredSkills: ["ELECTRICAL"],
    personalityPreferences: ["DETAIL_ORIENTED"],
    scheduleWindowStart: null,
    scheduleWindowEnd: null,
    createdAt: "2026-03-04T10:00:00.000Z"
  },
  {
    id: "job-2",
    clientId: "client-2",
    status: "ASSIGNED",
    jobType: "HVAC Inspection",
    description: "Inspect AC airflow and controls",
    urgency: "NORMAL",
    requiredSkills: ["HVAC"],
    personalityPreferences: ["QUIET_FOCUSED"],
    scheduleWindowStart: null,
    scheduleWindowEnd: null,
    createdAt: "2026-03-04T09:00:00.000Z"
  }
];

const timelineFixture: TimelineEvent[] = [
  {
    id: "t-1",
    eventType: "JOB_CREATED",
    actorUserId: "client-1",
    payload: {},
    createdAt: "2026-03-04T10:10:00.000Z"
  }
];

const baseMessagesFixture: Message[] = [
  {
    id: "m-1",
    threadId: "thread-1",
    senderUserId: "client-1",
    body: "Please prioritize this.",
    attachmentObjectKey: null,
    createdAt: "2026-03-04T10:12:00.000Z"
  }
];

const candidatesByJobId: Record<string, Candidate[]> = {
  "job-1": [
    {
      workerId: "worker-1",
      rank: 1,
      score: 94.3,
      scoreBreakdown: { skill: 0.4, distance: 0.2, availability: 0.4 }
    }
  ],
  "job-2": [
    {
      workerId: "worker-2",
      rank: 1,
      score: 91.5,
      scoreBreakdown: { skill: 0.4, distance: 0.2, availability: 0.4 }
    },
    {
      workerId: "worker-3",
      rank: 2,
      score: 82.2,
      scoreBreakdown: { skill: 0.3, distance: 0.2, availability: 0.5 }
    }
  ]
};

describe("Dispatch Console", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedApi.login.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresInSeconds: 3600
    });
    mockedApi.getQueue.mockResolvedValue({ items: jobsFixture });
    mockedApi.getCandidates.mockImplementation(async (_token, jobId) => ({
      candidates: candidatesByJobId[jobId] ?? []
    }));
    mockedApi.getTimeline.mockResolvedValue({ items: timelineFixture });
    mockedApi.getMessages.mockResolvedValue({ items: baseMessagesFixture });
    mockedApi.recomputeCandidates.mockImplementation(async (_token, jobId) => ({
      candidates: candidatesByJobId[jobId] ?? []
    }));
    mockedApi.assignWorker.mockResolvedValue(jobsFixture[1]);
    mockedApi.overrideWorker.mockResolvedValue(jobsFixture[1]);
    mockedApi.sendMessage.mockResolvedValue({
      id: "m-2",
      threadId: "thread-1",
      senderUserId: "dispatch-1",
      body: "Acknowledged",
      attachmentObjectKey: null,
      createdAt: "2026-03-04T10:20:00.000Z"
    });
  });

  it("supports context-driven candidate selection, assignment, override, and messaging", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Sign In" }));
    await waitFor(() => expect(mockedApi.getQueue).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(screen.getByText("Generator Repair")).toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: /HVAC Inspection/i }));
    await waitFor(() =>
      expect(mockedApi.getCandidates).toHaveBeenLastCalledWith("access-token", "job-2")
    );

    const workerCell = screen
      .getAllByText("worker-2")
      .find((element) => element.tagName.toLowerCase() === "td");
    const candidateRow = workerCell?.closest("tr");
    expect(candidateRow).not.toBeNull();
    await user.click(within(candidateRow!).getByRole("button", { name: /Select|Selected/ }));
    await user.click(screen.getByRole("button", { name: "Assign Selected Candidate" }));

    await waitFor(() =>
      expect(mockedApi.assignWorker).toHaveBeenCalledWith("access-token", "job-2", "worker-2")
    );

    await user.type(screen.getByPlaceholderText("Override reason"), "Client requested senior tech");
    await user.click(screen.getByRole("button", { name: "Override Selected Candidate" }));
    await waitFor(() =>
      expect(mockedApi.overrideWorker).toHaveBeenCalledWith(
        "access-token",
        "job-2",
        "worker-2",
        "Client requested senior tech"
      )
    );

    await user.type(screen.getByPlaceholderText("Send a message to job thread"), "Please confirm ETA");
    await user.click(screen.getByRole("button", { name: "Send Message" }));
    await waitFor(() =>
      expect(mockedApi.sendMessage).toHaveBeenCalledWith(
        "access-token",
        "job-2",
        "Please confirm ETA"
      )
    );
  });

  it("filters queue with enum controls and keeps selected job in context", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Sign In" }));
    await waitFor(() => expect(mockedApi.getQueue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Generator Repair")).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Status filter"), "ASSIGNED");
    await waitFor(() => expect(screen.queryByText("Generator Repair")).not.toBeInTheDocument());
    const jobCard = screen.getByRole("button", { name: /HVAC Inspection/i });
    expect(jobCard).toBeInTheDocument();
    expect(jobCard).toHaveTextContent("job-2");

    await user.selectOptions(screen.getByLabelText("Skill filter"), "HVAC");
    expect(screen.getByText("HVAC Inspection")).toBeInTheDocument();
    expect(screen.queryByText("Generator Repair")).not.toBeInTheDocument();
  });
});
