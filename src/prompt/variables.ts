import type { AssistantConfig } from "../config/assistant.ts";
import type { LanguageCode, ProductConfig } from "../config/product.ts";

const LANGUAGE_NAMES: Readonly<Record<LanguageCode, string>> = {
  ru: "Russian",
  kk: "Kazakh",
  en: "English",
};

/** Человекочитаемый перечень: "a, b and c". */
export function joinList(items: readonly string[], lastJoiner = "and"): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} ${lastJoiner} ${items.at(-1) ?? ""}`;
}

/** Блок фактов о продукте, который попадает внутрь <product_facts>. */
export function renderProductFacts(product: ProductConfig): string {
  const lines = [
    `Product: ${product.name}`,
    `What it is: ${product.summary}`,
    `Who it is for: ${product.audience}`,
    "Features available now:",
    ...product.features.map((feature) => `- ${feature.name}: ${feature.description}`),
    `Messaging channels connected to the inbox: ${joinList(product.channels)}`,
  ];
  if (product.pricing.published) {
    lines.push("Pricing plans:");
    lines.push(...product.pricing.plans.map((plan) => `- ${plan.name}: ${plan.price}. Includes: ${plan.includes}`));
  } else {
    lines.push("Pricing: not published yet.");
  }
  lines.push(`Website: ${product.contacts.website}`);
  if (product.contacts.email !== undefined) {
    lines.push(`Email: ${product.contacts.email}`);
  }
  return lines.join("\n");
}

export function pricingRule(product: ProductConfig): string {
  return product.pricing.published
    ? "Quote prices only exactly as listed in the product facts, and never offer discounts or custom terms."
    : "Pricing has not been published yet. If asked about cost, say that prices are not published yet and the team will share them on request. Never give numbers, ranges or estimates.";
}

export function contactLine(product: ProductConfig): string {
  return product.contacts.email === undefined
    ? `the website ${product.contacts.website}`
    : `the website ${product.contacts.website} or ${product.contacts.email}`;
}

/** Все значения для шаблона системного промпта. */
export function buildPromptVariables(
  product: ProductConfig,
  assistant: AssistantConfig,
): Readonly<Record<string, string>> {
  return {
    assistant_name: assistant.name,
    product_name: product.name,
    product_facts: renderProductFacts(product),
    competitors: joinList(product.competitors, "or"),
    pricing_rule: pricingRule(product),
    contact_line: contactLine(product),
    languages: joinList(product.assistantLanguages.map((code) => LANGUAGE_NAMES[code])),
    next_step: product.nextStep,
  };
}
