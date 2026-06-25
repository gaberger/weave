import type { Substrate } from "../ports/substrate.js";
import type { AgentId } from "../domain/ids.js";
import type { Intent } from "../domain/intent.js";
import { TaskKind, type QuestionAskedPayload, type QuestionResolvedPayload } from "../domain/task.js";

/**
 * Learning analytics use case: declare that a user asked a question.
 * Emits `learning.question.asked` for pattern mining and route optimization.
 */
export async function declareQuestion(
  weave: Substrate,
  newId: () => string,
  actor: AgentId,
  questionId: string,
  utterance: string,
  intent: Intent,
  networkId: string,
  persona: string,
): Promise<void> {
  await weave.append({
    id: newId(),
    kind: TaskKind.QuestionAsked,
    actor,
    subject: questionId,
    payload: {
      utterance,
      intent,
      networkId,
      persona,
    } satisfies QuestionAskedPayload,
  });
}

/**
 * Learning analytics use case: record that a question was resolved.
 * Emits `learning.question.resolved` with outcome metrics.
 */
export async function resolveQuestion(
  weave: Substrate,
  newId: () => string,
  actor: AgentId,
  questionId: string,
  durationMs: number,
  followUps: number,
  resolved: boolean,
  skill: string,
): Promise<void> {
  await weave.append({
    id: newId(),
    kind: TaskKind.QuestionResolved,
    actor,
    subject: questionId,
    payload: {
      questionId,
      durationMs,
      followUps,
      resolved,
      skill,
    } satisfies QuestionResolvedPayload,
  });
}