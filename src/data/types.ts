/**
 * Types for the BEAM dataset, as it actually ships in
 * github.com/mohammadtavakoli78/BEAM (verified against the repo, not the README).
 *
 * Two layers:
 *   - `BeamRaw*`  — the on-disk shape of chats/<tier>/<id>/chat.json
 *   - the rest    — the normalized shape the harness ingests
 *
 * See docs/design.md §1 and §3 for why the normalization exists.
 */

export const BEAM_TIERS = ['100K', '500K', '1M', '10M'] as const;
export type BeamTier = (typeof BEAM_TIERS)[number];

/** The ten memory abilities. These are the keys of probing_questions.json. */
export const BEAM_ABILITIES = [
  'abstention',
  'contradiction_resolution',
  'event_ordering',
  'information_extraction',
  'instruction_following',
  'knowledge_update',
  'multi_session_reasoning',
  'preference_following',
  'summarization',
  'temporal_reasoning',
] as const;
export type BeamAbility = (typeof BEAM_ABILITIES)[number];

// ---------------------------------------------------------------------------
// Raw on-disk shapes
// ---------------------------------------------------------------------------

export type BeamQuestionRole = 'main_question' | 'followup_question' | 'answer_ai_question';

export interface BeamRawMessage {
  role: 'user' | 'assistant';
  id: number;
  content: string;
  /** e.g. "March-15-2024". Present only on the message that opens a batch. */
  time_anchor?: string;
  /** e.g. "1,1" — generator bookkeeping, also appended to content as "->-> 1,1". */
  index?: string;
  question_type?: BeamQuestionRole;
}

/** A turn is a mini-session, usually 4 messages (user/assistant/user/assistant). */
export type BeamRawTurn = BeamRawMessage[];

export interface BeamRawBatch {
  batch_number: number;
  turns: BeamRawTurn[];
  /** Batch-level date anchor. Often null; the real anchor lives on the opening message. */
  time_anchor: string | null;
}

/** chat.json for the 100K / 500K / 1M tiers. */
export type BeamRawChat = BeamRawBatch[];

/** chat.json for the 10M tier: one extra nesting level, [{ "plan-1": [...batches] }, ...]. */
export type BeamRaw10MChat = Array<Record<string, BeamRawBatch[]>>;

// ---------------------------------------------------------------------------
// Raw probing questions — one shape per ability, all carrying `rubric`
// ---------------------------------------------------------------------------

interface BeamQuestionCommon {
  question: string;
  difficulty: string;
  /** The scored unit. Each item is judged independently; see docs/design.md §1a. */
  rubric: string[];
}

export interface BeamAbstentionQ extends BeamQuestionCommon {
  ideal_response: string;
  abstention_type: string;
  why_unanswerable: string;
  plan_reference: string;
}
export interface BeamContradictionQ extends BeamQuestionCommon {
  ideal_answer: string;
  contradiction_type: string;
  topic_questioned: string;
  conversation_references: string[];
  tests_for: string;
  source_chat_ids: { first_statement: number[]; second_statement: number[] };
}
export interface BeamEventOrderingQ extends BeamQuestionCommon {
  answer: string;
  ordering_type: string;
  total_mentions: number;
  conversation_references: string[];
  ordering_tested: string[];
  source_chat_ids: number[];
}
export interface BeamInformationExtractionQ extends BeamQuestionCommon {
  answer: string;
  question_type: string;
  conversation_reference: string;
  key_facts_tested: string[];
  source_chat_ids: number[];
}
export interface BeamInstructionFollowingQ extends BeamQuestionCommon {
  instruction_being_tested: string;
  expected_compliance: string;
  compliance_indicators: string[];
  non_compliance_signs: string[];
  instruction_type: string;
  source_chat_ids: number[];
}
export interface BeamKnowledgeUpdateQ extends BeamQuestionCommon {
  answer: string;
  update_type: string;
  tests_retention_of: string;
  conversation_references: string[];
  potential_confusion: string;
  source_chat_ids: { original_info: number[]; updated_info: number[] };
}
export interface BeamMultiSessionQ extends BeamQuestionCommon {
  answer: string;
  reasoning_type: string;
  sessions_required: number;
  conversation_references: string[];
  reasoning_steps: string[];
  source_chat_ids: number[];
}
export interface BeamPreferenceFollowingQ extends BeamQuestionCommon {
  preference_being_tested: string;
  expected_compliance: string;
  compliance_indicators: string[];
  non_compliance_signs: string[];
  preference_type: string;
  source_chat_ids: number[];
}
export interface BeamSummarizationQ extends BeamQuestionCommon {
  ideal_summary: string;
  summarization_type: string;
  bullet_points_covered: string[];
  conversation_sessions: string[];
  key_elements_tested: string[];
  synthesis_required: string;
  source_chat_ids: number[];
}
export interface BeamTemporalReasoningQ extends BeamQuestionCommon {
  answer: string;
  temporal_type: string;
  time_points: string[];
  conversation_references: string[];
  calculation_required: string;
  source_chat_ids: number[];
}

export interface BeamRawProbingQuestions {
  abstention: BeamAbstentionQ[];
  contradiction_resolution: BeamContradictionQ[];
  event_ordering: BeamEventOrderingQ[];
  information_extraction: BeamInformationExtractionQ[];
  instruction_following: BeamInstructionFollowingQ[];
  knowledge_update: BeamKnowledgeUpdateQ[];
  multi_session_reasoning: BeamMultiSessionQ[];
  preference_following: BeamPreferenceFollowingQ[];
  summarization: BeamSummarizationQ[];
  temporal_reasoning: BeamTemporalReasoningQ[];
}

export type BeamRawQuestion = BeamRawProbingQuestions[BeamAbility][number];

// ---------------------------------------------------------------------------
// Normalized shapes — what the harness actually ingests
// ---------------------------------------------------------------------------

export interface BeamMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Synthesized. BEAM only anchors dates at batch level, so turn dates are
   * interpolated across the batch span. This is a benchmark parameter, not an
   * implementation detail — see docs/design.md §3 and src/data/dates.ts.
   */
  createdAt: Date;
}

/**
 * A unit of conversation presented to OM as one thread. Ids are opaque so they
 * can't leak evidence.
 *
 * Granularity is a benchmark parameter, and a load-bearing one: OM accumulates
 * unobserved messages *per thread* and only observes once they cross a token
 * threshold. Mapping each BEAM turn to a thread makes every thread 2-6 messages,
 * far under the threshold, and the Observer never runs at all. See
 * `ThreadGranularity` in src/data/loader.ts.
 */
export interface BeamThread {
  threadId: string;
  batchNumber: number;
  /** Only set when threads are per-turn; a batch-level thread spans many turns. */
  turnIndex?: number;
  messages: BeamMessage[];
}

export interface BeamConversation {
  tier: BeamTier;
  /** Directory name under chats/<tier>/, e.g. "1". */
  chatId: string;
  /** Stable id used for snapshot paths and resource ids: "<tier>/<chatId>". */
  conversationId: string;
  threads: BeamThread[];
  /** Synthesized "now" for every question against this conversation. */
  questionDate: Date;
  /** Provenance for the date policy that produced createdAt / questionDate. */
  datePolicy: string;
}

export interface BeamQuestion {
  /** "<tier>/<chatId>/<ability>/<index>" — unique across the whole benchmark. */
  questionId: string;
  conversationId: string;
  tier: BeamTier;
  ability: BeamAbility;
  index: number;
  question: string;
  rubric: string[];
  /** The ability's reference answer field, normalized (answer / ideal_answer / ideal_summary / ...). */
  reference: string;
  raw: BeamRawQuestion;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** BEAM's judge is per-rubric-item on a 1.0 / 0.5 / 0.0 scale. */
export type RubricScore = 0 | 0.5 | 1;

/**
 * Two scoring modes. `partial` is the headline.
 *
 *   partial — THE reported number. This is the paper's stated methodology:
 *             each rubric nugget scored 0 / 0.5 / 1 and averaged. Judge sees
 *             the question, as the judge prompt's own text requires.
 *   strict  — credit only for full compliance. A diagnostic, not a headline;
 *             no published BEAM number uses it.
 *
 * BEAM's *released* scorer truncates 0.5 to 0 and never substitutes the
 * question into the judge prompt. A bug-for-bug mode reproducing that was
 * dropped: the numbers it produces are not worth inheriting, and the
 * difference is disclosed in the writeup instead.
 */
export type ScoringMode = 'partial' | 'strict';

/** The mode quoted whenever a single number is given. */
export const HEADLINE_SCORING_MODE: ScoringMode = 'partial';

export interface RubricJudgement {
  item: string;
  score: RubricScore;
  reason: string;
}

export interface QuestionResult {
  questionId: string;
  conversationId: string;
  tier: BeamTier;
  ability: BeamAbility;
  system: string;
  hypothesis: string;
  judgements: RubricJudgement[];
  scores: Record<ScoringMode, number>;
  /** Reported alongside accuracy — OM's actual selling point. See docs/design.md §6. */
  telemetry: {
    rawHaystackTokens: number;
    answerContextTokens: number;
    compressionRatio: number;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}
