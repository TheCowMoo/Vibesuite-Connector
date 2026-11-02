import type { PollResult, QaEntry, RegistrantRecord } from '../video/types';

/** The participant fields the behavior calculator needs. */
export interface BehaviorPerson {
  email?: string;
  name?: string;
  joinedAt?: string;
  leftAt?: string;
  durationSec?: number;
  attentivenessScore?: number;
  raw?: Record<string, unknown>;
}

export interface PollAnswer {
  question: string;
  answer: string;
}

export interface BehaviorQa {
  question: string;
  answer?: string;
  at?: string;
}

export interface RegistrationAnswer {
  question: string;
  answer: string;
}

export interface PollAnswerSummary {
  answer: string;
  count: number;
}

export interface PollQuestionSummary {
  question: string;
  respondents: number;
  answers: PollAnswerSummary[];
}

/**
 * Everything we can say about one person from the Zoom report.
 *
 * Raw provider ids stay out: the report/UI can still show the full participant payload separately,
 * while rules and AI only see the curated signals below.
 */
export interface ZoomBehavior {
  pollAnswers: PollAnswer[];
  qa: BehaviorQa[];
  registrationAnswers: RegistrationAnswer[];
  /** Every poll question present in the session, so "did not answer" is decidable. */
  pollQuestions: string[];
  pollQuestionCount: number;
  pollAnsweredCount: number;
  qaAskedCount: number;
  qaAnsweredCount: number;
  registrationAnswerCount: number;
  pollAnswerText: string;
  qaQuestionText: string;
  registrationAnswerText: string;
  joinedLateMinutes?: number;
  leftEarlyMinutes?: number;
  attendedPortionPct?: number;
  device?: string;
  location?: string;
  networkType?: string;
  microphone?: string;
  camera?: string;
  connectionType?: string;
  shareDesktop?: boolean;
  shareApplication?: boolean;
}

export interface ZoomBehaviorIndex {
  byEmail: Map<string, ZoomBehavior>;
  byName: Map<string, ZoomBehavior>;
  /** Distinct poll questions seen in this session. */
  pollQuestions: string[];
  pollRespondentCount: number;
  pollAnswerCount: number;
  /** Question-level answer counts for the session detail and "create rule from poll". */
  pollSummary: PollQuestionSummary[];
}

export interface BuildBehaviorInput {
  people: BehaviorPerson[];
  polls?: PollResult[];
  qa?: QaEntry[];
  registrants?: RegistrantRecord[];
  sessionStart?: string;
  sessionEnd?: string;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function normEmail(v: unknown): string | undefined {
  return str(v)?.toLowerCase();
}

function normName(v: unknown): string | undefined {
  return str(v)?.toLowerCase().replace(/\s+/g, ' ');
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'no' || s === '0') return false;
  }
  return undefined;
}

function rawStr(raw: Record<string, unknown> | undefined, key: string): string | undefined {
  return raw ? str(raw[key]) : undefined;
}

function behaviorBase(person: BehaviorPerson, sessionStart?: string, sessionEnd?: string): ZoomBehavior {
  const raw = person.raw ?? {};
  const start = Date.parse(sessionStart ?? '');
  const end = Date.parse(sessionEnd ?? '');
  const joined = Date.parse(person.joinedAt ?? '');
  const left = Date.parse(person.leftAt ?? '');

  let joinedLateMinutes: number | undefined;
  let leftEarlyMinutes: number | undefined;
  let attendedPortionPct: number | undefined;

  if (Number.isFinite(start) && Number.isFinite(joined)) {
    joinedLateMinutes = Math.max(0, Math.round((joined - start) / 60000));
  }
  if (Number.isFinite(end) && Number.isFinite(left)) {
    leftEarlyMinutes = Math.max(0, Math.round((end - left) / 60000));
  }
  if (Number.isFinite(start) && Number.isFinite(end) && end > start && person.durationSec !== undefined) {
    attendedPortionPct = Math.min(100, Math.round((person.durationSec / ((end - start) / 1000)) * 100));
  }

  return {
    pollAnswers: [],
    qa: [],
    registrationAnswers: [],
    pollQuestions: [],
    pollQuestionCount: 0,
    pollAnsweredCount: 0,
    qaAskedCount: 0,
    qaAnsweredCount: 0,
    registrationAnswerCount: 0,
    pollAnswerText: '',
    qaQuestionText: '',
    registrationAnswerText: '',
    joinedLateMinutes,
    leftEarlyMinutes,
    attendedPortionPct,
    device: rawStr(raw, 'device'),
    location: rawStr(raw, 'location'),
    networkType: rawStr(raw, 'network_type'),
    microphone: rawStr(raw, 'microphone'),
    camera: rawStr(raw, 'camera'),
    connectionType: rawStr(raw, 'connection_type'),
    shareDesktop: bool(raw.share_desktop),
    shareApplication: bool(raw.share_application),
  };
}

function pushPollAnswer(behavior: ZoomBehavior, question: string, answer: string): void {
  const q = question.trim();
  const a = answer.trim();
  if (!q || !a) return;
  if (behavior.pollAnswers.some((x) => x.question === q && x.answer === a)) return;
  behavior.pollAnswers.push({ question: q, answer: a });
}

function pushRegistration(behavior: ZoomBehavior, question: string, answer: string): void {
  const q = question.trim();
  const a = answer.trim();
  if (!q || !a) return;
  if (behavior.registrationAnswers.some((x) => x.question === q && x.answer === a)) return;
  behavior.registrationAnswers.push({ question: q, answer: a });
}

function registrationQuestions(row: RegistrantRecord): Array<{ question: string; answer: string }> {
  const raw = row as Record<string, unknown>;
  const candidates = [raw.custom_questions, raw.customQuestions, raw.questions];
  const out: Array<{ question: string; answer: string }> = [];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      if (!item || typeof item !== 'object') continue;
      const q = item as Record<string, unknown>;
      const question = str(q.title) ?? str(q.name) ?? str(q.question);
      const value = q.value ?? q.answer;
      const answer = Array.isArray(value) ? value.map(String).join(', ') : str(value);
      if (question && answer) out.push({ question, answer });
    }
  }
  return out;
}

/** Join the provider's per-person poll/Q&A/registration rows to the attendee list. */
export function buildZoomBehavior(input: BuildBehaviorInput): ZoomBehaviorIndex {
  const byEmail = new Map<string, ZoomBehavior>();
  const byName = new Map<string, ZoomBehavior>();
  const nameCounts = new Map<string, number>();

  for (const person of input.people) {
    const name = normName(person.name);
    if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  for (const person of input.people) {
    const email = normEmail(person.email);
    const name = normName(person.name);
    const behavior = behaviorBase(person, input.sessionStart, input.sessionEnd);
    if (email && !byEmail.has(email)) byEmail.set(email, behavior);
    if (name && nameCounts.get(name) === 1 && !byName.has(name)) byName.set(name, behavior);
  }

  const resolve = (emailRaw: unknown, nameRaw: unknown): ZoomBehavior | undefined => {
    const email = normEmail(emailRaw);
    if (email && byEmail.has(email)) return byEmail.get(email);
    const name = normName(nameRaw);
    if (name && byName.has(name)) return byName.get(name);
    return undefined;
  };

  const pollQuestions = new Set<string>();
  const respondents = new Set<string>();
  const sessionAnswers = new Set<string>();
  const summary = new Map<string, { respondents: Set<string>; answers: Map<string, number> }>();
  let pollAnswerCount = 0;

  const pollRows = input.polls ?? [];
  for (let rowIndex = 0; rowIndex < pollRows.length; rowIndex += 1) {
    const poll = pollRows[rowIndex];
    const details = Array.isArray(poll.question_details) ? poll.question_details : [];
    if (!details.length) continue;

    const identity = normEmail(poll.email) ?? normName(poll.name) ?? `row:${rowIndex}`;
    respondents.add(identity);

    const behavior = resolve(poll.email, poll.name);
    for (const detail of details) {
      const question = str(detail.question);
      const answer = str(detail.answer);
      if (question) pollQuestions.add(question);
      if (!question) continue;

      let questionSummary = summary.get(question);
      if (!questionSummary) {
        questionSummary = { respondents: new Set<string>(), answers: new Map<string, number>() };
        summary.set(question, questionSummary);
      }
      if (answer) questionSummary.respondents.add(identity);

      if (!answer) continue;
      const answerKey = `${identity}|${question}|${answer}`;
      if (!sessionAnswers.has(answerKey)) {
        sessionAnswers.add(answerKey);
        pollAnswerCount += 1;
        questionSummary.answers.set(answer, (questionSummary.answers.get(answer) ?? 0) + 1);
      }
      if (behavior) pushPollAnswer(behavior, question, answer);
    }
  }

  for (const entry of input.qa ?? []) {
    const question = str(entry.question);
    if (!question) continue;
    const behavior = resolve(entry.email, entry.name);
    if (!behavior) continue;
    const answer = str(entry.answer);
    if (behavior.qa.some((x) => x.question === question && (x.answer ?? '') === (answer ?? ''))) continue;
    behavior.qa.push({
      question,
      answer,
      at: str(entry.date_time) ?? str(entry.time) ?? str(entry.created_at),
    });
  }

  for (const row of input.registrants ?? []) {
    const fullName =
      str(row.name) ??
      ([str(row.first_name), str(row.last_name)].filter(Boolean).join(' ') || undefined);
    const behavior = resolve(row.email, fullName);
    if (!behavior) continue;
    for (const answer of registrationQuestions(row)) {
      pushRegistration(behavior, answer.question, answer.answer);
    }
  }

  for (const behavior of new Set([...byEmail.values(), ...byName.values()])) {
    const answered = new Set(behavior.pollAnswers.map((a) => a.question));
    behavior.pollQuestions = [...pollQuestions].sort((a, b) => a.localeCompare(b));
    behavior.pollQuestionCount = pollQuestions.size;
    behavior.pollAnsweredCount = answered.size;
    behavior.qaAskedCount = behavior.qa.length;
    behavior.qaAnsweredCount = behavior.qa.filter((q) => (q.answer ?? '').trim() !== '').length;
    behavior.registrationAnswerCount = behavior.registrationAnswers.length;
    behavior.pollAnswerText = behavior.pollAnswers.map((a) => `${a.question}: ${a.answer}`).join(' | ');
    behavior.qaQuestionText = behavior.qa.map((q) => q.question).join(' | ');
    behavior.registrationAnswerText = behavior.registrationAnswers
      .map((a) => `${a.question}: ${a.answer}`)
      .join(' | ');
  }

  return {
    byEmail,
    byName,
    pollQuestions: [...pollQuestions].sort((a, b) => a.localeCompare(b)),
    pollRespondentCount: respondents.size,
    pollAnswerCount,
    pollSummary: [...summary.entries()]
      .map(([question, item]) => ({
        question,
        respondents: item.respondents.size,
        answers: [...item.answers.entries()]
          .map(([answer, count]) => ({ answer, count }))
          .sort((a, b) => b.count - a.count || a.answer.localeCompare(b.answer)),
      }))
      .sort((a, b) => a.question.localeCompare(b.question)),
  };
}

/** Look up the behavior for a person (email first, then a unique name). */
export function behaviorFor(
  index: ZoomBehaviorIndex,
  email: string | undefined,
  name: string | undefined,
): ZoomBehavior | undefined {
  const e = normEmail(email);
  if (e && index.byEmail.has(e)) return index.byEmail.get(e);
  const n = normName(name);
  if (n && index.byName.has(n)) return index.byName.get(n);
  return undefined;
}
