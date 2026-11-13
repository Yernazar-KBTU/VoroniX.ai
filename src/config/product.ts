import {
  asObject,
  readArray,
  readBoolean,
  readEnum,
  readOptionalString,
  readString,
  readStringArray,
  type JsonObject,
} from "./validate.ts";
import { ConfigError } from "./errors.ts";

export const LANGUAGE_CODES = ["ru", "kk", "en"] as const;
export type LanguageCode = (typeof LANGUAGE_CODES)[number];

export interface ProductFeature {
  readonly name: string;
  readonly description: string;
}

export interface PricingPlan {
  readonly name: string;
  readonly price: string;
  readonly includes: string;
}

export type Pricing =
  | { readonly published: false }
  | { readonly published: true; readonly plans: readonly PricingPlan[] };

export interface ProductContacts {
  readonly website: string;
  readonly email?: string;
}

/** Факты о продукте. Единственный источник правды для ассистента. */
export interface ProductConfig {
  readonly name: string;
  readonly summary: string;
  readonly audience: string;
  readonly features: readonly ProductFeature[];
  readonly channels: readonly string[];
  readonly assistantLanguages: readonly LanguageCode[];
  readonly pricing: Pricing;
  readonly competitors: readonly string[];
  readonly contacts: ProductContacts;
  readonly nextStep: string;
}

const WHERE = "product";

export function parseProductConfig(raw: unknown): ProductConfig {
  const obj = asObject(raw, WHERE);
  const languages = readStringArray(obj, "assistantLanguages", WHERE).map((code, index) =>
    readEnum({ code }, "code", LANGUAGE_CODES, `${WHERE}.assistantLanguages[${index}]`),
  );
  return {
    name: readString(obj, "name", WHERE),
    summary: readString(obj, "summary", WHERE),
    audience: readString(obj, "audience", WHERE),
    features: readArray(obj, "features", WHERE).map((item, index) => parseFeature(item, index)),
    channels: readStringArray(obj, "channels", WHERE),
    assistantLanguages: languages,
    pricing: parsePricing(obj),
    competitors: readStringArray(obj, "competitors", WHERE),
    contacts: parseContacts(obj),
    nextStep: readString(obj, "nextStep", WHERE),
  };
}

function parseFeature(item: unknown, index: number): ProductFeature {
  const where = `${WHERE}.features[${index}]`;
  const obj = asObject(item, where);
  return { name: readString(obj, "name", where), description: readString(obj, "description", where) };
}

function parsePricing(product: JsonObject): Pricing {
  const where = `${WHERE}.pricing`;
  const obj = asObject(product["pricing"], where);
  if (!readBoolean(obj, "published", where)) {
    if (obj["plans"] !== undefined) {
      throw new ConfigError(`${where}.plans: remove plans while pricing is not published`);
    }
    return { published: false };
  }
  const plans = readArray(obj, "plans", where).map((item, index) => {
    const planWhere = `${where}.plans[${index}]`;
    const plan = asObject(item, planWhere);
    return {
      name: readString(plan, "name", planWhere),
      price: readString(plan, "price", planWhere),
      includes: readString(plan, "includes", planWhere),
    };
  });
  return { published: true, plans };
}

function parseContacts(product: JsonObject): ProductContacts {
  const where = `${WHERE}.contacts`;
  const obj = asObject(product["contacts"], where);
  const website = readString(obj, "website", where);
  if (!/^https:\/\/\S+$/.test(website)) {
    throw new ConfigError(`${where}.website: expected an https:// URL`);
  }
  const email = readOptionalString(obj, "email", where);
  return email === undefined ? { website } : { website, email };
}
