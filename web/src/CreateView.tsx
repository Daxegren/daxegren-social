import { useCallback, useEffect, useRef, useState } from "react";
import { CHANNELS, type Asset, type BriefStatus, type Channel, type ContentBrief } from "../../src/domain.js";
import { validateUpload, type CreateApi } from "./api";
import { CHANNEL_LABELS, formatWhen } from "./format";

const STATUS_LABEL: Record<BriefStatus, string> = {
  requested: "Väntar på nästa körning",
  processing: "Skapar utkast…",
  ready: "Klar – se Utkast",
  failed: "Misslyckades",
};

type Notice = { kind: "ok" | "error"; text: string };

/** Mobile-first: upload your own material, say what the post is about, pick channels. Drafts appear under Utkast. */
export function CreateView({ api }: { api: CreateApi }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(0);
  const [idea, setIdea] = useState("");
  const [angle, setAngle] = useState("");
  const [goal, setGoal] = useState("");
  const [channels, setChannels] = useState<Set<Channel>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [requests, setRequests] = useState<ContentBrief[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([api.listAssets(), api.listRequests()]);
      setAssets(a);
      setRequests(r);
    } catch (e) {
      setNotice({ kind: "error", text: (e as Error).message });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    return next;
  };

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setNotice(undefined);
    const errors: string[] = [];
    // Validate everything first so a bad file is explained before anything is uploaded.
    const ok = [...files].filter((f) => {
      const problem = validateUpload(f);
      if (problem) errors.push(problem);
      return !problem;
    });
    setUploading(ok.length);
    for (const file of ok) {
      try {
        const asset = await api.uploadAsset(file);
        setAssets((a) => [asset, ...a]);
        setSelected((s) => new Set(s).add(asset.id));
      } catch (e) {
        errors.push(`${file.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (errors.length) setNotice({ kind: "error", text: errors.join("\n") });
    if (fileInput.current) fileInput.current.value = "";
  }

  const ready = idea.trim().length >= 5 && channels.size > 0 && uploading === 0 && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSubmitting(true);
    setNotice(undefined);
    try {
      await api.requestDrafts({
        idea: idea.trim(),
        angle: angle.trim() || undefined,
        goal: goal.trim() || undefined,
        channels: CHANNELS.filter((c) => channels.has(c)),
        assetIds: [...selected],
      });
      setIdea("");
      setAngle("");
      setGoal("");
      setSelected(new Set());
      setNotice({ kind: "ok", text: "Beställt. Utkasten dyker upp under Utkast vid nästa körning (högst ca 15 minuter)." });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  const input = "mt-1 w-full rounded border border-slate-300 p-2 text-base";

  return (
    <section aria-labelledby="create-title" className="space-y-6">
      <h1 id="create-title" className="text-xl font-semibold text-slate-900">
        Skapa
      </h1>

      {notice && (
        <p role={notice.kind === "error" ? "alert" : "status"} className={`whitespace-pre-line rounded border p-3 text-sm ${notice.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
          {notice.text}
        </p>
      )}

      <form onSubmit={submit} className="space-y-6">
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">1. Material (valfritt)</legend>
          <label className="mt-2 flex cursor-pointer items-center justify-center rounded border-2 border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
            {uploading > 0 ? `Laddar upp ${uploading} fil(er)…` : "Ta ett foto, spela in eller välj från galleriet"}
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
              multiple
              className="sr-only"
              aria-label="Välj foto eller video"
              onChange={(e) => void onFiles(e.target.files)}
            />
          </label>
          {assets.length > 0 && (
            <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {assets.map((a) => (
                <li key={a.id}>
                  <label className={`relative block aspect-square cursor-pointer overflow-hidden rounded bg-slate-200 ${selected.has(a.id) ? "ring-4 ring-emerald-500" : "opacity-80"}`}>
                    {a.kind === "image" ? <img src={a.uri} alt="" className="h-full w-full object-cover" /> : <video src={a.uri} className="h-full w-full object-cover" muted preload="metadata" />}
                    <input type="checkbox" className="sr-only" checked={selected.has(a.id)} onChange={() => setSelected((s) => toggle(s, a.id))} aria-label={`${a.kind === "image" ? "Bild" : "Video"} (${a.origin === "captured" ? "egen" : "genererad"})`} />
                    <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">{a.origin === "captured" ? "egen" : "genererad"}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <div>
          <label htmlFor="idea" className="text-sm font-medium text-slate-700">
            2. Vad ska inlägget handla om?
          </label>
          <textarea id="idea" rows={4} maxLength={2000} className={input} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Till exempel: tre lärdomar från veckans bygge" />
          <details className="mt-2 text-sm text-slate-600">
            <summary className="cursor-pointer">Vinkel och mål (valfritt)</summary>
            <label htmlFor="angle" className="mt-2 block">Vinkel</label>
            <input id="angle" className={input} maxLength={500} value={angle} onChange={(e) => setAngle(e.target.value)} />
            <label htmlFor="goal" className="mt-2 block">Mål</label>
            <input id="goal" className={input} maxLength={500} value={goal} onChange={(e) => setGoal(e.target.value)} />
          </details>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">3. Kanaler</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {CHANNELS.map((c) => (
              <label key={c} className={`cursor-pointer rounded border px-3 py-2 text-sm ${channels.has(c) ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"}`}>
                <input type="checkbox" className="sr-only" checked={channels.has(c)} onChange={() => setChannels((s) => toggle(s, c))} />
                {CHANNEL_LABELS[c] ?? c}
              </label>
            ))}
          </div>
        </fieldset>

        <button type="submit" disabled={!ready} className="w-full rounded bg-emerald-600 px-4 py-3 text-base font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
          {submitting ? "Beställer…" : "Beställ utkast"}
        </button>
      </form>

      <section aria-labelledby="orders-title">
        <h2 id="orders-title" className="mb-2 text-sm font-medium text-slate-700">
          Dina beställningar
        </h2>
        {requests.length === 0 ? (
          <p className="text-sm text-slate-500">Inga än.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {requests.map((r) => (
              <li key={r.id} className="p-3 text-sm">
                <p className="line-clamp-2 text-slate-800">{r.idea}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {(r.channels ?? []).map((c) => CHANNEL_LABELS[c] ?? c).join(", ")} · {formatWhen(r.createdAt)}
                </p>
                <p className={`mt-1 text-xs ${r.status === "failed" ? "text-red-600" : "text-slate-600"}`}>
                  {STATUS_LABEL[r.status ?? "ready"]}
                  {r.status === "failed" && r.error ? `: ${r.error}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
