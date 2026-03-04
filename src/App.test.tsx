import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as api from "./api";
import { Candidate, Job, Message, TimelineEvent } from "./types";

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: ReactNode }) => <div data-testid="routing-map">{children}</div>,
  TileLayer: () => null,
  CircleMarker: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Popup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Polyline: () => null,
  useMap: () => ({
    setView: vi.fn(),
    fitBounds: vi.fn()
  })
}));

vi.mock("./api", () => ({
  login: vi.fn(),
  getQueue: vi.fn(),
  getMapOverview: vi.fn(),
  getDispatchCalendar: vi.fn(),
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
    clientOrganizationName: "Riverside Hotel",
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
    clientName: "Mina Phommathat",
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
  },
  {
    id: "t-2",
    eventType: "JOB_ASSIGNED",
    actorUserId: "dispatch-1",
    payload: {
      workerId: "worker-2",
      reason: "Client requested senior tech"
    },
    createdAt: "2026-03-04T10:15:00.000Z"
  },
  {
    id: "t-3",
    eventType: "MESSAGE_SENT",
    actorUserId: "dispatch-1",
    payload: {
      body: "Technician en route"
    },
    createdAt: "2026-03-04T10:18:00.000Z"
  }
];

const baseMessagesFixture: Message[] = [
  {
    id: "m-1",
    threadId: "thread-1",
    senderUserId: "client-1",
    senderName: "Front Desk",
    senderRole: "CLIENT",
    body: "Please prioritize this.",
    attachmentObjectKey: null,
    audience: "BOTH",
    createdAt: "2026-03-04T10:12:00.000Z"
  },
  {
    id: "m-2",
    threadId: "thread-1",
    senderUserId: "client-1",
    senderName: "Front Desk",
    senderRole: "CLIENT",
    body: "Lobby access is open.",
    attachmentObjectKey: null,
    audience: "BOTH",
    createdAt: "2026-03-04T10:14:00.000Z"
  },
  {
    id: "m-3",
    threadId: "thread-1",
    senderUserId: "dispatch-1",
    senderName: "Primary Dispatch",
    senderRole: "DISPATCH",
    body: "Acknowledged, assigning now.",
    attachmentObjectKey: null,
    audience: "BOTH",
    createdAt: "2026-03-04T10:20:00.000Z"
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
    mockedApi.getMapOverview.mockResolvedValue({
      generatedAt: "2026-03-04T10:00:00.000Z",
      scope: "TODAY",
      range: null,
      jobs: [],
      workers: [],
      routeSuggestions: []
    });
    mockedApi.getDispatchCalendar.mockResolvedValue({
      range: {
        from: "2026-03-04T00:00:00.000Z",
        to: "2026-03-11T00:00:00.000Z"
      },
      workers: [],
      unassignedJobs: []
    });
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
      senderRole: "DISPATCH",
      senderName: "Primary Dispatch",
      body: "Acknowledged",
      attachmentObjectKey: null,
      audience: "BOTH",
      createdAt: "2026-03-04T10:20:00.000Z"
    });
  });

  it("supports context-driven candidate selection, assignment, override, and messaging", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Sign In" }));
    await waitFor(() => expect(mockedApi.getQueue).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(screen.getAllByText("Riverside Hotel - Repair backup generator unit").length).toBeGreaterThan(0)
    );

    await user.click(screen.getByRole("button", { name: /Inspect AC airflow and controls/i }));
    await waitFor(() =>
      expect(mockedApi.getCandidates).toHaveBeenLastCalledWith("access-token", "job-2")
    );

    await waitFor(() =>
      expect(screen.getByTestId("selected-worker-id")).toHaveTextContent("worker-2")
    );
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

    await user.click(screen.getByRole("button", { name: "Messages" }));
    await user.type(screen.getByPlaceholderText("Send a message to job thread"), "Please confirm ETA");
    await user.click(screen.getByRole("button", { name: "Send Message" }));
    await waitFor(() =>
      expect(mockedApi.sendMessage).toHaveBeenCalledWith(
        "access-token",
        "job-2",
        "Please confirm ETA",
        "BOTH"
      )
    );
  });

  it("filters queue with enum controls and keeps selected job in context", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Sign In" }));
    await waitFor(() => expect(mockedApi.getQueue).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getAllByText("Riverside Hotel - Repair backup generator unit").length).toBeGreaterThan(0)
    );

    await user.selectOptions(screen.getByLabelText("Status filter"), "ASSIGNED");
    await waitFor(() =>
      expect(screen.queryByText("Riverside Hotel - Repair backup generator unit")).not.toBeInTheDocument()
    );
    const jobCard = screen.getByRole("button", { name: /Inspect AC airflow and controls/i });
    expect(jobCard).toBeInTheDocument();
    expect(screen.getByTestId("selected-job-id")).toHaveTextContent("job-2");

    await user.selectOptions(screen.getByLabelText("Skill filter"), "HVAC");
    expect(screen.getAllByText("Inspect AC airflow and controls").length).toBeGreaterThan(0);
    expect(screen.queryByText("Riverside Hotel - Repair backup generator unit")).not.toBeInTheDocument();
  });

  it("supports timeline action chips, message grouping, and keyboard shortcuts", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Sign In" }));
    await waitFor(() => expect(mockedApi.getQueue).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(screen.getByTestId("selected-job-id")).toHaveTextContent("job-1")
    );

    await user.keyboard("j");
    await waitFor(() =>
      expect(screen.getByTestId("selected-job-id")).toHaveTextContent("job-2")
    );

    await user.click(screen.getByRole("button", { name: "Timeline" }));
    await user.click(screen.getByRole("button", { name: /Assignment/i }));
    expect(screen.getByText("JOB_ASSIGNED")).toBeInTheDocument();
    expect(screen.queryByText("JOB_CREATED")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use reason" }));
    expect(screen.getByPlaceholderText("Override reason")).toHaveValue("Client requested senior tech");

    await user.click(screen.getByRole("button", { name: "Select worker-2" }));
    expect(screen.getByTestId("selected-worker-id")).toHaveTextContent("worker-2");

    await user.click(screen.getByRole("button", { name: "Quote in message" }));
    const quotedDraft = screen.getByPlaceholderText("Send a message to job thread") as HTMLInputElement;
    expect(quotedDraft.value).toContain("[JOB_ASSIGNED]");

    await user.click(screen.getByRole("heading", { name: "Dispatch Console" }));
    await user.keyboard("?");
    expect(screen.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeInTheDocument();

    await user.keyboard("m");
    const messageInput = screen.getByPlaceholderText("Send a message to job thread");
    expect(messageInput).toHaveFocus();

    await user.clear(messageInput);
    await user.type(messageInput, "Keyboard dispatch update");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(mockedApi.sendMessage).toHaveBeenCalledWith(
        "access-token",
        "job-2",
        "Keyboard dispatch update",
        "BOTH"
      )
    );

    expect(screen.getByText("Lobby access is open.")).toBeInTheDocument();
  });
});
