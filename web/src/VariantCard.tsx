import { useMemo, useState } from "react";
import { CHANNEL_SPECS, validateVariant } from "../../src/channels.js";
import type { Asset, PostVariant } from "../../src/domain.js";
import { CHANNEL_LABELS, nextFullHour, toLocalInputValue } from "./format";

interface Props {
  variant: PostVariant;
  assets: Asset[];
  busy: boolean;
  onApprove: (text: string, scheduledAt: Date) => void;
  onReject: () => void;
}

export function VariantCard({ variant, assets, busy, onApprove, onReject }: Props) {
  const [text, setText] = useState(variant.text);
  const [when, setWhen] = useState(() => toLocalInputValue(variant.scheduledAt ? new Date(variant.scheduledAt) : nextFullHour(new Date())));

  const spec = CHANNEL_SPECS[variant.channel];
  const problems = useMemo(() => validateVariant({ channel: variant.channel, text, assetIds: variant.assetIds }, assets), [variant, text, assets]);
  const date = new Date(when);
  const dateValid = !Number.isNaN(date.getTime());
  const canApprove = problems.length === 0 && dateValid && !busy;
  const label = CHANNEL_LABELS[variant.channel] ?? variant.channel;

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label={`Utkast för ${label}`}>
      <header className="mb-3 flex items-center justify-between">
        <span className="rounded bg-slate-900 px-2 py-0.5 text-xs font-medium text-white">{label}</span>
        <span className={`text-xs tabular-nums ${text.length > spec.maxText ? "font-semibold text-red-600" : "text-slate-500"}`}>
          {text.length} / {spec.maxText}
        </span>
      </header>

      {assets.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2">
          {assets.map((a) => (
            <li key={a.id} className="relative">
              {a.kind === "image" ? (
                <img src={a.uri} alt="" className="h-24 w-24 rounded object-cover" />
              ) : (
                <video src={a.uri} className="h-24 w-24 rounded object-cover" muted preload="metadata" />
              )}
              <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[10px] text-white">
                {a.origin === "captured" ? "egen" : "genererad"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <label className="block text-sm font-medium text-slate-700" htmlFor={`text-${variant.id}`}>
        Text
      </label>
      <textarea
        id={`text-${variant.id}`}
        className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
        rows={Math.min(12, Math.max(4, text.split("\n").length + 1))}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />

      {variant.rationale && (
        <p className="mt-2 text-xs text-slate-500">
          <span className="font-medium">Varför:</span> {variant.rationale}
        </p>
      )}
      {variant.lastError && <p className="mt-2 text-xs text-amber-700">{variant.lastError}</p>}

      {problems.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-red-600" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700" htmlFor={`when-${variant.id}`}>
            Publiceras
          </label>
          <input
            id={`when-${variant.id}`}
            type="datetime-local"
            className="mt-1 rounded border border-slate-300 p-1.5 text-sm"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            disabled={busy}
          />
        </div>
        <button
          type="button"
          className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canApprove}
          onClick={() => onApprove(text, date)}
        >
          Godkänn och schemalägg
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-700 disabled:opacity-40"
          disabled={busy}
          onClick={onReject}
        >
          Avvisa
        </button>
      </div>
    </article>
  );
}
