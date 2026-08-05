// Pure classification for Codex request_user_input: which question shapes the phone can DISPLAY and
// LOSSLESSLY ANSWER. The app-server bridge (core/codex-remote-input) is its only caller and the only
// producer of a Codex question card — it was once shared with a blocking PreToolUse hook so the two
// would agree on ownership, but that hook can never answer a question (it can rewrite a tool's input,
// never substitute its result) and was deleted; see the note at the top of core/permission.

const ANSWER_MAX = 500;
const OPTION_LABEL_WIRE_MAX = 60;

type RawQuestion = {
  id?: unknown;
  header?: unknown;
  question?: unknown;
  isSecret?: unknown;
  options?: unknown;
} | null;

function capLabel(value: string): string {
  const characters = Array.from(value);
  return characters.length <= OPTION_LABEL_WIRE_MAX
    ? value
    : `${characters.slice(0, OPTION_LABEL_WIRE_MAX - 1).join("")}…`;
}

/** Convert only a shape the bridge can display and losslessly answer. Undefined means the honest
 * option-less hook must own it instead. */
export function renderableCodexUserInput(
  toolInput: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const rawQuestions = toolInput.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 3) return undefined;

  const questions: Array<Record<string, unknown>> = [];
  // The question ids never reach the phone (the card is positional), but the ANSWER path maps the
  // phone's positional picks back onto them — see codexAnswersFromPhone. An id that is missing/empty,
  // or shared by two questions, makes that map lossy: the answers collapse onto one key and a real
  // human decision is silently dropped. This is the chokepoint BOTH paths pass through, so the request
  // is refused here, before an unanswerable card is ever shown, and the Mac picker keeps ownership.
  const ids: string[] = [];
  for (const raw of rawQuestions as RawQuestion[]) {
    if (!raw || raw.isSecret === true || typeof raw.question !== "string" || raw.question.length === 0) {
      return undefined;
    }
    if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
    ids.push(raw.id);
    if (!Array.isArray(raw.options) || raw.options.length === 0) return undefined;
    const options: Array<Record<string, unknown>> = [];
    const labels: string[] = [];
    for (const candidate of raw.options) {
      const option = candidate as { label?: unknown; description?: unknown } | null;
      if (!option || typeof option.label !== "string" || option.label.length === 0) return undefined;
      const label = option.label;
      if (label !== label.trim() || label.length > ANSWER_MAX) return undefined;
      labels.push(label);
      options.push({
        label,
        description: typeof option.description === "string" ? option.description : "",
      });
    }
    if (new Set(labels).size !== labels.length) return undefined;
    if (new Set(labels.map(capLabel)).size !== labels.length) return undefined;
    questions.push({
      question: raw.question,
      ...(typeof raw.header === "string" ? { header: raw.header } : {}),
      multiSelect: false,
      options,
    });
  }
  if (new Set(ids).size !== ids.length) return undefined;
  return { questions };
}

