import { Attendee, FactsChallenge, Mastery } from "@/lib/types";

export function displayName(attendee: Attendee): string {
  return (
    attendee.identified_person?.name ||
    attendee.likely_match?.name ||
    `Attendee #${attendee.id}`
  );
}

export function isUncertain(attendee: Attendee): boolean {
  const confidence =
    attendee.identified_person?.confidence ?? attendee.likely_match?.confidence ?? 0;
  return confidence < 0.75;
}

export function pickNewAndWeak(
  attendees: Attendee[],
  mastery: Mastery,
  count = 3,
): Attendee[] {
  const sorted = [...attendees].sort((a, b) => {
    const ma = mastery[a.id] ?? 0;
    const mb = mastery[b.id] ?? 0;
    return ma - mb;
  });

  const unseen = sorted.filter((a) => (mastery[a.id] ?? 0) === 0);
  const weak = sorted.filter((a) => (mastery[a.id] ?? 0) < 100);

  const chosen: Attendee[] = [];
  if (unseen.length > 0) {
    chosen.push(unseen[Math.floor(Math.random() * unseen.length)]);
  }
  for (const item of weak) {
    if (chosen.length >= count) break;
    if (!chosen.find((c) => c.id === item.id)) chosen.push(item);
  }
  return chosen.slice(0, count);
}

export function buildEasyOptions(pool: Attendee[], target: Attendee): Attendee[] {
  const others = pool.filter((a) => a.id !== target.id);
  const distractors = shuffle(others).slice(0, 2);
  return shuffle([target, ...distractors]);
}

export function buildFactsChallenge(attendee: Attendee): FactsChallenge {
  const facts = (attendee.extra_facts ?? []).map((x) => x.fact).slice(0, 3);
  while (facts.length < 2) {
    facts.push("Enjoys building startup projects from scratch.");
  }
  const lie = `Has never worked with teams outside Ireland.`;
  const options = shuffle([...facts.slice(0, 2), lie]);
  return { options, lieIndex: options.findIndex((x) => x === lie) };
}

export function scoreRound(opts: {
  nameCorrect: boolean;
  factsCorrectCount: number;
  speedScore: number;
  hintsUsed: number;
}): number {
  const raw =
    (opts.nameCorrect ? 50 : 0) +
    Math.max(0, Math.min(2, opts.factsCorrectCount)) * 15 +
    Math.round(5 * opts.speedScore) -
    opts.hintsUsed * 5;
  return Math.max(0, raw);
}

export function updateMastery(current: number, correct: boolean): number {
  if (correct) return Math.min(100, current + 20);
  return Math.max(0, current - 10);
}

export function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
