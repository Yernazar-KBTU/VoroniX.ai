/**
 * Шаг 5, защита от prompt injection. Три линии обороны:
 * 1) этот сканер ловит явные попытки ещё до модели: такой запрос получает шаблонный ответ и ни одного токена;
 * 2) промпт объясняет модели, что документы и результаты инструментов это данные, а не команды;
 * 3) права проверяет сервер: даже обманутая модель не получит инструмент, которого нет у роли.
 */
export interface InjectionScan {
  readonly score: number;
  readonly signals: readonly string[];
}

interface Rule {
  readonly id: string;
  readonly weight: number;
  readonly patterns: readonly RegExp[];
}

const RULES: readonly Rule[] = [
  {
    id: "ignore_rules",
    weight: 2,
    patterns: [
      /(игнорир|забудь|забуд|отмени|не\s+следуй|не\s+соблюдай)\S*\s+(?:\S+\s+){0,3}?(инструкц|правил|указани|ограничен|промпт)/iu,
      /\b(ignore|disregard|forget|override|bypass)\b\s+(?:\w+\s+){0,3}?(instructions|rules|prompts?|guidelines|restrictions)/i,
      /(нұсқау|ереже)\S*\s+(?:\S+\s+){0,2}?(елеме|ұмыт)/iu,
    ],
  },
  {
    id: "reveal_prompt",
    weight: 1,
    patterns: [
      /(покажи|выведи|напиши|раскрой|повтори|скинь|дай|отправь)\s+(?:\S+\s+){0,3}?(системн\S*\s+)?(промпт|инструкц|prompt)/iu,
      /\b(show|print|reveal|repeat|output|tell|give)\b\s+(?:\w+\s+){0,3}?(system\s+)?(prompt|instructions)/i,
    ],
  },
  {
    id: "role_override",
    weight: 1,
    patterns: [
      /(ты\s+теперь|теперь\s+ты|отныне\s+ты|представь,?\s+что\s+ты|притворись)/iu,
      /\b(you\s+are\s+now|pretend\s+(to\s+be|you\s+are)|act\s+as)\b/i,
    ],
  },
  {
    id: "jailbreak",
    weight: 2,
    patterns: [/\b(DAN|jailbreak|developer\s+mode)\b/i, /(джейлбрейк|режим\s+разработчика)/iu],
  },
  {
    id: "fake_markup",
    weight: 2,
    // Служебные блоки сервера (<access>, <documents>) человек подделать не может: такой текст блокируется.
    patterns: [/<\/?\s*(system|instructions?)\s*>/i, /<\/?\s*(access|documents?)\b/i, /\[\s*system\s*\]/i, /^\s*#+\s*system\b/im],
  },
  {
    id: "data_exfiltration",
    weight: 1,
    patterns: [
      /(всех|всю|весь|все|полн\S*)\s+(?:\S+\s+){0,2}?(клиент|заявк|баз|номер|контакт|телефон)/iu,
      /\b(all|every|entire|full)\s+(?:\w+\s+){0,2}?(clients?|customers?|leads?|database|contacts?|phone\s+numbers?)\b/i,
    ],
  },
];

/** С этого балла сообщение не идёт в модель. Один слабый сигнал (например, «покажи промпт») пропускаем: с ним справляется промпт. */
export const BLOCK_THRESHOLD = 2;

export function scanInjection(text: string): InjectionScan {
  const signals = RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  return { score: signals.reduce((sum, rule) => sum + rule.weight, 0), signals: signals.map((rule) => rule.id) };
}

/** Шаблонный ответ на заблокированное сообщение, на языке человека. */
export function blockedReply(text: string): string {
  if (/[әғқңөұүһі]/iu.test(text)) {
    return "Мен тек VoroniX CRM туралы сұрақтарға көмектесемін, ал менің ережелерімді өзгерту мүмкін емес. Бизнесіңіз туралы айтып беріңіз, VoroniX қалай көмектесетінін көрсетемін.";
  }
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  const cyrillic = text.match(/[а-яё]/giu)?.length ?? 0;
  if (latin > cyrillic) {
    return "I can only help with questions about the VoroniX CRM, and my rules can't be changed. Tell me about your business and I'll show how VoroniX can help.";
  }
  return "Я помогаю только с вопросами о CRM VoroniX, и мои правила изменить нельзя. Расскажите, чем занимается ваш бизнес, и я подскажу, как VoroniX может помочь.";
}
