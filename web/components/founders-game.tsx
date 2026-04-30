"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildEasyOptions,
  buildFactsChallenge,
  displayName,
  isUncertain,
  pickNewAndWeak,
  sanitizeFactForAttendee,
  scoreRound,
  shuffle,
  updateMastery,
} from "@/lib/game";
import { beginLogin, clearTokens, getTokens, logout } from "@/lib/auth";
import { loadRuntimeConfig, RuntimeConfig } from "@/lib/runtime-config";
import { Attendee, FactsChallenge, IdeaExplorerInsight, Mastery, MatchData, RelationshipEdge, RelationshipInsight } from "@/lib/types";

type Mode = "learn" | "play-easy" | "play-hard" | "pairs";
type AppView = "chooser" | "guess-who" | "match-maker" | "idea-explorer";
type PairChallenge = { question: string; answerIds: number[]; explanation?: string };
type PreparedPairsQuestion = { pool: Attendee[]; challenge: PairChallenge };

const STORAGE_KEY = "ff-game-progress-v1";
const MATCH_RELATIONSHIP_FILTERS = [
  { value: "all", label: "All match relationships" },
  { value: "cofounder", label: "Cofounder fits" },
  { value: "commercial-technical", label: "Commercial + technical" },
  { value: "domain", label: "Shared domain peers" },
  { value: "strategic", label: "Strategic partners" },
] as const;

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
  const [pairPool, setPairPool] = useState<Attendee[]>([]);
  const [pairLoading, setPairLoading] = useState(false);
  const [preloadedPair, setPreloadedPair] = useState<PreparedPairsQuestion | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [appView, setAppView] = useState<AppView>("chooser");
  const [matchData, setMatchData] = useState<MatchData | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null);
  const [ideaText, setIdeaText] = useState("");
  const [ideaInsight, setIdeaInsight] = useState<IdeaExplorerInsight | null>(null);
  const [ideaLoading, setIdeaLoading] = useState(false);
  const [ideaError, setIdeaError] = useState("");

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
    if (!authLoaded || !isSignedIn) return;
    function checkToken() {
      if (getTokens()) return;
      setIsSignedIn(false);
      setAppView("chooser");
    }
    const interval = window.setInterval(checkToken, 60_000);
    window.addEventListener("focus", checkToken);
    document.addEventListener("visibilitychange", checkToken);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkToken);
      document.removeEventListener("visibilitychange", checkToken);
    };
  }, [authLoaded, isSignedIn]);

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
          options: facts.map((fact) => sanitizeFactForAttendee(fact.text, target)),
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

  async function createPairsQuestion() {
    setPairResult("");
    if (preloadedPair) {
      applyPairsQuestion(preloadedPair);
      setPreloadedPair(null);
      void preloadPairsQuestion();
      return;
    }
    setPairLoading(true);
    setPairQuestion("");
    const prepared = await preparePairsQuestion();
    applyPairsQuestion(prepared);
    setPairLoading(false);
    void preloadPairsQuestion();
  }

  function applyPairsQuestion(prepared: PreparedPairsQuestion) {
    setPairPool(prepared.pool);
    setPairQuestion(prepared.challenge.question);
    setPairAnswers(prepared.challenge.answerIds);
    setPairKey((key) => key + 1);
  }

  async function preloadPairsQuestion() {
    if (preloadedPair || !attendees.length) return;
    setPreloadedPair(await preparePairsQuestion());
  }

  async function preparePairsQuestion(): Promise<PreparedPairsQuestion> {
    const pool = shuffleForPrompt(attendees).slice(0, 8);
    const fallback = buildLocalPairsChallenge(pool);
    const tokens = getTokens();
    if (!runtimeConfig || !tokens?.access_token) return { pool, challenge: fallback };
    try {
      const response = await fetch(`${runtimeConfig.apiBaseUrl}ai/pairs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ profiles: pool }),
      });
      if (!response.ok) return { pool, challenge: fallback };
      const generated = (await response.json()) as { question?: string; answerIds?: number[] };
      if (generated.question && generated.answerIds?.length) {
        return { pool, challenge: { question: generated.question, answerIds: generated.answerIds } };
      }
    } catch {
      // Local category fallback remains active after loading.
    }
    return { pool, challenge: fallback };
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

  async function exploreIdea() {
    const trimmedIdea = ideaText.trim();
    if (!trimmedIdea) {
      setIdeaError("Describe the idea or problem first.");
      return;
    }
    setIdeaLoading(true);
    setIdeaError("");
    setIdeaInsight(null);
    const tokens = getTokens();
    if (!runtimeConfig || !tokens?.access_token) {
      setIdeaLoading(false);
      setIdeaError("Sign in again before using Idea Explorer.");
      return;
    }
    try {
      const response = await fetch(`${runtimeConfig.apiBaseUrl}ai/idea-explorer`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ idea: trimmedIdea, profiles: attendees }),
      });
      if (!response.ok) throw new Error("Idea Explorer endpoint unavailable");
      setIdeaInsight((await response.json()) as IdeaExplorerInsight);
    } catch {
      setIdeaError("Idea Explorer is unavailable right now. Try again in a minute.");
    } finally {
      setIdeaLoading(false);
    }
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
              <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#cb5549]">Founders. Faces. Names. Matches.</p>
              <h1 className="mt-3 text-4xl font-black tracking-tight text-[#0f1933] sm:text-6xl">
                Future founders 2026
              </h1>
              <p className="mt-4 max-w-2xl text-lg text-slate-600">
                Learn faces and facts, then study the compatibility map to spot warm intros, cofounder fits, and useful conversation angles.
              </p>
            </div>
            <SignOutButton onClick={handleSignOut} />
          </div>
        </header>

        <div className="mt-6 grid gap-5 lg:grid-cols-3">
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
            <span className="mt-8 inline-flex rounded-full bg-white px-5 py-3 font-semibold text-[#9b352d] transition group-hover:bg-[#0f1933] group-hover:text-white">Discover matches</span>
          </button>

          <button
            className="group rounded-[2rem] bg-white p-7 text-left text-[#0f1933] shadow-2xl shadow-slate-900/10 ring-1 ring-white/70 transition hover:-translate-y-1 hover:shadow-slate-900/15"
            onClick={() => setAppView("idea-explorer")}
          >
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-[#4fb77c]">Idea Explorer</p>
            <h2 className="mt-4 text-3xl font-black">Find who to ask about an idea</h2>
            <p className="mt-3 text-slate-600">Describe a business idea or customer problem, then get founder matches, reasons, and questions to ask.</p>
            <span className="mt-8 inline-flex rounded-full bg-[#0f1933] px-5 py-3 font-semibold text-white transition group-hover:bg-[#4fb77c]">Explore privately</span>
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
              <h1 className="text-3xl font-black">{appView === "guess-who" ? "Guess Who" : appView === "match-maker" ? "Match Maker" : "Idea Explorer"}</h1>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className={`rounded-full px-4 py-2 text-sm font-semibold ${appView === "guess-who" ? "bg-[#0f1933] text-white" : "bg-white text-slate-700"}`} onClick={() => setAppView("guess-who")}>Guess Who</button>
              <button className={`rounded-full px-4 py-2 text-sm font-semibold ${appView === "match-maker" ? "bg-[#cb5549] text-white" : "bg-white text-slate-700"}`} onClick={openMatchMaker}>Match Maker</button>
              <button className={`rounded-full px-4 py-2 text-sm font-semibold ${appView === "idea-explorer" ? "bg-[#4fb77c] text-white" : "bg-white text-slate-700"}`} onClick={() => setAppView("idea-explorer")}>Idea Explorer</button>
              <SignOutButton onClick={handleSignOut} />
            </div>
          </div>

          {appView === "guess-who" && (
            <>
          <p className="mt-1 text-sm text-slate-600">
            Score: <strong>{score}</strong> | Learned: {studyPool.filter((a) => (mastery[a.id] ?? 0) > 0).length}/{studyPool.length} named profiles
          </p>
          <div className="mt-4 grid gap-2 rounded-2xl bg-slate-100 p-2 sm:grid-cols-4">
            <GuessWhoModeButton active={mode === "learn"} color="blue" label="Learn" detail="Study cards" onClick={() => setMode("learn")} />
            <GuessWhoModeButton active={mode === "play-easy"} color="green" label="Play Easy" detail="Pick a name" onClick={() => startPlay("play-easy")} />
            <GuessWhoModeButton active={mode === "play-hard"} color="navy" label="Play Hard" detail="Type recall" onClick={() => startPlay("play-hard")} />
            <GuessWhoModeButton active={mode === "pairs"} color="red" label="Pairs" detail="Match traits" onClick={() => { setMode("pairs"); createPairsQuestion(); }} />
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

        {appView === "idea-explorer" && (
          <IdeaExplorerPanel
            attendees={attendees}
            profileCount={attendees.length}
            ideaText={ideaText}
            onIdeaTextChange={setIdeaText}
            insight={ideaInsight}
            loading={ideaLoading}
            error={ideaError}
            onSubmit={exploreIdea}
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
                  placeholder="Type first name..."
                  className="w-full rounded-xl border px-3 py-2"
                />
                <button
                  className="mt-2 rounded-xl bg-[#1e2d40] px-3 py-2 text-white"
                  onClick={() => submitPlay(hardGuess.trim().toLowerCase() === firstName(playTarget).toLowerCase())}
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
          <PairsPanel key={pairKey} attendees={pairPool} question={pairQuestion} loading={pairLoading} onSubmit={scorePairs} result={pairResult} onNext={createPairsQuestion} />
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
  relationshipFilters,
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
  relationshipFilters: typeof MATCH_RELATIONSHIP_FILTERS;
  onClusterFilter: (cluster: string) => void;
  onTypeFilter: (type: string) => void;
  onSelect: (id: number | null) => void;
}) {
  const topNodes = attendees;
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
  const graphEdges = edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target));
  return (
    <section className="rounded-[2rem] border border-white/50 bg-white/90 p-5 shadow-xl shadow-slate-900/10 backdrop-blur">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[#5583b7]">Relationship graph</p>
          <h3 className="mt-2 text-2xl font-black">Filter the room by cluster and match relationship.</h3>
        </div>
        <div>
          <select className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold" value={typeFilter} onChange={(event) => onTypeFilter(event.target.value)}>
            {relationshipFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
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

function founderDisplayName(attendee: Attendee) {
  return attendeePhoto(attendee) && linkedinUrl(attendee) ? displayName(attendee) : `Founder ${attendee.id}`;
}

function firstName(attendee: Attendee) {
  return displayName(attendee).split(/\s+/u).filter(Boolean)[0] ?? displayName(attendee);
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

function FounderAvatar({ attendee, size = "md" }: { attendee: Attendee; size?: "sm" | "md" | "lg" | "xl" }) {
  const photo = attendeePhoto(attendee);
  const sizeClass = size === "xl" ? "h-56 w-56 text-5xl" : size === "lg" ? "h-20 w-20 text-2xl" : size === "sm" ? "h-10 w-10 text-sm" : "h-14 w-14 text-lg";
  if (photo) {
    return <div className={`${sizeClass} rounded-full bg-cover bg-center shadow-inner ring-2 ring-white`} style={{ backgroundImage: `url(${photo})` }} aria-label={`${founderDisplayName(attendee)} photo`} />;
  }
  return (
    <div
      className={`${sizeClass} grid shrink-0 place-items-center rounded-full bg-slate-200 text-slate-500 shadow-inner ring-1 ring-white/70`}
      aria-label={`${founderDisplayName(attendee)} silhouette avatar`}
    >
      <svg className="h-1/2 w-1/2" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4Zm0 2c-3.33 0-6 1.67-6 3.75V20h12v-2.25C18 15.67 15.33 14 12 14Z" />
      </svg>
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
      <div className="relative mx-auto max-w-6xl">
        {children}
        <footer className="mt-8 text-center text-xs font-semibold text-slate-500">
          Created for fun by <span className="line-through">prisoner</span> founder #16 (Lyndon Leggate)
        </footer>
      </div>
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

function GuessWhoModeButton({
  active,
  color,
  label,
  detail,
  onClick,
}: {
  active: boolean;
  color: "blue" | "green" | "navy" | "red";
  label: string;
  detail: string;
  onClick: () => void;
}) {
  const activeColors = {
    blue: "bg-[#5583b7] shadow-[#5583b7]/25",
    green: "bg-[#4fb77c] shadow-[#4fb77c]/25",
    navy: "bg-[#1e2d40] shadow-[#1e2d40]/25",
    red: "bg-[#cb5549] shadow-[#cb5549]/25",
  };
  return (
    <button
      className={`rounded-xl px-4 py-3 text-left transition ${
        active
          ? `${activeColors[color]} text-white shadow-lg ring-2 ring-white`
          : "bg-white text-slate-600 hover:-translate-y-0.5 hover:bg-slate-50"
      }`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className="block font-black">{label}</span>
      <span className={`mt-1 block text-xs ${active ? "text-white/75" : "text-slate-400"}`}>{active ? "Current mode" : detail}</span>
    </button>
  );
}

function LoginScreen({ runtimeConfig }: { runtimeConfig: RuntimeConfig | null }) {
  return (
    <Shell>
      <section className="mx-auto mt-20 max-w-2xl rounded-[2.25rem] border border-white/50 bg-white/90 p-8 text-center shadow-2xl shadow-slate-900/15 backdrop-blur sm:p-12">
          <p className="text-sm font-semibold uppercase tracking-[0.35em] text-[#cb5549]">Founders. Faces. Names. Matches.</p>
          <h1 className="mt-5 text-5xl font-black tracking-tight text-[#0f1933] sm:text-6xl">
            Future Founders 2026
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
      </section>
    </Shell>
  );
}

function IdeaExplorerPanel({
  attendees,
  profileCount,
  ideaText,
  onIdeaTextChange,
  insight,
  loading,
  error,
  onSubmit,
}: {
  attendees: Attendee[];
  profileCount: number;
  ideaText: string;
  onIdeaTextChange: (value: string) => void;
  insight: IdeaExplorerInsight | null;
  loading: boolean;
  error: string;
  onSubmit: () => void;
}) {
  const attendeeById = useMemo(() => new Map(attendees.map((attendee) => [attendee.id, attendee])), [attendees]);
  return (
    <section className="overflow-hidden rounded-[2rem] border border-white/50 bg-white/90 shadow-xl shadow-slate-900/10 backdrop-blur">
      <div className="grid gap-0 lg:grid-cols-[1fr_20rem]">
        <div className="p-7">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-[#4fb77c]">Idea Explorer</p>
          <h2 className="mt-3 text-4xl font-black tracking-tight text-[#0f1933]">Find the best founders to ask.</h2>
          <p className="mt-4 max-w-2xl text-slate-600">
            Paste a business idea, customer problem, or market thesis. The AI compares it with all named founder profiles and returns who to speak to, why, and what to ask.
          </p>

          <form
            className="mt-6"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <label className="text-sm font-bold text-[#0f1933]" htmlFor="idea-explorer-input">Your idea or problem</label>
            <textarea
              id="idea-explorer-input"
              className="mt-2 min-h-36 w-full rounded-2xl border border-slate-200 bg-white p-4 text-base leading-7 text-slate-700 shadow-inner outline-none transition focus:border-[#4fb77c] focus:ring-4 focus:ring-[#4fb77c]/15"
              value={ideaText}
              onChange={(event) => onIdeaTextChange(event.target.value)}
              placeholder="Example: AI workflow tooling for small finance teams that still run client reporting in spreadsheets..."
            />
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                className="rounded-full bg-[#4fb77c] px-6 py-3 font-bold text-white shadow-xl shadow-[#4fb77c]/20 transition hover:-translate-y-0.5 hover:bg-[#0f1933] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                disabled={loading}
                type="submit"
              >
                {loading ? "Finding matches..." : "Find founder matches"}
              </button>
              <p className="text-sm text-slate-500">Uses all {profileCount} founder profiles. Your idea and matches are not stored anywhere.</p>
            </div>
          </form>

          {error && <p className="mt-4 rounded-2xl bg-amber-100 p-4 text-sm font-semibold text-amber-900">{error}</p>}
        </div>

        <div className="bg-gradient-to-br from-[#0f1933] via-[#284b76] to-[#4fb77c] p-7 text-white">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-white/65">Privacy guardrails</p>
          <ul className="mt-5 space-y-4 text-sm leading-6 text-white/85">
            <li><strong>Not stored anywhere.</strong> Your idea is used only for this request.</li>
            <li><strong>No saved matches.</strong> Generated matches and explanations stay on this screen.</li>
          </ul>
        </div>
      </div>

      {loading && <p className="mx-7 mb-7 rounded-2xl bg-slate-100 p-4 text-sm text-slate-600">Thinking across the founder profiles...</p>}

      {insight && !loading && (
        <div className="border-t border-slate-100 p-7">
          <div className="rounded-[1.75rem] bg-[#0f1933] p-6 text-white">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-white/55">Explorer result</p>
            <h3 className="mt-2 text-3xl font-black">{insight.headline}</h3>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-white/80">{insight.summary}</p>
            <p className="mt-4 rounded-2xl bg-white/10 p-3 text-sm text-white/80">{insight.privacyNote}</p>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {insight.recommendations.map((recommendation) => {
              const attendee = attendeeById.get(recommendation.attendeeId);
              return (
                <article key={recommendation.attendeeId} className="rounded-[1.5rem] border border-slate-100 bg-white p-5 shadow-sm">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-center gap-3">
                      {attendee && <FounderAvatar attendee={attendee} size="sm" />}
                      <div>
                        <h4 className="text-xl font-black text-[#0f1933]">{attendee ? founderDisplayName(attendee) : recommendation.name}</h4>
                        {attendee && <p className="mt-1 text-sm text-slate-500">{attendee.tagline}</p>}
                        {attendee && <LinkedInProfileLink attendee={attendee} className="mt-2" />}
                      </div>
                    </div>
                    <span className="self-start rounded-full bg-[#4fb77c]/15 px-3 py-1 text-sm font-bold text-[#25734b]">{recommendation.relevance}</span>
                  </div>
                  <div className="mt-5 grid gap-4 md:grid-cols-3">
                    <InsightList title="Why useful" items={recommendation.why} />
                    <InsightList title="What to ask" items={recommendation.questions} />
                    <InsightList title="Evidence" items={recommendation.evidence} />
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
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
  const [profileExpanded, setProfileExpanded] = useState(false);
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
  const clusterMemberIds = useMemo(() => clusterMemberSet(clusterFilter, clusters), [clusterFilter, clusters]);
  const visibleAttendees = useMemo(
    () => attendees.filter((attendee) => !clusterMemberIds || clusterMemberIds.has(attendee.id)),
    [attendees, clusterMemberIds],
  );
  const visibleEdges = useMemo(
    () =>
      (matchData?.relationship_edges ?? [])
        .filter((edge) => isHighPotentialMatchEdge(edge, profileById))
        .filter((edge) => matchesRelationshipFilter(edge, typeFilter))
        .filter((edge) => !clusterMemberIds || (clusterMemberIds.has(edge.source) && clusterMemberIds.has(edge.target)))
        .sort((a, b) => b.score - a.score),
    [clusterMemberIds, matchData, profileById, typeFilter],
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
    setProfileExpanded(false);
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
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-[#cb5549]">Founders</p>
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
                <span className="min-w-0">
                  <p className="font-bold">{founderDisplayName(attendee)}</p>
                  <p className={`mt-1 truncate text-xs ${active ? "text-white/70" : "text-slate-500"}`}>{attendee.tagline}</p>
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
          relationshipFilters={MATCH_RELATIONSHIP_FILTERS}
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
                <p className="text-sm font-semibold uppercase tracking-[0.3em] text-white/65">Founder profile</p>
                <div className="mt-3 flex items-center gap-4">
                  <FounderAvatar attendee={selectedAttendee} size="lg" />
                  <div>
                    <h2 className="text-4xl font-black">{founderDisplayName(selectedAttendee)}</h2>
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
            <button
              className="mt-5 rounded-full bg-white px-5 py-3 text-sm font-black text-[#0f1933] shadow-lg shadow-slate-900/15 transition hover:-translate-y-0.5 hover:bg-[#f0c36a]"
              onClick={() => setProfileExpanded((expanded) => !expanded)}
            >
              {profileExpanded ? "Collapse founder details" : "Learn more about this founder"}
            </button>
          </div>
          {profileExpanded && <FounderProfileDetails attendee={selectedAttendee} />}
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
          <span className="block text-lg font-black text-[#0f1933]">{founderDisplayName(other)}</span>
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
        <span className="mt-3 block text-sm font-semibold text-[#5583b7]">{expanded ? "Refresh pairing insight" : "Generate pairing insight →"}</span>
      </button>
      {expanded && <RelationshipDeepDive edge={edge} insight={insight} loading={loading} attendeeById={attendeeById} onCollapse={onCollapse} />}
    </article>
  );
}

function FounderProfileDetails({ attendee }: { attendee: Attendee }) {
  const highlights = attendee.profile_summary?.experience_highlights ?? [];
  const interests = attendee.profile_summary?.interests ?? [];
  const facts = attendee.extra_facts ?? [];
  const starters = attendee.conversation_starters ?? [];
  return (
    <section className="border-b border-slate-100 bg-gradient-to-br from-white to-slate-50 p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[#5583b7]">Known profile details</p>
          <h3 className="mt-2 text-2xl font-black text-[#0f1933]">More about {founderDisplayName(attendee)}</h3>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {attendee.profile_summary?.background && (
          <DetailBlock title="Background" items={[attendee.profile_summary.background]} />
        )}
        {attendee.current_obsession && (
          <DetailBlock title={`Current obsession${attendee.current_obsession.summary ? `: ${attendee.current_obsession.summary}` : ""}`} items={[attendee.current_obsession.details ?? attendee.current_obsession.summary ?? ""]} />
        )}
        {attendee.superpower && (
          <DetailBlock title={`Superpower${attendee.superpower.summary ? `: ${attendee.superpower.summary}` : ""}`} items={[attendee.superpower.details ?? attendee.superpower.summary ?? ""]} />
        )}
        {highlights.length > 0 && <DetailBlock title="Experience highlights" items={highlights} />}
        {interests.length > 0 && <DetailBlock title="Interests" items={interests} />}
        {(attendee.ideal_cofounder?.traits ?? []).length > 0 && <DetailBlock title="Ideal cofounder" items={attendee.ideal_cofounder?.traits ?? []} />}
        {(attendee.surprising_traits?.items ?? []).length > 0 && <DetailBlock title="Surprising traits" items={attendee.surprising_traits?.items ?? []} />}
        {facts.length > 0 && <DetailBlock title="Useful facts" items={facts.map((fact) => fact.use_for_conversation ? `${fact.fact} — ${fact.use_for_conversation}` : fact.fact)} />}
        {starters.length > 0 && <DetailBlock title="Conversation starters" items={starters} />}
      </div>
    </section>
  );
}

function DetailBlock({ title, items }: { title: string; items: string[] }) {
  const visibleItems = items.filter(Boolean).slice(0, 5);
  if (!visibleItems.length) return null;
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
      <p className="font-black text-[#0f1933]">{title}</p>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
        {visibleItems.map((item) => <li key={item}>• {item}</li>)}
      </ul>
    </div>
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
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-[#cb5549]">Pairing insight</p>
          <h3 className="mt-2 text-2xl font-black">
            {source ? founderDisplayName(source) : `Founder ${edge.source}`} × {target ? founderDisplayName(target) : `Founder ${edge.target}`}
          </h3>
          {insight?.cached && <p className="mt-2 text-sm font-semibold text-[#25734b]">Cached insight</p>}
        </div>
        <button className="grid h-9 w-9 place-items-center self-start rounded-full border border-slate-200 bg-white text-lg font-black text-slate-600 transition hover:bg-slate-100" onClick={onCollapse} aria-label="Close relationship study">
          ×
        </button>
      </div>
      {loading && <p className="mt-4 rounded-2xl bg-slate-100 p-4 text-sm text-slate-600">Generating pairing insight with AI...</p>}
      {insight && !loading && (
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-2xl bg-[#0f1933] p-5 text-white">
            <p className="text-xl font-black">{insight.headline}</p>
            <p className="mt-4 text-xs font-bold uppercase tracking-[0.2em] text-white/50">Cofounder fit</p>
            <p className="mt-3 text-sm leading-6 text-white/80">{insight.cofounder_fit}</p>
          </div>
          <InsightList title="Common ground" items={insight.common_ground} />
          <InsightList title="Conversation starters" items={insight.conversation_starters} />
          <InsightList title="Business opportunities" items={insight.business_opportunities} />
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

function isHighPotentialMatchEdge(edge: RelationshipEdge, profileById: Map<number, { high_potential_matches: number[] }>) {
  const sourceProfile = profileById.get(edge.source);
  const targetProfile = profileById.get(edge.target);
  return Boolean(
    sourceProfile?.high_potential_matches.includes(edge.target) ||
    targetProfile?.high_potential_matches.includes(edge.source),
  );
}

function matchesRelationshipFilter(edge: RelationshipEdge, filter: string) {
  if (filter === "all") return true;
  const type = edge.relationship_type;
  if (filter === "cofounder") return /cofounder|complement|operator_builder|build_partner/u.test(type);
  if (filter === "commercial-technical") return /commercial|technical|gtm|builder/u.test(type);
  if (filter === "domain") return /peer|domain|climate|deeptech|health|energy|fintech|enterprise|hardware|systems/u.test(type);
  if (filter === "strategic") return /strategic|venture|partner|commercialisation|strategy/u.test(type);
  return true;
}

function clusterMemberSet(clusterFilter: string, clusters: MatchData["insight_dimensions"]["highest_domain_density_clusters"]) {
  if (clusterFilter === "all") return null;
  return new Set((clusters ?? []).find((cluster) => cluster.cluster === clusterFilter)?.members ?? []);
}

function buildRelationshipFallback(edge: RelationshipEdge, attendeeById: Map<number, Attendee>): RelationshipInsight {
  const source = attendeeById.get(edge.source);
  const target = attendeeById.get(edge.target);
  return {
    headline: `${humanize(edge.relationship_type)} with ${Math.round(edge.score * 100)}% fit`,
    common_ground: edge.reasons.slice(0, 3),
    cofounder_fit: `Ask ${target ? founderDisplayName(target) : "the other founder"} which part of ${source?.tagline ?? "this opportunity"} feels most useful or risky for their current work. Treat the score as a prompt, not a verdict.`,
    conversation_starters: [
      "What would make this connection useful in the next 30 days?",
      "Where do your assumptions about this market differ?",
      "Which skill gap would be most valuable to close with a collaborator?",
    ],
    business_opportunities: [
      "A focused validation sprint around the strongest shared customer or domain signal in their profiles.",
      "A lightweight tool or service that combines one founder's domain access with the other's execution strengths.",
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
  loading,
  onSubmit,
  result,
  onNext,
}: {
  attendees: Attendee[];
  question: string;
  loading: boolean;
  onSubmit: (chosen: number[]) => void;
  result: string;
  onNext: () => void;
}) {
  const shown = attendees.slice(0, 8);
  const [picked, setPicked] = useState<number[]>([]);
  if (loading || !question) {
    return (
      <section className="rounded-[2rem] border border-white/50 bg-white/90 p-8 text-center shadow-xl shadow-slate-900/10 backdrop-blur">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#cb5549]/10 text-[#cb5549]">
          <div className="h-7 w-7 animate-spin rounded-full border-4 border-[#cb5549]/20 border-t-[#cb5549]" />
        </div>
        <p className="mt-5 text-sm font-semibold uppercase tracking-[0.25em] text-[#cb5549]">Pairs Game</p>
        <h2 className="mt-2 text-2xl font-black text-[#0f1933]">Preparing a question...</h2>
      </section>
    );
  }
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
              className={`rounded-2xl border p-3 text-left transition ${on ? "bg-[#5583b7] text-white shadow-lg shadow-[#5583b7]/20" : "bg-white hover:-translate-y-0.5"}`}
            >
              <FounderAvatar attendee={a} size="sm" />
              <p className="font-medium">{founderDisplayName(a)}</p>
              <p className="line-clamp-2 text-xs opacity-80">{a.tagline}</p>
              <LinkedInProfileLink attendee={a} className="mt-2" />
            </button>
          );
        })}
      </div>
      <button className="mt-4 rounded-xl bg-[#cb5549] px-3 py-2 text-white" onClick={() => onSubmit(picked)}>
        Check Answer
      </button>
      <button className="ml-2 mt-4 rounded-xl border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-700" onClick={() => { setPicked([]); onNext(); }}>
        Next Question
      </button>
      {result && <p className="mt-3 rounded-xl bg-slate-100 p-2 text-sm">{result}</p>}
    </section>
  );
}
