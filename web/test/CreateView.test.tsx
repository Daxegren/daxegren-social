// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Asset, ContentBrief } from "../../src/domain.js";
import { MAX_UPLOAD_BYTES, type CreateApi } from "../src/api";
import { CreateView } from "../src/CreateView";

const asset = (over: Partial<Asset> = {}): Asset => ({ id: crypto.randomUUID(), kind: "image", origin: "captured", uri: "https://x.test/a.jpg", createdAt: "2026-11-02T08:00:00.000Z", ...over });
const brief = (over: Partial<ContentBrief> = {}): ContentBrief => ({
  id: crypto.randomUUID(), idea: "En idé", sourcePostIds: [], assetIds: [], channels: ["linkedin"], status: "requested", createdAt: "2026-11-02T08:00:00.000Z", ...over,
});

function fakeApi(init: { assets?: Asset[]; requests?: ContentBrief[] } = {}): CreateApi {
  const requests = [...(init.requests ?? [])];
  return {
    listAssets: vi.fn(async () => init.assets ?? []),
    uploadAsset: vi.fn(async (file: File) => asset({ id: `up-${file.name}`, kind: file.type.startsWith("video/") ? "video" : "image" })),
    requestDrafts: vi.fn(async (input) => {
      requests.unshift(brief({ idea: input.idea, channels: input.channels }));
    }),
    listRequests: vi.fn(async () => [...requests]),
  };
}

const file = (name: string, type: string, size = 1000) => {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

const submit = () => screen.getByRole("button", { name: /Beställ utkast/ });

describe("CreateView", () => {
  it("the order button stays disabled until there is an idea and a channel", async () => {
    const user = userEvent.setup();
    render(<CreateView api={fakeApi()} />);
    expect(submit()).toBeDisabled();
    await user.type(screen.getByLabelText(/Vad ska inlägget/), "kort");
    await user.click(screen.getByLabelText("LinkedIn"));
    expect(submit()).toBeDisabled(); // idea too short
    await user.type(screen.getByLabelText(/Vad ska inlägget/), " nog nu");
    expect(submit()).toBeEnabled();
    await user.click(screen.getByLabelText("LinkedIn"));
    expect(submit()).toBeDisabled(); // no channel
  });

  it("sends idea, optional fields, channels in a stable order and the selected assets, then resets and confirms", async () => {
    const user = userEvent.setup();
    const mine = asset({ id: "a1" });
    const other = asset({ id: "a2", origin: "generated" });
    const api = fakeApi({ assets: [mine, other] });
    render(<CreateView api={api} />);

    await screen.findByLabelText("Bild (egen)");
    await user.click(screen.getByLabelText("Bild (egen)"));
    await user.type(screen.getByLabelText(/Vad ska inlägget/), "  Tre lärdomar från veckan  ");
    await user.click(screen.getByText("Vinkel och mål (valfritt)"));
    await user.type(screen.getByLabelText("Vinkel"), "ärligt");
    await user.click(screen.getByLabelText("LinkedIn")); // picked after Instagram on purpose
    await user.click(screen.getByLabelText("Instagram"));
    await user.click(submit());

    await waitFor(() => expect(api.requestDrafts).toHaveBeenCalledTimes(1));
    expect(api.requestDrafts).toHaveBeenCalledWith({ idea: "Tre lärdomar från veckan", angle: "ärligt", goal: undefined, channels: ["instagram", "linkedin"], assetIds: ["a1"] });
    expect(await screen.findByRole("status")).toHaveTextContent("Beställt");
    expect(screen.getByLabelText(/Vad ska inlägget/)).toHaveValue("");
    expect(await screen.findByText("Tre lärdomar från veckan")).toBeInTheDocument(); // appears in the order list
  });

  it("uploads chosen files, selects them, and attaches them to the order", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<CreateView api={api} />);
    await user.upload(screen.getByLabelText("Välj foto eller video"), [file("me.jpg", "image/jpeg"), file("clip.mp4", "video/mp4")]);

    await waitFor(() => expect(api.uploadAsset).toHaveBeenCalledTimes(2));
    await user.type(screen.getByLabelText(/Vad ska inlägget/), "Bakom kulisserna");
    await user.click(screen.getByLabelText("Instagram"));
    await user.click(submit());
    await waitFor(() => expect(api.requestDrafts).toHaveBeenCalled());
    expect(vi.mocked(api.requestDrafts).mock.calls[0]![0].assetIds.sort()).toEqual(["up-clip.mp4", "up-me.jpg"]);
  });

  it("explains a HEIC photo, an unsupported type and an oversized file, and uploads nothing", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const api = fakeApi();
    render(<CreateView api={api} />);
    await user.upload(screen.getByLabelText("Välj foto eller video"), [
      file("IMG_1.heic", "image/heic"), file("doc.pdf", "application/pdf"), file("big.mp4", "video/mp4", MAX_UPLOAD_BYTES + 1),
    ]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HEIC stöds inte");
    expect(alert).toHaveTextContent("doc.pdf: filtypen stöds inte");
    expect(alert).toHaveTextContent("big.mp4: filen är större än 50 MB");
    expect(api.uploadAsset).not.toHaveBeenCalled();
  });

  it("uploads the good files even when another one is rejected, and reports a failed upload by name", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const api = fakeApi();
    vi.mocked(api.uploadAsset).mockImplementation(async (f) => {
      if (f.name === "broken.jpg") throw new Error("Nätverksfel");
      return asset({ id: `up-${f.name}` });
    });
    render(<CreateView api={api} />);
    await user.upload(screen.getByLabelText("Välj foto eller video"), [file("good.jpg", "image/jpeg"), file("broken.jpg", "image/jpeg"), file("x.gif", "image/gif")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("broken.jpg: Nätverksfel");
    expect(screen.getByRole("alert")).toHaveTextContent("x.gif: filtypen stöds inte");
    expect(await screen.findByLabelText("Bild (egen)")).toBeChecked();
  });

  it("shows the server's error and keeps the form filled in", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    vi.mocked(api.requestDrafts).mockRejectedValueOnce(new Error("new row violates row-level security policy"));
    render(<CreateView api={api} />);
    await user.type(screen.getByLabelText(/Vad ska inlägget/), "Något viktigt");
    await user.click(screen.getByLabelText("LinkedIn"));
    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("row-level security");
    expect(screen.getByLabelText(/Vad ska inlägget/)).toHaveValue("Något viktigt");
  });

  it("lists orders with their status, and the reason when one failed", async () => {
    render(<CreateView api={fakeApi({ requests: [
      brief({ idea: "Väntar", status: "requested" }), brief({ idea: "Pågår", status: "processing" }),
      brief({ idea: "Färdig", status: "ready" }), brief({ idea: "Trasig", status: "failed", error: "Claude is down" }),
    ] })} />);
    expect(await screen.findByText("Väntar på nästa körning")).toBeInTheDocument();
    expect(screen.getByText("Skapar utkast…")).toBeInTheDocument();
    expect(screen.getByText("Klar – se Utkast")).toBeInTheDocument();
    expect(screen.getByText("Misslyckades: Claude is down")).toBeInTheDocument();
  });

  it("shows a load error instead of an empty page", async () => {
    const api = fakeApi();
    vi.mocked(api.listAssets).mockRejectedValueOnce(new Error("permission denied"));
    render(<CreateView api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
  });
});
