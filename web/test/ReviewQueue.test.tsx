// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SocialApi } from "../src/api";
import type { Asset, PostVariant } from "../../src/domain.js";
import { ReviewQueue } from "../src/ReviewQueue";

const variant = (over: Partial<PostVariant> = {}): PostVariant => ({
  id: crypto.randomUUID(),
  briefId: "b",
  channel: "linkedin",
  text: "Ett utkast",
  assetIds: [],
  status: "draft",
  attempts: 0,
  createdAt: "2026-11-02T08:00:00.000Z",
  ...over,
});

function fakeApi(byStatus: Partial<Record<PostVariant["status"], PostVariant[]>>, assets: Asset[] = []): SocialApi {
  return {
    listVariants: vi.fn(async (s: PostVariant["status"]) => structuredClone(byStatus[s] ?? [])),
    getAssets: vi.fn(async (ids) => assets.filter((a) => ids.includes(a.id))),
    approve: vi.fn(async () => {}),
    reject: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
  };
}

describe("ReviewQueue", () => {
  it("shows an empty state", async () => {
    render(<ReviewQueue api={fakeApi({})} />);
    expect(await screen.findByText("Inga utkast att granska just nu.")).toBeInTheDocument();
  });

  it("approves a draft with edited text and the chosen time, then removes it from the list", async () => {
    const v = variant({ rationale: "Funkar bra på tisdagar" });
    const api = fakeApi({ draft: [v] });
    const user = userEvent.setup();
    render(<ReviewQueue api={api} />);

    const card = await screen.findByRole("article", { name: "Utkast för LinkedIn" });
    expect(within(card).getByText(/Funkar bra på tisdagar/)).toBeInTheDocument();

    const text = within(card).getByLabelText("Text");
    await user.clear(text);
    await user.type(text, "Redigerad text");
    const when = within(card).getByLabelText("Publiceras");
    await user.clear(when);
    await user.type(when, "2026-11-03T09:30");
    await user.click(within(card).getByRole("button", { name: "Godkänn och schemalägg" }));

    await waitFor(() => expect(api.approve).toHaveBeenCalledTimes(1));
    const [id, input] = vi.mocked(api.approve).mock.calls[0]!;
    expect(id).toBe(v.id);
    expect(input.text).toBe("Redigerad text");
    expect(input.scheduledAt.getTime()).toBe(new Date("2026-11-03T09:30").getTime());
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
  });

  it("rejects a draft", async () => {
    const v = variant();
    const api = fakeApi({ draft: [v] });
    render(<ReviewQueue api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Avvisa" }));
    await waitFor(() => expect(api.reject).toHaveBeenCalledWith(v.id));
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
  });

  it("blocks approval when the text breaks the channel limit, and says why", async () => {
    const api = fakeApi({ draft: [variant({ channel: "x", text: "a".repeat(281) })] });
    render(<ReviewQueue api={api} />);
    const button = await screen.findByRole("button", { name: "Godkänn och schemalägg" });
    expect(button).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("allows 280");
    expect(screen.getByText("281 / 280")).toBeInTheDocument();
  });

  it("blocks approval when a channel that needs media has none", async () => {
    render(<ReviewQueue api={fakeApi({ draft: [variant({ channel: "instagram" })] })} />);
    expect(await screen.findByRole("button", { name: "Godkänn och schemalägg" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("instagram requires media");
  });

  it("shows attached assets with their origin and allows approval once media is present", async () => {
    const asset: Asset = { id: "a1", kind: "image", origin: "captured", uri: "https://cdn.test/a.jpg", createdAt: "2026-11-02T08:00:00.000Z" };
    render(<ReviewQueue api={fakeApi({ draft: [variant({ channel: "instagram", assetIds: ["a1"] })] }, [asset])} />);
    expect(await screen.findByText("egen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Godkänn och schemalägg" })).toBeEnabled();
  });

  it("keeps the draft and shows the error when approving fails", async () => {
    const api = fakeApi({ draft: [variant()] });
    vi.mocked(api.approve).mockRejectedValueOnce(new Error("Utkastet finns inte längre som utkast. Ladda om listan."));
    render(<ReviewQueue api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Godkänn och schemalägg" }));
    expect(await screen.findByText(/finns inte längre som utkast/)).toBeInTheDocument();
    expect(screen.getByRole("article")).toBeInTheDocument();
  });

  it("shows a load error", async () => {
    const api = fakeApi({});
    vi.mocked(api.listVariants).mockRejectedValueOnce(new Error("permission denied"));
    render(<ReviewQueue api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });

  it("lists failed variants read-only with their error", async () => {
    const api = fakeApi({ failed: [variant({ status: "failed", lastError: "HTTP 400 från linkedin" })] });
    render(<ReviewQueue api={api} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Misslyckade" }));
    expect(await screen.findByText("HTTP 400 från linkedin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Avvisa" })).not.toBeInTheDocument();
  });
});

describe("ReviewQueue: failed posts", () => {
  it("retries a failed post from the Misslyckade tab and removes it from the list", async () => {
    const v = variant({ status: "failed", lastError: "Avbröts under publicering. Kontrollera på plattformen" });
    const api = fakeApi({ failed: [v] });
    render(<ReviewQueue api={api} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Misslyckade" }));
    expect(await screen.findByText(/Avbröts under publicering/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith(v.id));
    await waitFor(() => expect(screen.queryByText(/Avbröts under publicering/)).not.toBeInTheDocument());
  });

  it("keeps the post and shows the reason when the retry is refused", async () => {
    const api = fakeApi({ failed: [variant({ status: "failed", lastError: "fel" })] });
    vi.mocked(api.retry).mockRejectedValueOnce(new Error("not allowed"));
    render(<ReviewQueue api={api} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Misslyckade" }));
    await userEvent.click(await screen.findByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not allowed");
    expect(screen.getByRole("button", { name: "Försök igen" })).toBeInTheDocument();
  });

  it("offers no retry on the other tabs", async () => {
    render(<ReviewQueue api={fakeApi({ scheduled: [variant({ status: "scheduled" })] })} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Schemalagda" }));
    await screen.findByText("Ett utkast");
    expect(screen.queryByRole("button", { name: "Försök igen" })).not.toBeInTheDocument();
  });
});
