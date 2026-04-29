"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildEasyOptions,
  buildFactsChallenge,
  displayName,
  isUncertain,
  pickNewAndWeak,
  scoreRound,
  shuffle,
  updateMastery,
} from "@/lib/game";
import { beginLogin, clearTokens, getTokens, logout } from "@/lib/auth";
import { loadRuntimeConfig, RuntimeConfig } from "@/lib/runtime-config";
import { Attendee, FactsChallenge, Mastery, MatchData, RelationshipEdge, RelationshipInsight } from "@/lib/types";

type Mode = "learn" | "play-easy" | "play-hard" | "pairs";
type AppView = "chooser" | "guess-who" | "match-maker";
type PairChallenge = { question: string; answerIds: number[]; explanation?: string };

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
  const [pairKey, setPairKey] = useState(0);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [appView, setAppView] = useState<AppView>("chooser");
  const [matchData, setMatchData] = useState<MatchData | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null);

  const studyPool = useMemo(() => attendees.filter(isStudyReady), [attendees]);

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
    if (!studyPool.length) return;
    if (mode === "learn" && learnBatch.length === 0) {
      window.setTimeout(() => {
        setLearnBatch(pickNewAndWeak(studyPool, mastery));
        setLearnIndex(0);
      }, 0);
    }
  }, [studyPool, mode, learnBatch.length, mastery]);

  const learnedPool = useMemo(
    () => attendees.filter((a) => isStudyReady(a) && (mastery[a.id] ?? 0) > 0),
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
    const pool = learnedPool.length > 0 ? learnedPool : studyPool;
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
    const pool = shuffleForPrompt(learnedPool.length > 3 ? learnedPool : studyPool).slice(0, 8);
    const challenge = buildLocalPairsChallenge(pool);
    setPairQuestion(challenge.question);
    setPairAnswers(challenge.answerIds);
    setPairResult("");
    setPairKey((key) => key + 1);
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
        setPairKey((key) => key + 1);
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

  function handleSignOut() {
    if (runtimeConfig) {
      logout(runtimeConfig);
      return;
    }
    clearTokens();
    setIsSignedIn(false);
    setAppView("chooser");
  }

  function openMatchMaker() {
    setSelectedMatchId(null);
    setAppView("match-maker");
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
            <SignOutButton onClick={handleSignOut} />
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
            onClick={openMatchMaker}
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
              <button className={`rounded-full px-4 py-2 text-sm font-semibold ${appView === "match-maker" ? "bg-[#cb5549] text-white" : "bg-white text-slate-700"}`} onClick={openMatchMaker}>Match Maker</button>
              <SignOutButton onClick={handleSignOut} />
            </div>
          </div>

          {appView === "guess-who" && (
            <>
          <p className="mt-1 text-sm text-slate-600">
            Score: <strong>{score}</strong> | Learned: {studyPool.filter((a) => (mastery[a.id] ?? 0) > 0).length}/{studyPool.length} named profiles
          </p>
          <div className="mt-4 flex gap-2">
            <button className="rounded-xl bg-[#5583b7] px-3 py-2 text-white" onClick={() => setMode("learn")}>Learn</button>
            <button className="rounded-xl bg-[#4fb77c] px-3 py-2 text-white" onClick={() => startPlay("play-easy")}>Play Easy</button>
            <button className="rounded-xl bg-[#1e2d40] px-3 py-2 text-white" onClick={() => startPlay("play-hard")}>Play Hard</button>
            <button className="rounded-xl bg-[#cb5549] px-3 py-2 text-white" onClick={() => { setMode("pairs"); createPairsQuestion(); }}>Pairs</button>
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
            runtimeConfig={runtimeConfig}
          />
        )}

        {appView === "guess-who" && (
          <>
        {mode === "learn" && currentLearn && (
          <section className="overflow-hidden rounded-[2rem] border border-white/50 bg-white/90 shadow-xl shadow-slate-900/10 backdrop-blur">
            <div className="grid gap-0 lg:grid-cols-[18rem_1fr]">
              <div className="bg-gradient-to-br from-[#0f1933] via-[#274b78] to-[#cb5549] p-6 text-white">
                <p className="mb-4 text-sm font-semibold uppercase tracking-[0.25em] text-white/65">Learn {learnIndex + 1}/3</p>
                <FounderAvatar attendee={currentLearn} size="xl" />
                <p className="mt-4 text-sm text-white/70">Face first. Name second. Facts third.</p>
              </div>
              <div className="p-6">
                <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[#cb5549]">Study this founder</p>
                <h2 className="mt-2 text-4xl font-black tracking-tight text-[#0f1933]">{displayName(currentLearn)}</h2>
                <p className="mt-2 text-lg text-slate-700">{currentLearn.tagline}</p>
                <LinkedInProfileLink attendee={currentLearn} className="mt-4" />
                <p className="mt-5 text-sm leading-6 text-slate-600">{currentLearn.profile_summary?.background}</p>
                <div className="mt-5 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-100">
                  <p className="font-black text-[#0f1933]">Key facts to remember</p>
                  <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
                    {profileFacts(currentLearn).map((fact) => <li key={fact}>• {fact}</li>)}
                  </ul>
                </div>
                {isUncertain(currentLearn) && (
                  <p className="mt-3 rounded-lg bg-amber-100 p-2 text-sm text-amber-900">
                    Identity not fully confirmed yet. I’ll flag this profile in enrichment reports.
                  </p>
                )}
                <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                  <button className="rounded-xl border border-slate-200 bg-white px-4 py-3 font-semibold text-slate-700" onClick={() => completeLearnCard(false)}>Show another profile</button>
                  <button className="rounded-xl bg-[#5583b7] px-4 py-3 font-bold text-white" onClick={() => completeLearnCard(true)}>I’m ready to practice recall</button>
                </div>
              </div>
            </div>
          </section>
        )}

        {(mode === "play-easy" || mode === "play-hard") && playTarget && factsChallenge && (
          <section className="rounded-[2rem] border border-white/50 bg-white/90 p-6 shadow-xl shadow-slate-900/10 backdrop-blur">
            <p className="mb-2 text-sm uppercase tracking-wide">{mode === "play-easy" ? "Play Easy" : "Play Hard"}</p>
            <h2 className="text-2xl font-semibold">Who is this attendee?</h2>
            <div className="mt-3 flex flex-col gap-4 rounded-2xl border bg-gradient-to-br from-white to-slate-50 p-4 sm:flex-row sm:items-center">
              <FounderAvatar attendee={playTarget} size="xl" />
              <div>
              <p className="text-sm text-slate-600">Tagline clue:</p>
              <p>{playTarget.tagline}</p>
              <LinkedInProfileLink attendee={playTarget} className="mt-3" />
              </div>
            </div>

            {mode === "play-easy" ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                {buildEasyOptions(learnedPool.length > 2 ? learnedPool : studyPool, playTarget).map((x) => (
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
          <PairsPanel key={pairKey} attendees={studyPool} question={pairQuestion} onSubmit={scorePairs} result={pairResult} onNext={createPairsQuestion} />
        )}
          </>
        )}
      </div>
    </Shell>
  );
}

function MatchMakerLanding({
  matchData,
  attendees,
  visibleEdges,
  clusters,
  onSelect,
}: {
  matchData: MatchData;
  attendees: Attendee[];
  visibleEdges: RelationshipEdge[];
  clusters: MatchData["insight_dimensions"]["highest_domain_density_clusters"];
  onSelect: (id: number | null) => void;
}) {
  const strongest = visibleEdges[0];
  const namedCount = attendees.filter(isNamed).length;
  return (
    <section className="overflow-hidden rounded-[2rem] border border-white/50 bg-white/90 shadow-xl shadow-slate-900/10 backdrop-blur">
      <div className="grid gap-0 lg:grid-cols-[1fr_18rem]">
        <div className="p-7">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-[#cb5549]">Map overview</p>
          <h2 className="mt-3 text-4xl font-black tracking-tight text-[#0f1933]">Start with the network, then choose a founder.</h2>
          <p className="mt-4 max-w-2xl text-slate-600">
            This view shows compatibility paths without assuming Lyndon, or anyone else, is the default starting point. Use the filters above to reveal a cluster, then open a person or relationship to prepare a sharper conversation.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <MetricCard label="Profiles" value={String(matchData.attendees.length)} detail={`${namedCount} named`} />
            <MetricCard label="Relationships" value={String(matchData.relationship_edges.length)} detail="Scored paths" />
            <MetricCard label="Clusters" value={String(clusters?.length ?? 0)} detail="Opportunity groups" />
          </div>
          {strongest && (
            <button
              className="mt-6 rounded-2xl bg-[#0f1933] px-5 py-4 text-left font-bold text-white shadow-xl shadow-[#0f1933]/20 transition hover:-translate-y-0.5 hover:bg-[#cb5549]"
              onClick={() => onSelect(strongest.source)}
            >
              Explore strongest visible path · {Math.round(strongest.score * 100)}% fit
            </button>
          )}
        </div>
        <div className="bg-gradient-to-br from-[#0f1933] to-[#cb5549] p-7 text-white">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-white/65">Suggested workflow</p>
          <ol className="mt-5 space-y-4 text-sm leading-6 text-white/85">
            <li><strong>1.</strong> Filter by cluster or relationship type.</li>
            <li><strong>2.</strong> Pick a node with a dense set of strong paths.</li>
            <li><strong>3.</strong> Study the relationship before starting the conversation.</li>
          </ol>
        </div>
      </div>
    </section>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-black text-[#0f1933]">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

function ScrollNudge({ direction }: { direction: "up" | "down" }) {
  const isUp = direction === "up";
  return (
    <div
      className={`pointer-events-none absolute left-0 right-1 z-10 flex justify-center ${isUp ? "top-0 bg-gradient-to-b from-white via-white/90 to-transparent pb-5 pt-1" : "bottom-0 bg-gradient-to-t from-white via-white/90 to-transparent pb-1 pt-5"}`}
      aria-hidden="true"
    >
      <span className="grid h-7 w-7 place-items-center rounded-full bg-[#0f1933] text-xs font-black text-white shadow-lg shadow-slate-900/20">
        {isUp ? "↑" : "↓"}
      </span>
    </div>
  );
}

function MatchGraphPanel({
  attendees,
  edges,
  selectedId,
  clusters,
  clusterFilter,
  typeFilter,
  relationshipTypes,
  onClusterFilter,
  onTypeFilter,
  onSelect,
}: {
  attendees: Attendee[];
  edges: RelationshipEdge[];
  selectedId: number | null;
  clusters: MatchData["insight_dimensions"]["highest_domain_density_clusters"];
  clusterFilter: string;
  typeFilter: string;
  relationshipTypes: string[];
  onClusterFilter: (cluster: string) => void;
  onTypeFilter: (type: string) => void;
  onSelect: (id: number | null) => void;
}) {
  const topNodes = attendees.slice(0, 16);
  const angleStep = (Math.PI * 2) / Math.max(topNodes.length, 1);
  const center = 150;
  const radius = 110;
  const positions = new Map(
    topNodes.map((attendee, index) => [
      attendee.id,
      {
        x: center + Math.cos(index * angleStep - Math.PI / 2) * radius,
        y: center + Math.sin(index * angleStep - Math.PI / 2) * radius,
      },
    ]),
  );
  const graphEdges = edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target)).slice(0, 36);
  return (
    <section className="rounded-[2rem] border border-white/50 bg-white/90 p-5 shadow-xl shadow-slate-900/10 backdrop-blur">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[#5583b7]">Relationship graph</p>
          <h3 className="mt-2 text-2xl font-black">Filter the room by cluster and connection type.</h3>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <select className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold" value={clusterFilter} onChange={(event) => onClusterFilter(event.target.value)}>
            <option value="all">All clusters</option>
            {(clusters ?? []).map((cluster) => <option key={cluster.cluster} value={cluster.cluster}>{humanize(cluster.cluster)}</option>)}
          </select>
          <select className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold" value={typeFilter} onChange={(event) => onTypeFilter(event.target.value)}>
            <option value="all">All relationships</option>
            {relationshipTypes.map((type) => <option key={type} value={type}>{humanize(type)}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[22rem_1fr]">
        <div className="relative overflow-hidden rounded-[1.75rem] bg-[#0f1933] p-2 text-white shadow-inner">
          <svg viewBox="0 0 300 300" className="h-80 w-full">
            <defs>
              <radialGradient id="graphGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#8fb7e8" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#0f1933" stopOpacity="0" />
              </radialGradient>
            </defs>
            <circle cx="150" cy="150" r="145" fill="url(#graphGlow)" />
            {graphEdges.map((edge) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              if (!source || !target) return null;
              const active = selectedId === edge.source || selectedId === edge.target;
              return <line key={`${edge.source}-${edge.target}-${edge.relationship_type}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke={active ? "#f0c36a" : "rgba(255,255,255,0.28)"} strokeWidth={1 + edge.score * 3} />;
            })}
            {topNodes.map((attendee) => {
              const point = positions.get(attendee.id);
              if (!point) return null;
              const active = selectedId === attendee.id;
              return (
                <g key={attendee.id} className="cursor-pointer" onClick={() => onSelect(attendee.id)}>
                  <circle cx={point.x} cy={point.y} r={active ? 16 : 12} fill={active ? "#f0c36a" : "#cb5549"} stroke="white" strokeWidth="2" />
                  <text x={point.x} y={point.y + 4} textAnchor="middle" className="fill-white text-[9px] font-black">{attendee.id}</text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="grid content-start gap-3 sm:grid-cols-2">
          {(clusters ?? []).slice(0, 4).map((cluster) => (
            <button key={cluster.cluster} className={`rounded-2xl p-4 text-left ring-1 transition ${clusterFilter === cluster.cluster ? "bg-[#0f1933] text-white ring-[#0f1933]" : "bg-slate-50 ring-slate-100 hover:bg-white"}`} onClick={() => onClusterFilter(clusterFilter === cluster.cluster ? "all" : cluster.cluster)}>
              <p className="font-black">{humanize(cluster.cluster)}</p>
              <p className={`mt-1 text-sm ${clusterFilter === cluster.cluster ? "text-white/70" : "text-slate-500"}`}>{cluster.members.length} members</p>
              <p className={`mt-2 text-sm ${clusterFilter === cluster.cluster ? "text-white/80" : "text-slate-600"}`}>{cluster.opportunities[0]}</p>
            </button>
          ))}
        </div>
      </div>
    </section>
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

function isNamed(attendee: Attendee) {
  const name = attendee.identified_person?.name || attendee.likely_match?.name;
  return Boolean(name && !name.startsWith("Likely "));
}

function attendeePhoto(attendee: Attendee) {
  return (
    attendee.photo_url ||
    attendee.identified_person?.photo_url ||
    attendee.likely_match?.photo_url ||
    attendee.image_url ||
    attendee.photo ||
    attendee.image ||
    attendee.avatar ||
    null
  );
}

function linkedinUrl(attendee: Attendee) {
  return attendee.identified_person?.linkedin_url || attendee.likely_match?.linkedin_url || null;
}

function isStudyReady(attendee: Attendee) {
  return isNamed(attendee);
}

function profileFacts(attendee: Attendee) {
  const facts = (attendee.extra_facts ?? []).map((item) => item.fact).slice(0, 4);
  if (facts.length) return facts;
  return [attendee.tagline, ...(attendee.profile_summary?.interests ?? []).slice(0, 3).map((interest) => `Interested in ${interest}`)];
}

function initialsFor(attendee: Attendee) {
  return displayName(attendee)
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || `#${attendee.id}`;
}

function FounderAvatar({ attendee, size = "md" }: { attendee: Attendee; size?: "sm" | "md" | "lg" | "xl" }) {
  const photo = attendeePhoto(attendee);
  const sizeClass = size === "xl" ? "h-56 w-56 text-5xl" : size === "lg" ? "h-20 w-20 text-2xl" : size === "sm" ? "h-10 w-10 text-sm" : "h-14 w-14 text-lg";
  if (photo) {
    return <div className={`${sizeClass} rounded-full bg-cover bg-center shadow-inner ring-2 ring-white`} style={{ backgroundImage: `url(${photo})` }} aria-label={`${displayName(attendee)} photo`} />;
  }
  const hue = (attendee.id * 47) % 360;
  return (
    <div
      className={`${sizeClass} grid shrink-0 place-items-center rounded-full font-black text-white shadow-inner ring-1 ring-white/50`}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 72% 34%), hsl(${(hue + 42) % 360} 68% 54%))` }}
      aria-label={`${displayName(attendee)} generated avatar`}
    >
      {initialsFor(attendee)}
    </div>
  );
}

function LinkedInProfileLink({
  attendee,
  variant = "light",
  className = "",
}: {
  attendee: Attendee;
  variant?: "light" | "dark";
  className?: string;
}) {
  const url = linkedinUrl(attendee);
  if (!url) return null;
  const classes =
    variant === "dark"
      ? "bg-white/15 text-white ring-white/25 hover:bg-white hover:text-[#0f1933]"
      : "bg-[#0a66c2]/10 text-[#0a66c2] ring-[#0a66c2]/15 hover:bg-[#0a66c2] hover:text-white";
  return (
    <a
      className={`${className} inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-black transition ring-1 ${classes}`}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      aria-label={`Open ${displayName(attendee)} LinkedIn profile`}
    >
      <span className="grid h-4 w-4 place-items-center rounded-[0.2rem] bg-[#0a66c2] text-[0.62rem] leading-none text-white" aria-hidden="true">in</span>
      LinkedIn
    </a>
  );
}

function buildLocalPairsChallenge(pool: Attendee[]): PairChallenge {
  const categories = Array.from(new Set(pool.map((attendee) => attendee.category))).filter(Boolean);
  for (const category of shuffle(categories)) {
    const answerIds = pool.filter((attendee) => attendee.category === category).map((attendee) => attendee.id);
    if (answerIds.length >= 2) {
      return {
        question: `Select everyone whose profile is tagged ${category}.`,
        answerIds,
        explanation: "Fallback prompt generated from local categories.",
      };
    }
  }
  const keyword = "AI";
  const answerIds = pool
    .filter((attendee) => `${attendee.tagline} ${attendee.profile_summary?.background ?? ""}`.toLowerCase().includes(keyword.toLowerCase()))
    .map((attendee) => attendee.id);
  return {
    question: `Select everyone with ${keyword} in their profile clues.`,
    answerIds: answerIds.length ? answerIds : pool.slice(0, 2).map((attendee) => attendee.id),
    explanation: "Fallback prompt generated from local profile text.",
  };
}

function shuffleForPrompt(pool: Attendee[]) {
  return shuffle(pool.length ? pool : []);
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

function SignOutButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="self-start rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50"
      onClick={onClick}
    >
      Sign Out
    </button>
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
  runtimeConfig,
}: {
  attendees: Attendee[];
  matchData: MatchData | null;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  runtimeConfig: RuntimeConfig | null;
}) {
  const [clusterFilter, setClusterFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [deepDiveEdge, setDeepDiveEdge] = useState<RelationshipEdge | null>(null);
  const [deepDive, setDeepDive] = useState<RelationshipInsight | null>(null);
  const [deepDiveLoading, setDeepDiveLoading] = useState(false);
  const attendeeRailRef = useRef<HTMLDivElement | null>(null);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const [railOverflow, setRailOverflow] = useState({ up: false, down: false });
  const attendeeById = useMemo(() => new Map(attendees.map((attendee) => [attendee.id, attendee])), [attendees]);
  const profileById = useMemo(
    () => new Map((matchData?.attendees ?? []).map((profile) => [profile.id, profile])),
    [matchData],
  );
  const clusters = useMemo(
    () => matchData?.insight_dimensions.highest_domain_density_clusters ?? [],
    [matchData],
  );
  const clusterMemberIds = useMemo(() => {
    if (clusterFilter === "all") return null;
    return new Set(clusters.find((cluster) => cluster.cluster === clusterFilter)?.members ?? []);
  }, [clusterFilter, clusters]);
  const relationshipTypes = useMemo(
    () => Array.from(new Set((matchData?.relationship_edges ?? []).map((edge) => edge.relationship_type))).sort(),
    [matchData],
  );
  const visibleAttendees = useMemo(
    () => attendees.filter((attendee) => !clusterMemberIds || clusterMemberIds.has(attendee.id)),
    [attendees, clusterMemberIds],
  );
  const visibleEdges = useMemo(
    () =>
      (matchData?.relationship_edges ?? [])
        .filter((edge) => typeFilter === "all" || edge.relationship_type === typeFilter)
        .filter((edge) => !clusterMemberIds || (clusterMemberIds.has(edge.source) && clusterMemberIds.has(edge.target)))
        .sort((a, b) => b.score - a.score),
    [clusterMemberIds, matchData, typeFilter],
  );
  const selectedAttendee = selectedId ? attendeeById.get(selectedId) : undefined;
  const selectedProfile = selectedAttendee ? profileById.get(selectedAttendee.id) : undefined;
  const selectedEdges = useMemo(
    () =>
      visibleEdges
        .filter((edge) => selectedId !== null && (edge.source === selectedId || edge.target === selectedId))
        .sort((a, b) => b.score - a.score),
    [selectedId, visibleEdges],
  );

  function updateRailOverflow() {
    const rail = attendeeRailRef.current;
    if (!rail) return;
    setRailOverflow({
      up: rail.scrollTop > 4,
      down: rail.scrollTop + rail.clientHeight < rail.scrollHeight - 4,
    });
  }

  function handleSelect(id: number | null) {
    onSelect(id);
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(updateRailOverflow);
    return () => window.cancelAnimationFrame(frame);
  }, [visibleAttendees.length, selectedId]);

  useEffect(() => {
    if (!selectedAttendee) return;
    const frame = window.requestAnimationFrame(() => {
      profileRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedAttendee]);

  async function studyRelationship(edge: RelationshipEdge) {
    setDeepDiveEdge(edge);
    setDeepDiveLoading(true);
    setDeepDive(null);
    const fallback = buildRelationshipFallback(edge, attendeeById);
    const tokens = getTokens();
    if (!runtimeConfig || !tokens?.access_token) {
      setDeepDive(fallback);
      setDeepDiveLoading(false);
      return;
    }
    try {
      const response = await fetch(`${runtimeConfig.apiBaseUrl}ai/relationship`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          edge,
          source: attendeeById.get(edge.source),
          target: attendeeById.get(edge.target),
          sourceProfile: profileById.get(edge.source),
          targetProfile: profileById.get(edge.target),
        }),
      });
      if (!response.ok) throw new Error("Relationship endpoint unavailable");
      setDeepDive((await response.json()) as RelationshipInsight);
    } catch {
      setDeepDive(fallback);
    } finally {
      setDeepDiveLoading(false);
    }
  }

  function collapseRelationship() {
    setDeepDiveEdge(null);
    setDeepDive(null);
    setDeepDiveLoading(false);
  }

  if (!matchData) {
    return (
      <section className="rounded-[2rem] border border-white/50 bg-white/90 p-8 shadow-xl shadow-slate-900/10 backdrop-blur">
        <h2 className="text-2xl font-black">Loading match intelligence...</h2>
        <p className="mt-2 text-slate-600">Compatibility data will appear once `/data/matches.json` is available.</p>
      </section>
    );
  }

  return (
    <div className="min-h-[calc(100vh-11rem)]">
      <aside className="sticky top-4 z-20 flex h-[calc(100vh-2rem)] flex-col rounded-[2rem] border border-white/50 bg-white/90 p-4 shadow-xl shadow-slate-900/10 backdrop-blur lg:fixed lg:left-[max(1.5rem,calc((100vw-64rem)/2))] lg:top-6 lg:h-[calc(100vh-3rem)] lg:w-[19rem]">
        <div className="flex items-center justify-between gap-3 px-2">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-[#cb5549]">Attendees</p>
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-500">{visibleAttendees.length}</span>
        </div>
        <button
          className={`mt-3 w-full rounded-2xl p-3 text-left transition ${selectedId === null ? "bg-[#cb5549] text-white shadow-lg shadow-[#cb5549]/20" : "bg-white hover:bg-slate-50"}`}
          onClick={() => handleSelect(null)}
        >
          <p className="font-bold">Map overview</p>
          <p className={`mt-1 text-xs ${selectedId === null ? "text-white/75" : "text-slate-500"}`}>Clusters, filters, and strongest paths</p>
        </button>
        <div className="relative mt-3 min-h-0 flex-1">
          {railOverflow.up && <ScrollNudge direction="up" />}
          {railOverflow.down && <ScrollNudge direction="down" />}
        <div ref={attendeeRailRef} className="h-full space-y-2 overflow-auto pr-1 [scrollbar-gutter:stable]" onScroll={updateRailOverflow}>
          {visibleAttendees.map((attendee) => {
            const active = attendee.id === selectedId;
            return (
              <button
                key={attendee.id}
                className={`flex w-full items-center gap-3 rounded-2xl p-3 text-left transition ${active ? "bg-[#0f1933] text-white shadow-lg shadow-[#0f1933]/20" : "bg-white hover:bg-slate-50"}`}
                onClick={() => handleSelect(attendee.id)}
              >
                <FounderAvatar attendee={attendee} size="sm" />
                <span>
                  <p className="font-bold">{displayName(attendee)}</p>
                  <p className={`mt-1 text-xs ${active ? "text-white/70" : "text-slate-500"}`}>{profileById.get(attendee.id)?.orientation ?? attendee.category}</p>
                </span>
              </button>
            );
          })}
        </div>
        </div>
      </aside>

      <section className="mt-5 space-y-5 lg:ml-[20.25rem] lg:mt-0">
        <MatchGraphPanel
          attendees={visibleAttendees}
          edges={visibleEdges}
          selectedId={selectedId}
          clusters={clusters}
          clusterFilter={clusterFilter}
          typeFilter={typeFilter}
          relationshipTypes={relationshipTypes}
          onClusterFilter={setClusterFilter}
          onTypeFilter={setTypeFilter}
          onSelect={handleSelect}
        />

        {!selectedAttendee || !selectedProfile ? (
          <MatchMakerLanding matchData={matchData} attendees={attendees} visibleEdges={visibleEdges} clusters={clusters} onSelect={handleSelect} />
        ) : (
        <div ref={profileRef} className="scroll-mt-6 overflow-hidden rounded-[2rem] border border-white/50 bg-white/90 shadow-xl shadow-slate-900/10 backdrop-blur">
          <div className="bg-gradient-to-br from-[#0f1933] via-[#274b78] to-[#cb5549] p-7 text-white">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.3em] text-white/65">Match profile</p>
                <div className="mt-3 flex items-center gap-4">
                  <FounderAvatar attendee={selectedAttendee} size="lg" />
                  <div>
                    <h2 className="text-4xl font-black">{displayName(selectedAttendee)}</h2>
                    <p className="mt-2 text-white/80">{selectedAttendee.tagline}</p>
                    <LinkedInProfileLink attendee={selectedAttendee} variant="dark" className="mt-4" />
                  </div>
                </div>
              </div>
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
                  selectedId={selectedAttendee.id}
                  attendeeById={attendeeById}
                  onSelect={handleSelect}
                  onStudy={studyRelationship}
                  expanded={deepDiveEdge ? relationshipEdgeKey(edge) === relationshipEdgeKey(deepDiveEdge) : false}
                  insight={deepDive}
                  loading={deepDiveLoading && deepDiveEdge ? relationshipEdgeKey(edge) === relationshipEdgeKey(deepDiveEdge) : false}
                  onCollapse={collapseRelationship}
                />
              ))}
            </div>
          </div>
        </div>
        )}

      </section>
    </div>
  );
}

function RelationshipCard({
  edge,
  selectedId,
  attendeeById,
  onSelect,
  onStudy,
  expanded,
  insight,
  loading,
  onCollapse,
}: {
  edge: RelationshipEdge;
  selectedId: number;
  attendeeById: Map<number, Attendee>;
  onSelect: (id: number | null) => void;
  onStudy: (edge: RelationshipEdge) => void;
  expanded: boolean;
  insight: RelationshipInsight | null;
  loading: boolean;
  onCollapse: () => void;
}) {
  const otherId = edge.source === selectedId ? edge.target : edge.source;
  const other = attendeeById.get(otherId);
  if (!other) return null;
  return (
    <article className={`rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${expanded ? "border-[#5583b7] ring-2 ring-[#8fb7e8]/40" : "border-slate-100"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <button className="flex items-center gap-3 text-left" onClick={(event) => { event.stopPropagation(); onSelect(otherId); }}>
          <FounderAvatar attendee={other} size="sm" />
          <span>
          <span className="block text-lg font-black text-[#0f1933]">{displayName(other)}</span>
          <p className="mt-1 text-sm text-slate-500">{humanize(edge.relationship_type)}</p>
          <LinkedInProfileLink attendee={other} className="mt-2" />
          </span>
        </button>
        <span className="rounded-full bg-[#4fb77c]/15 px-3 py-1 text-sm font-bold text-[#25734b]">{Math.round(edge.score * 100)}% fit</span>
      </div>
      <button className="mt-3 block w-full rounded-2xl bg-slate-50 p-3 text-left transition hover:bg-[#eef5ff]" onClick={() => onStudy(edge)}>
        <ul className="space-y-1 text-sm text-slate-600">
          {edge.reasons.slice(0, 3).map((reason) => (
            <li key={reason}>• {reason}</li>
          ))}
        </ul>
        <span className="mt-3 block text-sm font-semibold text-[#5583b7]">{expanded ? "Refresh relationship study" : "Study this relationship →"}</span>
      </button>
      {expanded && <RelationshipDeepDive edge={edge} insight={insight} loading={loading} attendeeById={attendeeById} onCollapse={onCollapse} />}
    </article>
  );
}

function RelationshipDeepDive({
  edge,
  insight,
  loading,
  attendeeById,
  onCollapse,
}: {
  edge: RelationshipEdge | null;
  insight: RelationshipInsight | null;
  loading: boolean;
  attendeeById: Map<number, Attendee>;
  onCollapse: () => void;
}) {
  if (!edge) return null;
  const source = attendeeById.get(edge.source);
  const target = attendeeById.get(edge.target);
  return (
    <section className="mt-5 rounded-[1.5rem] border border-[#8fb7e8]/30 bg-gradient-to-br from-slate-50 to-white p-5 shadow-inner">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[#cb5549]">Relationship deep dive</p>
          <h3 className="mt-2 text-2xl font-black">
            {source ? displayName(source) : `Attendee #${edge.source}`} × {target ? displayName(target) : `Attendee #${edge.target}`}
          </h3>
        </div>
        <button className="grid h-9 w-9 place-items-center self-start rounded-full border border-slate-200 bg-white text-lg font-black text-slate-600 transition hover:bg-slate-100" onClick={onCollapse} aria-label="Close relationship study">
          ×
        </button>
      </div>
      {loading && <p className="mt-4 rounded-2xl bg-slate-100 p-4 text-sm text-slate-600">Studying the relationship with AI...</p>}
      {insight && !loading && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-2xl bg-[#0f1933] p-5 text-white">
            <p className="text-xl font-black">{insight.headline}</p>
            <p className="mt-3 text-sm leading-6 text-white/80">{insight.openingMove}</p>
          </div>
          <InsightList title="Why it works" items={insight.whyItWorks} />
          <InsightList title="Watch outs" items={insight.watchOuts} />
          <InsightList title="Useful questions" items={insight.usefulQuestions} />
        </div>
      )}
    </section>
  );
}

function InsightList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
      <p className="font-black text-[#0f1933]">{title}</p>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
        {items.slice(0, 4).map((item) => <li key={item}>• {item}</li>)}
      </ul>
    </div>
  );
}

function relationshipEdgeKey(edge: RelationshipEdge) {
  return `${edge.source}-${edge.target}-${edge.relationship_type}`;
}

function buildRelationshipFallback(edge: RelationshipEdge, attendeeById: Map<number, Attendee>): RelationshipInsight {
  const source = attendeeById.get(edge.source);
  const target = attendeeById.get(edge.target);
  return {
    headline: `${humanize(edge.relationship_type)} with ${Math.round(edge.score * 100)}% fit`,
    openingMove: `Ask ${target ? displayName(target) : "the other attendee"} which part of ${source?.tagline ?? "this opportunity"} feels most useful or risky for their current work.`,
    whyItWorks: edge.reasons.slice(0, 3),
    watchOuts: ["Treat the score as a prompt, not a verdict.", "Check whether their current priorities match the inferred overlap before pitching."],
    usefulQuestions: [
      "What would make this collaboration useful in the next 30 days?",
      "Where do your assumptions about this market differ?",
      "Who else in the room would make this conversation stronger?",
    ],
    generated: false,
  };
}

function SignalCard({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="rounded-2xl bg-white/10 p-4 ring-1 ring-white/20">
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-white/60">{title}</p>
      <p className="mt-2 text-sm font-semibold text-white">{values.map(humanize).join(" · ")}</p>
    </div>
  );
}

function humanize(value: string) {
  return value.replace(/_/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function PairsPanel({
  attendees,
  question,
  onSubmit,
  result,
  onNext,
}: {
  attendees: Attendee[];
  question: string;
  onSubmit: (chosen: number[]) => void;
  result: string;
  onNext: () => void;
}) {
  const shown = attendees.slice(0, 8);
  const [picked, setPicked] = useState<number[]>([]);
  return (
    <section className="rounded-[2rem] border border-white/50 bg-white/90 p-6 shadow-xl shadow-slate-900/10 backdrop-blur">
      <p className="mb-3 text-sm uppercase tracking-wide">Pairs Game</p>
      <h2 className="text-xl font-semibold">{question}</h2>
      <p className="mt-2 text-sm text-slate-600">Generated from the named attendee pool with deterministic avatars because the dataset has no source photo URLs yet.</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-4">
        {shown.map((a) => {
          const on = picked.includes(a.id);
          return (
            <button
              key={a.id}
              onClick={() => setPicked((prev) => (on ? prev.filter((x) => x !== a.id) : [...prev, a.id]))}
              className={`rounded-2xl border p-3 text-left transition ${on ? "bg-[#5583b7] text-white shadow-lg shadow-[#5583b7]/20" : "bg-white hover:-translate-y-0.5"}`}
            >
              <FounderAvatar attendee={a} size="sm" />
              <p className="font-medium">{displayName(a)}</p>
              <p className="text-xs opacity-80">{a.category}</p>
              <LinkedInProfileLink attendee={a} className="mt-2" />
            </button>
          );
        })}
      </div>
      <button className="mt-4 rounded-xl bg-[#cb5549] px-3 py-2 text-white" onClick={() => onSubmit(picked)}>
        Check Answer
      </button>
      <button className="ml-2 mt-4 rounded-xl border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-700" onClick={onNext}>
        Next Question
      </button>
      {result && <p className="mt-3 rounded-xl bg-slate-100 p-2 text-sm">{result}</p>}
    </section>
  );
}
