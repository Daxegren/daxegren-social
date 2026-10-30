import type { Session } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import { supabase, supabaseConfigured } from "./lib/supabase";
import { supabaseSocialApi } from "./api";
import { ReviewQueue } from "./ReviewQueue";

function Login() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) {
      setState("error");
      setMessage(error.message);
    } else {
      setState("sent");
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-24 max-w-sm space-y-3">
      <h1 className="text-xl font-semibold">David OS</h1>
      <label className="block text-sm font-medium" htmlFor="email">
        E-post
      </label>
      <input id="email" type="email" required className="w-full rounded border border-slate-300 p-2" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="w-full rounded bg-slate-900 py-2 text-white" type="submit">
        Skicka inloggningslänk
      </button>
      {state === "sent" && <p className="text-sm text-emerald-700">Kolla din e-post.</p>}
      {state === "error" && <p role="alert" className="text-sm text-red-700">{message}</p>}
    </form>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const api = useMemo(() => supabaseSocialApi(supabase), []);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) {
    return (
      <main className="mx-auto mt-24 max-w-md p-4 text-sm">
        Saknar <code>VITE_SUPABASE_URL</code> och <code>VITE_SUPABASE_ANON_KEY</code>. Se <code>.env.example</code>.
      </main>
    );
  }
  if (session === undefined) return <main className="p-4 text-sm text-slate-500">Laddar…</main>;
  if (!session) return <Login />;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <span className="font-semibold">David OS</span>
        <button className="text-sm text-slate-600 underline" onClick={() => void supabase.auth.signOut()}>
          Logga ut
        </button>
      </header>
      <main className="mx-auto max-w-3xl p-4">
        <ReviewQueue api={api} />
      </main>
    </div>
  );
}
