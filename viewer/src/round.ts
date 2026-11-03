// Scorecard: the round in progress and finished rounds, kept on the phone.

export interface HoleScore {
  strokes: number;
  putts: number | null;
}

export interface Round {
  id: string;
  course: string;
  courseName: string;
  tee: string;
  startedAt: string;
  pars: Record<number, number | null>;
  scores: Record<number, HoleScore>;
}

interface Store {
  current: Round | null;
  past: Round[];
}

const KEY = "golffly.rounds.v1";

function read(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Store | null;
    if (s && Array.isArray(s.past)) return s;
  } catch {
    // start fresh
  }
  return { current: null, past: [] };
}

const store = read();
const write = () => localStorage.setItem(KEY, JSON.stringify(store));

export const currentRound = () => store.current;
export const pastRounds = () => store.past;

export function startRound(course: string, courseName: string, tee: string, pars: Record<number, number | null>): Round {
  if (store.current && Object.keys(store.current.scores).length) store.past.unshift(store.current);
  store.current = { id: `${Date.now()}`, course, courseName, tee, startedAt: new Date().toISOString(), pars, scores: {} };
  write();
  return store.current;
}

export function setScore(hole: number, score: HoleScore | null) {
  if (!store.current) return;
  if (score) store.current.scores[hole] = score;
  else delete store.current.scores[hole];
  write();
}

export function finishRound() {
  if (store.current && Object.keys(store.current.scores).length) store.past.unshift(store.current);
  store.current = null;
  write();
}

export function deleteRound(id: string) {
  store.past = store.past.filter((r) => r.id !== id);
  write();
}

export interface Totals {
  strokes: number;
  par: number;
  played: number;
  putts: number;
}

export function totals(round: Round, holes: number[] = Object.keys(round.scores).map(Number)): Totals {
  const t: Totals = { strokes: 0, par: 0, played: 0, putts: 0 };
  for (const n of holes) {
    const s = round.scores[n];
    if (!s) continue;
    t.strokes += s.strokes;
    t.par += round.pars[n] ?? 0;
    t.putts += s.putts ?? 0;
    t.played++;
  }
  return t;
}

export const toPar = (t: Totals) => {
  const d = t.strokes - t.par;
  return d === 0 ? "E" : d > 0 ? `+${d}` : `${d}`;
};
