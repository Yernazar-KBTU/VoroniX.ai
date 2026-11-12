/**
 * Семь слоёв ассистента. Порядок, названия и цвета те же, что в видео «Ночь провалов бота»:
 * каждый слой закрывает один провал бота, у которого был только ключ API.
 * Каждый этап проекта включает свой слой; пока слой не готов, он помечен как planned.
 */
export type LayerStatus = "active" | "planned";

export interface Layer {
  readonly step: number;
  readonly id: string;
  readonly name: string;
  /** Провал из видео, который закрывает слой. */
  readonly fixes: string;
  readonly color: string;
  readonly status: LayerStatus;
}

export const LAYERS: readonly Layer[] = [
  { step: 1, id: "prompt", name: "Промпт", fixes: "Советует конкурента", color: "#a78bfa", status: "active" },
  { step: 2, id: "rag", name: "RAG", fixes: "Не знает свой продукт", color: "#fbbf24", status: "planned" },
  { step: 3, id: "tools", name: "Инструменты", fixes: "Пустое обещание", color: "#2dd4bf", status: "planned" },
  { step: 4, id: "auth", name: "Роли и вход", fixes: "Выдал всю базу", color: "#60a5fa", status: "planned" },
  { step: 5, id: "guard", name: "Защита", fixes: "Утечка номера", color: "#fb7185", status: "planned" },
  { step: 6, id: "cache", name: "Кэш и роутер", fixes: "Счёт $64", color: "#a3e635", status: "planned" },
  { step: 7, id: "observability", name: "Трейсы и тесты", fixes: "Ничего не видно", color: "#22d3ee", status: "planned" },
];
