import { useCallback, useEffect, useState } from "react";
import type { SocialApi } from "./api";
import type { Asset, PostVariant, VariantStatus } from "../../src/domain.js";
import { CHANNEL_LABELS, formatWhen } from "./format";
import { VariantCard } from "./VariantCard";

const TABS: Array<{ status: VariantStatus; label: string }> = [
  { status: "draft", label: "Utkast" },
  { status: "scheduled", label: "Schemalagda" },
  { status: "published", label: "Publicerade" },
  { status: "failed", label: "Misslyckade" },
];

export function ReviewQueue({ api }: { api: SocialApi }) {
  const [tab, setTab] = useState<VariantStatus>("draft");
  const [variants, setVariants] = useState<PostVariant[]>([]);
  const [assets, setAssets] = useState<Map<string, Asset>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const list = await api.listVariants(tab);
      const found = await api.getAssets([...new Set(list.flatMap((v) => v.assetIds))]);
      setVariants(list);
      setAssets(new Map(found.map((a) => [a.id, a])));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, run: () => Promise<void>) {
    setBusyId(id);
    setError(undefined);
    try {
      await run();
      setVariants((vs) => vs.filter((v) => v.id !== id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section aria-labelledby="queue-title">
      <h1 id="queue-title" className="mb-4 text-xl font-semibold text-slate-900">
        Granskningskö
      </h1>

      <div role="tablist" className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.status}
            role="tab"
            aria-selected={tab === t.status}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.status ? "border-slate-900 font-medium text-slate-900" : "border-transparent text-slate-500"}`}
            onClick={() => setTab(t.status)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Laddar…</p>
      ) : variants.length === 0 ? (
        <p className="text-sm text-slate-500">{tab === "draft" ? "Inga utkast att granska just nu." : "Inget här."}</p>
      ) : tab === "draft" ? (
        <div className="space-y-4">
          {variants.map((v) => (
            <VariantCard
              key={v.id}
              variant={v}
              assets={v.assetIds.flatMap((id) => assets.get(id) ?? [])}
              busy={busyId === v.id}
              onApprove={(text, scheduledAt) => act(v.id, () => api.approve(v.id, { text, scheduledAt }))}
              onReject={() => act(v.id, () => api.reject(v.id))}
            />
          ))}
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {variants.map((v) => (
            <li key={v.id} className="p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{CHANNEL_LABELS[v.channel] ?? v.channel}</span>
                <span className="text-xs text-slate-500">{formatWhen(v.publishedAt ?? v.scheduledAt)}</span>
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-line text-slate-700">{v.text}</p>
              {v.url && (
                <a className="text-xs text-blue-600 underline" href={v.url} target="_blank" rel="noreferrer">
                  Öppna inlägg
                </a>
              )}
              {v.lastError && <p className="mt-1 text-xs text-red-600">{v.lastError}</p>}
              {tab === "failed" && (
                <button
                  type="button"
                  className="mt-2 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 disabled:opacity-40"
                  disabled={busyId === v.id}
                  onClick={() => act(v.id, () => api.retry(v.id))}
                >
                  Försök igen
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
