import { describe, it, expect } from "vitest";
import { clientIdentityTerms, maskClientIdentity, clientIdentityLeaks } from "../../src/lib/client-identity-mask";

// BLIND-NAME-LEAK-1105: the brand rows of the 4 clients the leak was measured on (brand-service, 2026-11-05).
const BRANDS = {
  docDinners: { name: "Doc Dinners", url: "https://docdinners.com", domain: "docdinners.com" },
  shockwave: { name: "Shockwave Centers of America", url: "https://shockwavecenters.com/learnmore", domain: "shockwavecenters.com" },
  ascendqe: { name: "AI Quality Engineering & Test Automation", url: "https://ascendqe.com", domain: "ascendqe.com" },
  beyondLogic: { name: "Beyond Logic", url: "https://beyondlogic.tech", domain: "beyondlogic.tech" },
};

describe("maskClientIdentity", () => {
  it("removes the name, domain, urls and emails from brand intel shaped like brand-service's, keeping every selling point", () => {
    const terms = clientIdentityTerms([BRANDS.docDinners]);
    const intel = {
      clientName: "Doc Dinners",
      brandExtractedFields: {
        companyOverview: { value: "Doc Dinners runs patient dinner events for chiropractors. The Doc Dinners team books 40+ new patients per event.", byBrand: { "docdinners.com": { value: "Doc Dinners runs events", sourceUrls: ["https://docdinners.com", "https://docdinners.com/about", "https://www.docdinners.com/contact?x=1"] } } },
        scarcity: { value: "Only onboarding 5 new chiropractic clinic partners per month." },
        contact: { value: "Write to hello@docdinners.com or visit docdinners.com/portfolio." },
        pricing: { value: "$2,500 per event, 30-day guarantee." },
      },
    };
    const masked = maskClientIdentity(intel, terms);
    expect(clientIdentityLeaks(masked, terms)).toEqual([]);
    const text = JSON.stringify(masked);
    expect(text).not.toMatch(/doc\s*dinners/i);
    expect(text).toContain("Only onboarding 5 new chiropractic clinic partners per month.");
    expect(text).toContain("$2,500 per event, 30-day guarantee.");
    expect(text).toContain("The client team books 40+ new patients per event.");
    expect(masked.brandExtractedFields.contact.value).toBe("Write to the client's email address or visit the client's website.");
    // Ten source urls on the client's site collapse into one.
    expect((masked.brandExtractedFields.companyOverview.byBrand as any)["the client's website"].sourceUrls).toEqual(["the client's website"]);
    // The input is never mutated.
    expect(intel.clientName).toBe("Doc Dinners");
  });

  it("catches the one-word spelling of the name through the domain label (AscendQE, brand named after its page title)", () => {
    const terms = clientIdentityTerms([BRANDS.ascendqe]);
    const masked = maskClientIdentity("AscendQE provides an enterprise quality intelligence platform; ascendqe's AI cuts test time 60%.", terms);
    expect(masked).toBe("the client provides an enterprise quality intelligence platform; the client's AI cuts test time 60%.");
  });

  it("masks the full name of Shockwave Centers of America, not the generic word shockwave", () => {
    const terms = clientIdentityTerms([BRANDS.shockwave]);
    const masked = maskClientIdentity("Shockwave Centers of America also places shockwave devices with practitioners (shockwavecenters.com/learnmore).", terms);
    expect(masked).toBe("the client also places shockwave devices with practitioners (the client's website).");
  });

  it("leaves the prospect's own company and urls alone", () => {
    const terms = clientIdentityTerms([BRANDS.beyondLogic]);
    const lead = { leadCompanyName: "Acme Logic", leadCompanyWebsiteUrl: "https://acmelogic.com", leadLinkedinUrl: "https://linkedin.com/in/jane" };
    expect(maskClientIdentity(lead, terms)).toEqual(lead);
  });

  it("drops a legal suffix and a parenthetical from the name", () => {
    const terms = clientIdentityTerms([{ name: "Ascend HR Corp", domain: "ascend-sync.com", url: null }]);
    expect(maskClientIdentity("Ascend HR syncs payroll; Ascend HR Corp is SOC 2.", terms)).toBe("the client syncs payroll; the client is SOC 2.");
  });
});
