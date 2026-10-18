import { describe, it, expect } from "vitest";
import { dashOf, firstEmailShape, layoutOf, openingOf } from "../../src/lib/first-email-shape.js";

describe("layoutOf", () => {
  it("names one block, single line breaks and paragraphs", () => {
    expect(layoutOf("Hi Marie, one line only.")).toBe("one_block");
    expect(layoutOf("Hi Marie,\nline two")).toBe("single_line_breaks");
    expect(layoutOf("Hi Marie,\n\nparagraph two")).toBe("double_line_breaks");
    expect(layoutOf("Hi Marie,\r\n \r\nparagraph two")).toBe("double_line_breaks");
  });
  it("ignores breaks at the very start or end", () => {
    expect(layoutOf("\n\nHi Marie, one line.\n\n")).toBe("one_block");
  });
});

describe("openingOf", () => {
  it("reads a greeting in several languages, whatever follows", () => {
    for (const t of ["Hi Marie,", "hello there", "Bonjour Marie,", "Hallo Jan,", "Hola Ana", "Ciao Luca", "Hej Erik", "Dzień dobry Panie"]) {
      expect(openingOf(t, "Marie")).toBe("greeting");
    }
  });
  it("does not read a word starting with a greeting as a greeting", () => {
    expect(openingOf("History shows that...", null)).toBe("no_greeting");
  });
  it("reads the recipient's own first name glued to the sentence", () => {
    expect(openingOf("Marie, I saw your post.", "Marie")).toBe("first_name_alone");
    expect(openingOf("Élodie: quick thought", "Elodie")).toBe("first_name_alone");
  });
  it("reads a lead whose first name is also a greeting word as the name alone (sharpened)", () => {
    expect(openingOf("Ola, I saw your post.", "Ola")).toBe("first_name_alone");
    expect(openingOf("Ola Ana, tudo bem?", "Ana")).toBe("greeting");
  });
  it("reads any capitalised name-like word glued to the sentence as a name, when no first name is on record", () => {
    expect(openingOf("Tony, I noticed your team is hiring.", null)).toBe("first_name_alone");
    expect(openingOf("Tony - I noticed your team is hiring.", null)).toBe("first_name_alone");
  });
  it("does not take a known opener for a name", () => {
    expect(openingOf("Quick question: are you hiring?", null)).toBe("no_greeting");
    expect(openingOf("Wow! Your launch was great.", null)).toBe("no_greeting");
    expect(openingOf("Congrats, on the raise.", null)).toBe("no_greeting");
  });
  it("reads no greeting", () => {
    expect(openingOf("I noticed your team is hiring.", "Marie")).toBe("no_greeting");
  });
});

describe("dashOf", () => {
  it("names em, en, both and none; a hyphen is not a dash", () => {
    expect(dashOf("a — b")).toBe("em");
    expect(dashOf("2–3 weeks")).toBe("en");
    expect(dashOf("a — b, 2–3")).toBe("both");
    expect(dashOf("well-known, follow-up")).toBe("none");
  });
  it("counts an HTML-entity dash as the dash it renders (sharpened)", () => {
    expect(dashOf("a &mdash; b")).toBe("em");
    expect(dashOf("2&#8211;3")).toBe("en");
  });
});

describe("firstEmailShape", () => {
  it("is null when there is no copy", () => {
    expect(firstEmailShape(null, "Marie")).toBeNull();
    expect(firstEmailShape("   ", "Marie")).toBeNull();
  });
  it("returns the three classes", () => {
    expect(firstEmailShape("Hi Marie,\n\nYour team — great.", "Marie")).toEqual({
      layout: "double_line_breaks",
      opening: "greeting",
      dash: "em",
    });
  });
});
