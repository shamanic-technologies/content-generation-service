import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  WHATSAPP_DYNASTY_SEEDS,
  WHATSAPP_TEMPLATE_V1,
  WHATSAPP_TEMPLATE_V2,
  WHATSAPP_TEMPLATE_VARIABLES,
} from "../../src/lib/whatsapp-templates.js";
import { buildWhatsAppSeedSql } from "../../src/lib/whatsapp-seed-sql.js";
import { extractTemplateVariableNames } from "../../src/lib/template-vars.js";
import { renderWhatsAppTemplate, WhatsAppVariablesMissingError, cleanBubbles } from "../../src/lib/whatsapp-writer.js";

const names = WHATSAPP_TEMPLATE_VARIABLES.map((v) => v.name);
const fill = (over: Record<string, string> = {}) => ({ ...Object.fromEntries(names.map((n) => [n, `<${n}>`])), ...over });

describe("WhatsApp templates (WA-TEMPLATES-1023)", () => {
  it("the migration is the module's seed, byte for byte", () => {
    expect(readFileSync("drizzle/0040_whatsapp_templates.sql", "utf8")).toBe(buildWhatsAppSeedSql());
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    expect(journal.entries.map((e: { tag: string }) => e.tag)).toContain("0040_whatsapp_templates");
  });

  it("v1 declares every variable of the catalogue; v2 (head) only tokens v1 declares", () => {
    expect(extractTemplateVariableNames(WHATSAPP_TEMPLATE_V1).sort()).toEqual([...names].sort());
    for (const t of extractTemplateVariableNames(WHATSAPP_TEMPLATE_V2)) expect(names).toContain(t);
  });

  it("one dynasty per Cold WhatsApp pipe, two template types each, descriptions unique", () => {
    expect(WHATSAPP_DYNASTY_SEEDS.map((d) => d.legKey).sort()).toEqual(
      ["lead_found_to_conversation", "lead_found_to_website_visit", "signup_to_paid_client", "start_to_signup"],
    );
    const types = WHATSAPP_DYNASTY_SEEDS.flatMap((d) => d.types);
    expect(new Set(types).size).toBe(8);
    expect(new Set(WHATSAPP_DYNASTY_SEEDS.map((d) => d.description)).size).toBe(4);
  });

  it("v2 asks for bubbles, an honest read and one question, never a pitch or a dash", () => {
    expect(WHATSAPP_TEMPLATE_V2).toMatch(/2 to 5 bubbles/);
    expect(WHATSAPP_TEMPLATE_V2).toMatch(/honest read/);
    expect(WHATSAPP_TEMPLATE_V2).toMatch(/ONE question about THEM/);
    expect(WHATSAPP_TEMPLATE_V2).toMatch(/Never a pitch line/);
    expect(WHATSAPP_TEMPLATE_V2).toMatch(/Zero emojis/);
    expect(WHATSAPP_TEMPLATE_V2).not.toMatch(/whyNowRule/);
    for (const t of [WHATSAPP_TEMPLATE_V1, WHATSAPP_TEMPLATE_V2]) expect(t).not.toMatch(/[–—]/);
  });

  it("renders the tokens and leaves no run of blank lines where a piece is empty", () => {
    const out = renderWhatsAppTemplate("whatsapp-signup-v1", WHATSAPP_TEMPLATE_V1, fill({ whyNowRule: "", timingRules: "" }));
    expect(out).toContain("<writerRole>");
    expect(out).not.toMatch(/\{\{/);
    expect(out).not.toMatch(/\n\s*\n\s*\n/);
  });

  it("refuses a template token the caller did not send as a string", () => {
    const vars = fill();
    delete (vars as Record<string, unknown>).voiceRules;
    expect(() => renderWhatsAppTemplate("t", WHATSAPP_TEMPLATE_V2, { ...vars, ownerName: 3 })).toThrow(WhatsAppVariablesMissingError);
    try {
      renderWhatsAppTemplate("t", WHATSAPP_TEMPLATE_V2, { ...vars, ownerName: 3 });
    } catch (e) {
      expect((e as WhatsAppVariablesMissingError).missing.sort()).toEqual(["ownerName", "voiceRules"]);
    }
  });

  it("bubbles are trimmed, dash-stripped, empty ones dropped", () => {
    expect(cleanBubbles(["  hey Jeremy ", "", "fit — yes", "a\\nb"])).toEqual(["hey Jeremy", "fit, yes", "a\nb"]);
  });
});
