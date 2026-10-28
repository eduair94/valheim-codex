import { detectIntent, linkThings, type LinkerSource } from './intent';
import { deterministicQueries } from './rewrite';

/**
 * Whether a question's search queries come from a model or from the question.
 *
 * Every question used to cost two model calls: the rewrite into English
 * keyword queries, then the answer. Gemini's free tier is now 20 requests a
 * day, and every question spent two of them; a reader on their own key paid
 * twice per question out of their own quota too. For one kind of question the
 * rewrite adds nothing retrieval needs: a first question that asks what
 * things are for, or where they are, and names every one of them so that the
 * title index links it. Those are searched as asked (`deterministicQueries`:
 * the question, plus the glossary's English for its Spanish terms), as the
 * Puter path always has been. On the golden set, searched that way, they all
 * found their article (16 of its 41 questions are of this kind).
 *
 * The link decides, not the section asked for. Where the article has that
 * section (Usage; the lead and Availability), retrieval pins it from the
 * question itself (`intent.ts`), and a rewrite that asked for "recipes"
 * instead of uses was how such questions used to go wrong. Where it has none,
 * as a Portal or a Workbench has no Usage, nothing is pinned, and the name
 * finds the article about as well as a rewrite does. Over 13 such questions
 * the article reached the context 13 of 15 times either way, and came first
 * 10 times as asked against 11 with a rewrite that followed the rewrite's
 * rules. Checking for the section first would add a database round trip to
 * every such question for that one difference.
 *
 * Everything else is still rewritten. A follow-up needs the model to fold the
 * conversation in ("¿y dónde está?"), and a question with a name the index
 * does not know needs it turned into the English the index holds.
 *
 * Modes, set with CHAT_REWRITE:
 *   - `auto`   the above (the default);
 *   - `always` every question rewritten, as before;
 *   - `off`    none: the deterministic queries for every turn, with the
 *              previous question folded into a follow-up — for when no model
 *              should be spent on anything but answers.
 */
export type RewriteMode = 'off' | 'auto' | 'always';

export const REWRITE_MODES: readonly RewriteMode[] = ['off', 'auto', 'always'];

/** A mode from its name; anything else, an unset variable included, is `auto`. */
export function rewriteModeFrom(raw: string | undefined): RewriteMode {
  const value = raw?.trim().toLowerCase();
  return REWRITE_MODES.find((mode) => mode === value) ?? 'auto';
}

/** The operator's choice (CHAT_REWRITE), read once at startup like every other chat setting. */
export const REWRITE_MODE: RewriteMode = rewriteModeFrom(process.env.CHAT_REWRITE);

export type QueryPlan = {
  queries: string[];
  /**
   * Whether a model was asked for them, rather than the question being
   * searched as asked. Handed on to `retrieve`, which pins the things a
   * model's queries name, and none a follow-up's folded-in question does.
   */
  rewritten: boolean;
};

export type PlanInput = {
  question: string;
  /** Earlier turns, oldest first. Any at all makes it a follow-up. */
  history: { role: 'user' | 'assistant'; text: string }[];
  /**
   * Runs the model rewrite, only when the plan needs one: the caller's own
   * call, so the stage the reader is shown is announced when it begins.
   */
  rewrite: () => Promise<string[]>;
  /** The title index the question's names are linked through; without one, nothing links. */
  linker?: LinkerSource;
  /** Defaults to the operator's `REWRITE_MODE`. */
  mode?: RewriteMode;
};

/**
 * Whether the question asks what things are for or where they are, about
 * things the title index names exactly, every one of them. The index is read
 * only for such a question.
 *
 * Every one, not one of them. "Was kann ich mit Zinn und Bronze herstellen?"
 * links Bronze but not "Zinn". Searched as asked, Tin was neither translated
 * nor pinned, and its Usage section left the context (none of its 2 chunks);
 * rewritten, the queries name Tin, retrieval pins it from them
 * (`pinCandidates`), and both chunks are back. A name the index does not
 * know is what the rewrite is for.
 */
async function namesEveryThing(question: string, linker: LinkerSource | undefined): Promise<boolean> {
  const intent = detectIntent(question);
  if (!intent || !linker) return false;
  const titles = await linker();
  return titles !== null && linkThings(intent, titles).every((title) => title !== null);
}

/** The search queries for a turn, and whether a model wrote them. */
export async function planQueries(input: PlanInput): Promise<QueryPlan> {
  const { question, history, rewrite, linker, mode = REWRITE_MODE } = input;
  const asked = (): QueryPlan => ({ queries: deterministicQueries(question, history), rewritten: false });

  if (mode === 'off') return asked();
  if (mode === 'auto' && history.length === 0 && (await namesEveryThing(question, linker))) return asked();
  return { queries: await rewrite(), rewritten: true };
}
