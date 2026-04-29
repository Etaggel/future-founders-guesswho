"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildEasyOptions,
  buildFactsChallenge,
  displayName,
  isUncertain,
  pickNewAndWeak,
  scoreRound,
  updateMastery,
} from "@/lib/game";
import { beginLogin, getTokens, logout } from "@/lib/auth";
import { loadRuntimeConfig, RuntimeConfig } from "@/lib/runtime-config";
import { Attendee, FactsChallenge, Mastery, MatchData, MatchProfile, RelationshipEdge } from "@/lib/types";

type Mode = "learn" | "play-easy" | "play-hard" | "pairs";
type AppView = "chooser" | "guess-who" | "match-maker";

const STORAGE_KEY = "ff-game-progress-v1";

export function FoundersGame() {
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [mode, setMode] = useState<Mode>("learn");
  const [mastery, setMastery] = useState<Mastery>(() => loadLocalProgress().mastery);
  const [score, setScore] = useState(() => loadLocalProgress().score);
  const [learnBatch, setLearnBatch] = useState<Attendee[]>([]);
  const [learnIndex, setLearnIndex] = useState(0);
  const [playTarget, setPlayTarget] = useState<Attendee | null>(null);
  const [hardGuess, setHardGuess] = useState("");
  const [factsPick, setFactsPick] = useState<number[]>([]);
  const [factsChallenge, setFactsChallenge] = useState<FactsChallenge | null>(null);
  const [factsResult, setFactsResult] = useState<string>("");
  const [pairQuestion, setPairQuestion] = useState<string>("");
  const [pairAnswers, setPairAnswers] = useState<number[]>([]);
  const [pairResult, setPairResult] = useState<string>("");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [appView, setAppView] = useState<AppView>("chooser");
  const [matchData, setMatchData] = useState<MatchData | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState(16);

  useEffect(() => {
    fetch("/data/attendees.json")
      .then((r) => r.json())
      .then((d) => setAttendees(d.founders ?? []));
    fetch("/data/matches.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMatchData(d))
      .catch(() => undefined);
    loadRuntimeConfig().then((config) => {
      setRuntimeConfig(config);
      const tokens = getTokens();
      setIsSignedIn(Boolean(tokens?.access_token));
      setAuthLoaded(true);
      if (config && tokens?.access_token) {
        fetch(`${config.apiBaseUrl}progress`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((remote) => {
            if (!remote) return;
            setMastery(remote.mastery ?? {});
            setScore(remote.score ?? 0);
          })
          .catch(() => undefined);
      }
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mastery, score }));
    const tokens = getTokens();
    if (runtimeConfig && tokens?.access_token) {
      fetch(`${runtimeConfig.apiBaseUrl}progress`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mastery, score }),
      }).catch(() => undefined);
    }
  }, [mastery, runtimeConfig, score]);

  useEffect(() => {
    if (!attendees.length) return;
    if (mode === "learn" && learnBatch.length === 0) {
      window.setTimeout(() => {
        setLearnBatch(pickNewAndWeak(attendees, mastery));
        setLearnIndex(0);
      }, 0);
    }
  }, [attendees, mode, learnBatch.length, mastery]);

  const learnedPool = useMemo(
    () => attendees.filter((a) => (mastery[a.id] ?? 0) > 0),
    [attendees, mastery],
  );

  const currentLearn = learnBatch[learnIndex];
  function completeLearnCard(correct: boolean) {
    if (!currentLearn) return;
    setMastery((m) => ({
      ...m,
      [currentLearn.id]: updateMastery(m[currentLearn.id] ?? 0, correct),
    }));
    if (learnIndex >= learnBatch.length - 1) {
      setLearnBatch([]);
      startPlay("play-easy");
      return;
    }
    setLearnIndex((x) => x + 1);
  }

  function startPlay(nextMode: Mode) {
    const pool = learnedPool.length > 0 ? learnedPool : attendees;
    const target = pool[Math.floor(Math.random() * pool.length)] ?? null;
    setPlayTarget(target);
    setFactsChallenge(target ? buildFactsChallenge(target) : null);
    setMode(nextMode);
    setHardGuess("");
    setFactsPick([]);
    setFactsResult("");
    if (target) void loadAiFacts(target);
  }

  async function loadAiFacts(target: Attendee) {
    const tokens = getTokens();
    if (!runtimeConfig || !tokens?.access_token) return;
    try {
      const response = await fetch(`${runtimeConfig.apiBaseUrl}ai/facts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profile: target }),
      });
      if (!response.ok) return;
      const generated = (await response.json()) as { facts?: Array<{ text: string; truth: boolean }> };
      const facts = generated.facts ?? [];
      if (facts.length === 3) {
        setFactsChallenge({
          options: facts.map((fact) => fact.text),
          lieIndex: facts.findIndex((fact) => !fact.truth),
        });
      }
    } catch {
      // Local deterministic fallback remains active.
    }
  }

  function submitPlay(nameCorrect: boolean) {
    if (!playTarget || !factsChallenge) return;
    const trueIndexes = [0, 1, 2].filter((i) => i !== factsChallenge.lieIndex);
    const factsCorrectCount = factsPick.filter((x) => trueIndexes.includes(x)).length;
    const round = scoreRound({
      nameCorrect,
      factsCorrectCount,
      speedScore: 0.75,
      hintsUsed: mode === "play-hard" ? 0 : 1,
    });
    setScore((s) => s + round);
    setMastery((m) => ({
      ...m,
      [playTarget.id]: updateMastery(m[playTarget.id] ?? 0, nameCorrect && factsCorrectCount >= 2),
    }));
    setFactsResult(
      factsCorrectCount >= 2
        ? `Nice. +${round} points. True facts locked in.`
        : `Close. +${round} points. Keep reviewing this profile.`,
    );
  }

  function createPairsQuestion() {
    const pool = (learnedPool.length > 3 ? learnedPool : attendees).slice(0, 8);
    const selected = pool.filter((a) => a.category === "Technical").map((a) => a.id);
    setPairQuestion("Tap all attendees in the Technical category.");
    setPairAnswers(selected);
    setPairResult("");
    void loadAiPairs(pool);
  }

  async function loadAiPairs(pool: Attendee[]) {
    const tokens = getTokens();
    if (!runtimeConfig || !tokens?.access_token) return;
    try {
      const response = await fetch(`${runtimeConfig.apiBaseUrl}ai/pairs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profiles: pool }),
      });
      if (!response.ok) return;
      const generated = (await response.json()) as { question?: string; answerIds?: number[] };
      if (generated.question && generated.answerIds?.length) {
        setPairQuestion(generated.question);
        setPairAnswers(generated.answerIds);
      }
    } catch {
      // Local category fallback remains active.
    }
  }

  function scorePairs(chosen: number[]) {
    const correct = chosen.every((id) => pairAnswers.includes(id)) && chosen.length === pairAnswers.length;
    setPairResult(
      correct
        ? `Correct. ${chosen.length}/${pairAnswers.length} selected exactly.`
        : `Not quite. Correct IDs: ${pairAnswers.join(", ")}.`,
    );
    if (correct) setScore((s) => s + 30);
  }

  if (!attendees.length) {
    return <LoadingScreen />;
  }

  if (!authLoaded) {
    return <LoadingScreen />;
  }

  if (!isSignedIn) {
    return <LoginScreen runtimeConfig={runtimeConfig} />;
  }

  if (appView === "chooser") {
    return (
      <Shell>
        <header className="overflow-hidden rounded-[2rem] border border-white/25 bg-white/90 p-8 shadow-2xl shadow-slate-900/10 backdrop-blur">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#cb5549]">Future Founders</p>
              <h1 className="mt-3 text-4xl font-black tracking-tight text-[#0f1933] sm:text-6xl">
                Choose your prep mode.
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-slate-600">
                Learn faces and facts, then study the compatibility map to spot warm intros, cofounder fits, and useful conversation angles.
              </p>
            </div>
            {runtimeConfig && (
              <button className="self-start rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50" onClick={() => logout(runtimeConfig)}>
                Sign Out
              </button>
            )}
          </div>
        </header>

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <button
            className="group rounded-[2rem] bg-[#0f1933] p-7 text-left text-white shadow-2xl shadow-[#0f1933]/20 transition hover:-translate-y-1 hover:shadow-[#0f1933]/30"
            onClick={() => setAppView("guess-who")}
          >
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-[#8fb7e8]">Guess Who</p>
            <h2 className="mt-4 text-3xl font-black">Names, facts, and recall</h2>
            <p className="mt-3 text-slate-300">Practice recognition, hard-mode recall, two-truths-and-a-lie, and category pairing.</p>
            <span className="mt-8 inline-flex rounded-full bg-white px-5 py-3 font-semibold text-[#0f1933] transition group-hover:bg-[#8fb7e8]">Start learning</span>
          </button>

          <button
            className="group rounded-[2rem] bg-gradient-to-br from-[#cb5549] via-[#d97d4d] to-[#f0c36a] p-7 text-left text-white shadow-2xl shadow-[#cb5549]/25 transition hover:-translate-y-1 hover:shadow-[#cb5549]/35"
            onClick={() => setAppView("match-maker")}
          >
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-white/80">Match Maker</p>
            <h2 className="mt-4 text-3xl font-black">Relationship map and why it matters</h2>
            <p className="mt-3 text-white/90">Explore high-potential matches, shared domains, complementary gaps, and smart intro prompts.</p>
            <span className="mt-8 inline-flex rounded-full bg-white px-5 py-3 font-semibold text-[#9b352d] transition group-hover:bg-[#0f1933] group-hover:text-white">Explore matches</span>
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 rounded-[2rem] border border-white/50 bg-white/90 p-5 shadow-xl shadow-slate-900/10 backdrop-blur">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <button className="mb-3 text-sm font-semibold text-[#5583b7] hover:text-[#0f1933]" onClick={() => setAppView("chooser")}>← Prep modes</button>
              <h1 className="text-3xl font-black">{appView === "guess-who" ? "Guess Who" : "Match Maker"}</h1>
            </div>
            <div className="flex gap-2">
              <button className={`rounded-full px-4 py-2 text-sm font-semibold ${appView === "guess-who" ? "bg-[#0f1933] text-white" : "bg-white text-slate-700"}`} onClick={() => setAppView("guess-who")}>Guess Who</button>
              <button className={`rounded-full px-4 py-2 text-sm font-semibold ${appView === "match-maker" ? "bg-[#cb5549] text-white" : "bg-white text-slate-700"}`} onClick={() => setAppView("match-maker")}>Match Maker</button>
            </div>
          </div>

          {appView === "guess-who" && (
            <>
          <p className="mt-1 text-sm text-slate-600">
            Score: <strong>{score}</strong> | Learned: {Object.values(mastery).filter((x) => x > 0).length}/{attendees.length}
          </p>
          <div className="mt-4 flex gap-2">
            <button className="rounded-xl bg-[#5583b7] px-3 py-2 text-white" onClick={() => setMode("learn")}>Learn</button>
            <button className="rounded-xl bg-[#4fb77c] px-3 py-2 text-white" onClick={() => startPlay("play-easy")}>Play Easy</button>
            <button className="rounded-xl bg-[#1e2d40] px-3 py-2 text-white" onClick={() => startPlay("play-hard")}>Play Hard</button>
            <button className="rounded-xl bg-[#cb5549] px-3 py-2 text-white" onClick={() => { setMode("pairs"); createPairsQuestion(); }}>Pairs</button>
            {runtimeConfig && isSignedIn && (
              <button className="rounded-xl border px-3 py-2" onClick={() => logout(runtimeConfig)}>Sign Out</button>
            )}
          </div>
            </>
          )}
        </header>

        {appView === "match-maker" && (
          <MatchMakerPanel
            attendees={attendees}
            matchData={matchData}
            selectedId={selectedMatchId}
            onSelect={setSelectedMatchId}
          />
        )}

        {appView === "guess-who" && (
          <>
        {mode === "learn" && currentLearn && (
          <section className="rounded-[2rem] border border-white/50 bg-white/90 p-6 shadow-xl shadow-slate-900/10 backdrop-blur">
            <p className="mb-2 text-sm uppercase tracking-wide">Learn Mode {learnIndex + 1}/3</p>
            <h2 className="text-2xl font-semibold">{displayName(currentLearn)}</h2>
            <p className="mt-1 text-slate-700">{currentLearn.tagline}</p>
            <p className="mt-3 text-sm text-slate-600">{currentLearn.profile_summary?.background}</p>
            {isUncertain(currentLearn) && (
              <p className="mt-3 rounded-lg bg-amber-100 p-2 text-sm text-amber-900">
                Identity not fully confirmed yet. I’ll flag this profile in enrichment reports.
              </p>
            )}
            <div className="mt-5 flex gap-2">
              <button className="rounded-xl border px-3 py-2" onClick={() => completeLearnCard(false)}>Needs Review</button>
              <button className="rounded-xl bg-[#5583b7] px-3 py-2 text-white" onClick={() => completeLearnCard(true)}>I Know This Person</button>
            </div>
          </section>
        )}

        {(mode === "play-easy" || mode === "play-hard") && playTarget && factsChallenge && (
          <section className="rounded-[2rem] border border-white/50 bg-white/90 p-6 shadow-xl shadow-slate-900/10 backdrop-blur">
            <p className="mb-2 text-sm uppercase tracking-wide">{mode === "play-easy" ? "Play Easy" : "Play Hard"}</p>
            <h2 className="text-2xl font-semibold">Who is this attendee?</h2>
            <div className="mt-3 rounded-2xl border p-3">
              <p className="text-sm text-slate-600">Tagline clue:</p>
              <p>{playTarget.tagline}</p>
            </div>

            {mode === "play-easy" ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                {buildEasyOptions(learnedPool.length > 2 ? learnedPool : attendees, playTarget).map((x) => (
                  <button
                    key={x.id}
                    className="rounded-xl border px-3 py-2 text-left"
                    onClick={() => submitPlay(x.id === playTarget.id)}
                  >
                    {displayName(x)}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-4">
                <input
                  value={hardGuess}
                  onChange={(e) => setHardGuess(e.target.value)}
                  placeholder="Type full name..."
                  className="w-full rounded-xl border px-3 py-2"
                />
                <button
                  className="mt-2 rounded-xl bg-[#1e2d40] px-3 py-2 text-white"
                  onClick={() => submitPlay(hardGuess.trim().toLowerCase() === displayName(playTarget).toLowerCase())}
                >
                  Reveal
                </button>
              </div>
            )}

            <div className="mt-6">
              <p className="font-medium">Two truths and a lie: pick the two true facts</p>
              <div className="mt-2 space-y-2">
                {factsChallenge.options.map((fact, i) => (
                  <label key={i} className="flex items-center gap-2 rounded-xl border p-2">
                    <input
                      type="checkbox"
                      checked={factsPick.includes(i)}
                      onChange={(e) => {
                        setFactsPick((prev) =>
                          e.target.checked ? [...prev, i].slice(0, 2) : prev.filter((x) => x !== i),
                        );
                      }}
                    />
                    <span>{fact}</span>
                  </label>
                ))}
              </div>
              {factsResult && <p className="mt-3 rounded-xl bg-slate-100 p-2 text-sm">{factsResult}</p>}
              <button className="mt-3 rounded-xl border px-3 py-2" onClick={() => startPlay(mode)}>Next Round</button>
            </div>
          </section>
        )}

        {mode === "pairs" && (
          <PairsPanel attendees={attendees} question={pairQuestion} onSubmit={scorePairs} result={pairResult} />
        )}
          </>
        )}
      </div>
    </Shell>
  );
}

function loadLocalProgress(): { mastery: Mastery; score: number } {
  if (typeof window === "undefined") return { mastery: {}, score: 0 };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { mastery: {}, score: 0 };
  try {
    const parsed = JSON.parse(raw) as { mastery?: Mastery; score?: number };
    return { mastery: parsed.mastery ?? {}, score: parsed.score ?? 0 };
  } catch {
    return { mastery: {}, score: 0 };
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#f7c36b_0,#f7c36b_18rem,transparent_18rem),radial-gradient(circle_at_top_right,#8fb7e8_0,#8fb7e8_20rem,transparent_20rem),linear-gradient(135deg,#f8fafc,#dce7f7_55%,#f7efe8)] px-4 py-6 text-[#0f1933] sm:px-6">
      <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.55),rgba(255,255,255,0))]" />
      <div className="relative mx-auto max-w-6xl">{children}</div>
    </main>
  );
}

function LoadingScreen() {
  return (
    <Shell>
      <section className="mx-auto mt-24 max-w-lg rounded-[2rem] border border-white/60 bg-white/90 p-8 text-center shadow-2xl shadow-slate-900/10 backdrop-blur">
        <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#cb5549]">Future Founders</p>
        <h1 className="mt-4 text-3xl font-black">Loading your prep room...</h1>
      </section>
    </Shell>
  );
}

function LoginScreen({ runtimeConfig }: { runtimeConfig: RuntimeConfig | null }) {
  return (
    <Shell>
      <section className="mx-auto mt-16 grid max-w-5xl overflow-hidden rounded-[2.25rem] border border-white/50 bg-white/90 shadow-2xl shadow-slate-900/15 backdrop-blur lg:grid-cols-[1.1fr_0.9fr]">
        <div className="p-8 sm:p-12">
          <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#cb5549]">Founders. Faces. Fits.</p>
          <h1 className="mt-5 text-5xl font-black tracking-tight text-[#0f1933] sm:text-6xl">
            Future Founders prep, unlocked by login.
          </h1>
          <p className="mt-5 text-lg leading-8 text-slate-600">
            Sign in to learn names, rehearse conversation hooks, and explore compatibility insights before you meet everyone in the room.
          </p>
          <button
            className="mt-8 rounded-full bg-[#0f1933] px-7 py-4 text-base font-bold text-white shadow-xl shadow-[#0f1933]/25 transition hover:-translate-y-0.5 hover:bg-[#cb5549] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
            disabled={!runtimeConfig}
            onClick={() => runtimeConfig && beginLogin(runtimeConfig)}
          >
            Continue with Google
          </button>
          {!runtimeConfig && (
            <p className="mt-3 text-sm text-amber-700">Login config is not available in this local build yet.</p>
          )}
        </div>
        <div className="bg-gradient-to-br from-[#0f1933] via-[#284b76] to-[#cb5549] p-8 text-white sm:p-12">
          <div className="rounded-[2rem] border border-white/20 bg-white/10 p-6 backdrop-blur">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-white/70">What you get</p>
            <div className="mt-6 space-y-5">
              {[
                ["Private prep", "Sign in before any attendee data or study tools are shown."],
                ["Relationship insight", "Understand why a conversation might be worth having."],
                ["Better intros", "Turn compatibility signals into useful first conversations."],
              ].map(([title, body]) => (
                <div key={title} className="rounded-2xl bg-white/10 p-4">
                  <h2 className="font-bold">{title}</h2>
                  <p className="mt-1 text-sm text-white/75">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </Shell>
  );
}

function MatchMakerPanel({
  attendees,
  matchData,
  selectedId,
  onSelect,
}: {
  attendees: Attendee[];
  matchData: MatchData | null;
  selectedId: number;
  onSelect: (id: number) => void;
}) {
  const attendeeById = useMemo(() => new Map(attendees.map((attendee) => [attendee.id, attendee])), [attendees]);
  const profileById = useMemo(
    () => new Map((matchData?.attendees ?? []).map((profile) => [profile.id, profile])),
    [matchData],
  );
  const selectedAttendee = attendeeById.get(selectedId) ?? attendees[0];
  const selectedProfile = selectedAttendee ? profileById.get(selectedAttendee.id) : undefined;
  const selectedEdges = useMemo(
    () =>
      (matchData?.relationship_edges ?? [])
        .filter((edge) => edge.source === selectedId || edge.target === selectedId)
        .sort((a, b) => b.score - a.score),
    [matchData, selectedId],
  );
  const clusters = matchData?.insight_dimensions.highest_domain_density_clusters ?? [];

  if (!matchData || !selectedAttendee || !selectedProfile) {
    return (
      <section className="rounded-[2rem] border border-white/50 bg-white/90 p-8 shadow-xl shadow-slate-900/10 backdrop-blur">
        <h2 className="text-2xl font-black">Loading match intelligence...</h2>
        <p className="mt-2 text-slate-600">Compatibility data will appear once `/data/matches.json` is available.</p>
      </section>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
      <aside className="rounded-[2rem] border border-white/50 bg-white/90 p-4 shadow-xl shadow-slate-900/10 backdrop-blur">
        <p className="px-2 text-xs font-bold uppercase tracking-[0.25em] text-[#cb5549]">Attendees</p>
        <div className="mt-3 max-h-[38rem] space-y-2 overflow-auto pr-1">
          {attendees.map((attendee) => {
            const active = attendee.id === selectedId;
            return (
              <button
                key={attendee.id}
                className={`w-full rounded-2xl p-3 text-left transition ${active ? "bg-[#0f1933] text-white shadow-lg shadow-[#0f1933]/20" : "bg-white hover:bg-slate-50"}`}
                onClick={() => onSelect(attendee.id)}
              >
                <p className="font-bold">{displayName(attendee)}</p>
                <p className={`mt-1 text-xs ${active ? "text-white/70" : "text-slate-500"}`}>{profileById.get(attendee.id)?.orientation ?? attendee.category}</p>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="space-y-5">
        <div className="overflow-hidden rounded-[2rem] border border-white/50 bg-white/90 shadow-xl shadow-slate-900/10 backdrop-blur">
          <div className="bg-gradient-to-br from-[#0f1933] via-[#274b78] to-[#cb5549] p-7 text-white">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.3em] text-white/65">Match profile</p>
                <h2 className="mt-3 text-4xl font-black">{displayName(selectedAttendee)}</h2>
                <p className="mt-2 text-white/80">{selectedAttendee.tagline}</p>
              </div>
              <ConfidenceBadge attendee={selectedAttendee} />
            </div>
            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <SignalCard title="Orientation" values={[humanize(selectedProfile.orientation)]} />
              <SignalCard title="Strengths" values={selectedProfile.strengths.slice(0, 3)} />
              <SignalCard title="Needs" values={selectedProfile.needs.slice(0, 3)} />
            </div>
          </div>
          <div className="p-6">
            <h3 className="text-xl font-black">Best relationship paths</h3>
            <p className="mt-1 text-sm text-slate-600">
              Treat these as conversation intelligence, not a ranking of people. The best use is spotting where help, domain depth, or founder complementarity is likely.
            </p>
            <div className="mt-4 grid gap-3">
              {selectedEdges.slice(0, 6).map((edge) => (
                <RelationshipCard
                  key={`${edge.source}-${edge.target}-${edge.relationship_type}`}
                  edge={edge}
                  selectedId={selectedId}
                  attendeeById={attendeeById}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
          <div className="rounded-[2rem] border border-white/50 bg-white/90 p-6 shadow-xl shadow-slate-900/10 backdrop-blur">
            <h3 className="text-xl font-black">How other attendees can use this</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {buildBenefitIdeas(selectedProfile).map((idea) => (
                <div key={idea.title} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                  <p className="font-bold text-[#0f1933]">{idea.title}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{idea.body}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/50 bg-white/90 p-6 shadow-xl shadow-slate-900/10 backdrop-blur">
            <h3 className="text-xl font-black">Dense opportunity clusters</h3>
            <div className="mt-4 space-y-3">
              {clusters.slice(0, 4).map((cluster) => (
                <div key={cluster.cluster} className="rounded-2xl bg-gradient-to-br from-white to-slate-50 p-4 ring-1 ring-slate-100">
                  <p className="font-bold">{humanize(cluster.cluster)}</p>
                  <p className="mt-1 text-sm text-slate-500">{cluster.members.length} attendees</p>
                  <p className="mt-2 text-sm text-slate-700">{cluster.opportunities.slice(0, 2).join(" · ")}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function RelationshipCard({
  edge,
  selectedId,
  attendeeById,
  onSelect,
}: {
  edge: RelationshipEdge;
  selectedId: number;
  attendeeById: Map<number, Attendee>;
  onSelect: (id: number) => void;
}) {
  const otherId = edge.source === selectedId ? edge.target : edge.source;
  const other = attendeeById.get(otherId);
  if (!other) return null;
  return (
    <button className="rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md" onClick={() => onSelect(otherId)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-lg font-black text-[#0f1933]">{displayName(other)}</p>
          <p className="mt-1 text-sm text-slate-500">{humanize(edge.relationship_type)}</p>
        </div>
        <span className="rounded-full bg-[#4fb77c]/15 px-3 py-1 text-sm font-bold text-[#25734b]">{Math.round(edge.score * 100)}% fit</span>
      </div>
      <ul className="mt-3 space-y-1 text-sm text-slate-600">
        {edge.reasons.slice(0, 3).map((reason) => (
          <li key={reason}>• {reason}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm font-semibold text-[#5583b7]">Study this relationship →</p>
    </button>
  );
}

function SignalCard({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="rounded-2xl bg-white/10 p-4 ring-1 ring-white/20">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-white/60">{title}</p>
      <p className="mt-2 text-sm font-semibold text-white">{values.map(humanize).join(" · ")}</p>
    </div>
  );
}

function ConfidenceBadge({ attendee }: { attendee: Attendee }) {
  const confidence = attendee.identified_person?.confidence ?? attendee.likely_match?.confidence ?? 0;
  const label = confidence >= 0.85 ? "Confirmed" : confidence >= 0.75 ? "Probable" : "Unconfirmed";
  return (
    <span className="rounded-full bg-white/15 px-4 py-2 text-sm font-bold text-white ring-1 ring-white/25">
      {label} identity · {Math.round(confidence * 100)}%
    </span>
  );
}

function buildBenefitIdeas(profile: MatchProfile) {
  return [
    {
      title: "Find a useful intro",
      body: `Lead with ${humanize(profile.core_domains[0] ?? profile.segment)} and ask who in the room has lived that problem before.`,
    },
    {
      title: "Spot complementarity",
      body: `This attendee brings ${profile.strengths.slice(0, 2).join(" and ")}; the best match may cover ${profile.needs[0] ?? "a missing founder skill"}.`,
    },
    {
      title: "Create a mini-mastermind",
      body: "Use clusters to form 3-person groups: one domain expert, one builder, and one operator with distribution or market access.",
    },
    {
      title: "Ask better questions",
      body: "Instead of pitching, ask why the suggested fit might fail. The objections will teach you faster than the score.",
    },
  ];
}

function humanize(value: string) {
  return value.replace(/_/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function PairsPanel({
  attendees,
  question,
  onSubmit,
  result,
}: {
  attendees: Attendee[];
  question: string;
  onSubmit: (chosen: number[]) => void;
  result: string;
}) {
  const shown = attendees.slice(0, 8);
  const [picked, setPicked] = useState<number[]>([]);
  return (
    <section className="rounded-[2rem] border border-white/50 bg-white/90 p-6 shadow-xl shadow-slate-900/10 backdrop-blur">
      <p className="mb-3 text-sm uppercase tracking-wide">Pairs Game</p>
      <h2 className="text-xl font-semibold">{question}</h2>
      <div className="mt-4 grid gap-2 sm:grid-cols-4">
        {shown.map((a) => {
          const on = picked.includes(a.id);
          return (
            <button
              key={a.id}
              onClick={() => setPicked((prev) => (on ? prev.filter((x) => x !== a.id) : [...prev, a.id]))}
              className={`rounded-xl border p-3 text-left ${on ? "bg-[#5583b7] text-white" : "bg-white"}`}
            >
              <p className="font-medium">{displayName(a)}</p>
              <p className="text-xs opacity-80">{a.category}</p>
            </button>
          );
        })}
      </div>
      <button className="mt-4 rounded-xl bg-[#cb5549] px-3 py-2 text-white" onClick={() => onSubmit(picked)}>
        Check Answer
      </button>
      {result && <p className="mt-3 rounded-xl bg-slate-100 p-2 text-sm">{result}</p>}
    </section>
  );
}
