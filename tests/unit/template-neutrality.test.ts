import { describe, it, expect } from "vitest";
import {
  splitTemplatePassages,
  buildNeutralityQuestions,
  interpretNeutralityAnswers,
  templateNeutralityKey,
  templateWriteErrorResponse,
  TemplateNotNeutralError,
} from "../../src/lib/template-neutrality.js";
import { JudgmentsError } from "../../src/lib/judgments-client.js";

describe("splitTemplatePassages", () => {
  it("splits lines and sentences, strips markdown, skips token-only and blank lines, dedups", () => {
    const passages = splitTemplatePassages(
      "## The frame\n\n- Write to {{leadFirstName}}. Keep it short!\n{{brandName}}\n- Keep it short!",
      [{ name: "brandName", description: "The brand's name" }],
    );
    expect(passages).toEqual([
      { text: "The frame", location: "prompt" },
      { text: "Write to {{leadFirstName}}.", location: "prompt" },
      { text: "Keep it short!", location: "prompt" },
      { text: "The brand's name", location: "variables.brandName" },
    ]);
  });
});

describe("buildNeutralityQuestions", () => {
  it("keys one noul question per passage, offset-aware, carrying the passage verbatim", () => {
    const q = buildNeutralityQuestions([{ text: "Pitch Acme's audit.", location: "prompt" }], 50);
    expect(Object.keys(q)).toEqual(["p50"]);
    expect(q.p50.type).toBe("noul");
    expect(q.p50.instructions).toContain('"""Pitch Acme\'s audit."""');
  });

  it("exempts the channel the content is written for (Featured.com was refused at p=0.6 under v1)", () => {
    const q = buildNeutralityQuestions([{ text: "x", location: "prompt" }], 0);
    expect(q.p0.criteria.false).toMatch(/Featured\.com/);
    expect(q.p0.instructions).toMatch(/channel or platform the content is written for does not count/);
  });
});

describe("interpretNeutralityAnswers", () => {
  const passages = [
    { text: "Write to {{leadFirstName}}.", location: "prompt" },
    { text: "Mention Acme's free 14-day audit.", location: "prompt" },
  ];

  it("flags passages at or above 0.5", () => {
    const v = interpretNeutralityAnswers(passages, {
      p0: { type: "noul", noul: 0.02 },
      p1: { type: "noul", noul: 0.96 },
    });
    expect(v.neutral).toBe(false);
    expect(v.specific).toEqual([{ ...passages[1], probability: 0.96 }]);
    expect(v.passages).toHaveLength(2);
  });

  it("fails loud on a missing answer instead of reading it as neutral", () => {
    expect(() => interpretNeutralityAnswers(passages, { p0: { type: "noul", noul: 0.1 } })).toThrow(/p1/);
  });
});

describe("templateNeutralityKey", () => {
  it("changes with the body and with the variables", () => {
    const a = templateNeutralityKey("x", []);
    expect(templateNeutralityKey("x", [])).toBe(a);
    expect(templateNeutralityKey("y", [])).not.toBe(a);
    expect(templateNeutralityKey("x", [{ name: "v", description: "d" }])).not.toBe(a);
  });
});

describe("templateWriteErrorResponse", () => {
  it("answers a refusal 422 with the cited passages", () => {
    const r = templateWriteErrorResponse(
      new TemplateNotNeutralError([{ text: "Acme", location: "prompt", probability: 0.9 }]),
    );
    expect(r?.status).toBe(422);
    expect(r?.body).toMatchObject({
      code: "TEMPLATE_NOT_NEUTRAL",
      passages: [{ passage: "Acme", location: "prompt", probability: 0.9 }],
    });
  });

  it("keeps chat-service 402/429, maps anything else to 502, ignores other errors", () => {
    expect(templateWriteErrorResponse(new JudgmentsError(402, "x"))?.status).toBe(402);
    expect(templateWriteErrorResponse(new JudgmentsError(429, "x"))?.status).toBe(429);
    expect(templateWriteErrorResponse(new JudgmentsError(500, "x"))?.status).toBe(502);
    expect(templateWriteErrorResponse(new Error("other"))).toBeNull();
  });
});
