import { tokenize } from "../rag/knowledge.ts";

/**
 * Шаг 6, смысл вопроса без внешних сервисов. Вопрос превращается в набор понятий:
 * слова базы знаний (первые 5 букв) плюс синонимы, сведённые к одному понятию
 * («умеет», «функции», «возможности», «может» это одно и то же @abilities).
 * Похожесть считается взвешенным Жаккаром: редкие слова весят больше, поэтому
 * «тариф Pro» и «тариф Start» остаются разными вопросами.
 */
const CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  "@abilities": ["умеет", "умееш", "умеют", "функц", "фич", "возмо", "может", "можеш", "умени", "делае", "featu", "capab", "abili", "мүмкі", "функци", "істей"],
  "@price": ["цен", "цена", "цены", "стоит", "стоим", "прайс", "price", "prici", "cost", "costs", "тариф", "plans", "plan", "баға", "бағас", "тарифт"],
  "@integrations": ["интег", "подкл", "integ", "conne", "қосу", "қосыл"],
  "@start": ["начат", "начин", "старт", "попро", "регис", "start", "begin", "signu", "trial", "бастау", "тірке"],
  "@demo": ["демо", "demo", "показ", "презе"],
  "@security": ["безоп", "защит", "secur", "safe", "privacy", "priva", "қауіп"],
};

/** Слова-обёртки вопроса: они не меняют смысл. */
const FILLER: ReadonlySet<string> = new Set([
  "какие", "какая", "какой", "каков", "какое", "расск", "подск", "скажи", "пожал", "можно", "есть", "хочу", "узнат",
  "what", "which", "tell", "about", "pleas", "how", "про", "у", "мне", "мен", "қанда", "айтып", "қандай", "бар",
  "ли", "там", "вообщ", "такое", "такой", "this", "that", "does", "is",
]);

const STEM_TO_CONCEPT = new Map<string, string>();
for (const [concept, stems] of Object.entries(CONCEPTS)) {
  for (const stem of stems) {
    STEM_TO_CONCEPT.set(stem.slice(0, 5), concept);
  }
}

export type Lang = "kk" | "ru" | "en";

export function detectLang(text: string): Lang {
  if (/[әғқңөұүһі]/iu.test(text)) {
    return "kk";
  }
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  const cyrillic = text.match(/[а-яё]/giu)?.length ?? 0;
  return latin > cyrillic ? "en" : "ru";
}

export interface Meaning {
  readonly lang: Lang;
  readonly terms: ReadonlySet<string>;
}

export function meaningOf(text: string): Meaning {
  const terms = new Set<string>();
  for (const stem of tokenize(text)) {
    if (FILLER.has(stem)) {
      continue;
    }
    terms.add(STEM_TO_CONCEPT.get(stem) ?? stem);
  }
  return { lang: detectLang(text), terms };
}

export type Weigh = (term: string) => number;

/** Понятие весит 1,5, слово весит по своей редкости в базе знаний (idf). */
export const CONCEPT_WEIGHT = 1.5;

export function similarity(a: Meaning, b: Meaning, weigh: Weigh): number {
  if (a.lang !== b.lang || a.terms.size === 0 || b.terms.size === 0) {
    return 0;
  }
  const w = (term: string): number => (term.startsWith("@") ? CONCEPT_WEIGHT : Math.max(0.2, weigh(term)));
  let shared = 0;
  let union = 0;
  for (const term of new Set([...a.terms, ...b.terms])) {
    const weight = w(term);
    union += weight;
    if (a.terms.has(term) && b.terms.has(term)) {
      shared += weight;
    }
  }
  return union === 0 ? 0 : shared / union;
}
