import { useState } from "react";

const OUTPUTS = [
  { id: "jd", label: "Job Description", emoji: "📄" },
  { id: "sourcing", label: "Sourcing Message", emoji: "💼" },
  { id: "prep", label: "Interview Prep", emoji: "📋" },
  { id: "post", label: "LinkedIn Post", emoji: "📣" },
  { id: "boolean", label: "Boolean & X-Ray", emoji: "🔍" },
  { id: "update", label: "Candidate Update", emoji: "🗂️" },
  { id: "silver", label: "Silver Medallists", emoji: "🥈" },
];

const SECTION_HEADINGS = {
  jd:      "## Job Description",
  sourcing:"## Sourcing Message",
  prep:    "## Interview Prep",
  post:    "## LinkedIn Post",
  boolean: "## Boolean & X-Ray",
  update:  "## Candidate Update",
};

export default function RecruiterAgent() {
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState(
    Object.fromEntries(OUTPUTS.map((o) => [o.id, true]))
  );
  const [generated, setGenerated] = useState({});
  const [activeTab, setActiveTab] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState("");
  const [error, setError] = useState(null);
  const [expandedCandidate, setExpandedCandidate] = useState(null);
  const [copiedSection, setCopiedSection] = useState(null);

  const hasGenerated = Object.keys(generated).filter((k) => k !== "_raw").length > 0;

  const toggleOutput = (id) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // All Ashby calls go through our server-side proxy — no CORS issues
  const ashbyPost = async (endpoint, body) => {
    const res = await fetch("/api/ashby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, body }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Ashby error: ${JSON.stringify(json)}`);
    return json;
  };

  const fetchSilverMedallists = async () => {
    setLoadingStatus("Searching Ashby for silver medallists…");

    let allApplications = [];
    let cursor = null;
    let hasMore = true;
    while (hasMore) {
      const body = { limit: 100 };
      if (cursor) body.cursor = cursor;
      const data = await ashbyPost("/application.list", body);
      allApplications = [...allApplications, ...(data.results || [])];
      cursor = data.moreDataAvailable ? data.nextCursor : null;
      hasMore = !!cursor && allApplications.length < 500;
    }

    const poorFit = ["poor culture fit", "culture fit", "not a culture fit", "cultural fit"];
    const stageOrder = ["screening call","first interview","second interview","third interview","final interview","assessment","task","offer","hired"];

    const passedScreening = allApplications.filter((app) => {
      const stage = (app.currentInterviewStageName || app.interviewStageName || "").toLowerCase();
      const passedStage = stageOrder.some((s) => stage.includes(s));
      const isArchived = app.status === "Archived" || app.archived === true;
      const reason = (app.archiveReason?.name || app.archiveReasonName || app.dispositionReason || "").toLowerCase();
      return passedStage && isArchived && !poorFit.some((p) => reason.includes(p));
    });

    if (passedScreening.length === 0) return [];

    setLoadingStatus("Fetching candidate details from Ashby…");
    const candidateIds = [...new Set(passedScreening.map((a) => a.candidateId).filter(Boolean))];
    const candidateDetails = {};
    for (let i = 0; i < Math.min(candidateIds.length, 50); i += 10) {
      await Promise.all(
        candidateIds.slice(i, i + 10).map(async (id) => {
          try {
            const d = await ashbyPost("/candidate.info", { id });
            if (d.results) candidateDetails[id] = d.results;
          } catch { /* skip */ }
        })
      );
    }

    const enriched = passedScreening.slice(0, 50).map((app) => {
      const c = candidateDetails[app.candidateId] || {};
      return {
        id: app.candidateId || app.id,
        name: c.name || app.candidateName || "Unknown",
        email: c.primaryEmailAddress?.value || c.email || "",
        currentTitle: c.headline || c.currentTitle || "",
        currentCompany: c.currentCompany || "",
        previousRole: app.jobPostingName || app.jobTitle || "",
        stageReached: app.currentInterviewStageName || app.interviewStageName || "",
        appliedAt: app.createdAt ? new Date(app.createdAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "",
        archiveReason: app.archiveReason?.name || app.archiveReasonName || "Not specified",
      };
    });

    setLoadingStatus("Ranking candidates against your kickoff notes…");
    const prompt = `You are a recruiter's assistant at Street Group. Score and rank the top 10 most relevant silver medallist candidates against the hiring kickoff notes below. Return ONLY a JSON array, no other text.

HIRING KICKOFF NOTES:
${notes}

CANDIDATES:
${JSON.stringify(enriched, null, 2)}

Return format:
[{"id":"","name":"","email":"","currentTitle":"","currentCompany":"","previousRole":"","stageReached":"","appliedAt":"","archiveReason":"","matchScore":85,"matchReason":"2-3 sentences","suggestedOutreach":"Warm re-engagement message under 80 words, [CANDIDATE NAME] placeholder, no 'I hope this finds you well', soft CTA at end."}]`;

    const r = await fetch("/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
    });
    const d = await r.json();
    const txt = d.content?.map((b) => b.text || "").join("") || "";
    return JSON.parse(txt.replace(/```json|```/g, "").trim());
  };

  const buildPrompt = (outputIds) => {
    const sections = outputIds.map((id) => SECTION_HEADINGS[id]).filter(Boolean).join(", ");
    return `You are the Street Group AI Recruiter Agent. Produce the requested outputs from the hiring kickoff notes below. Use the EXACT section headings listed — they are used to parse your response, so do not alter them.

Sections to generate: ${sections}

For each section, begin with its heading on its own line (e.g. "## Job Description"), then write the content. Do not add any text before the first heading.

HIRING KICKOFF NOTES:
${notes}

---

OUTPUT INSTRUCTIONS:

## Job Description
Structure: Job title + 📍 location/WFH + 💰 salary | Company intro (boilerplate below) | Role hook 2-3 sentences | A bit about you (second person, flowing bullets) | Here's what you can expect to be working on (action-led bullets) | D&I nudge (verbatim): "We recognise that women and people from underrepresented groups often only apply for jobs when they meet every single one of the requirements listed. If you fall into that category and are about to rule yourself out based on the above criteria; please consider applying anyway. We'd love to see your application!" | Who are Street Group? (boilerplate) | Why join Street Group? (benefits list) | Salary caveat | Interview process + inclusive interviews line (verbatim): "We want to make our interviews as inclusive as possible, so if you need any adjustments made, or if there's anything you think we should be aware of during the interview process, please do let us know!" | AI note (verbatim): "As a fast-moving and rapidly evolving tech company, we embrace the advantages of AI and encourage its use throughout our application process. However, our goal is to get to know and hire the authentic you - your skills, experience, and values. We don't want to hire an AI-generated version of you. We consider AI to be a valuable tool, not something that should overshadow you as an individual."

## Sourcing Message
Under 100 words. Warm and direct. Role-specific. [CANDIDATE NAME] placeholder. Does NOT start with "I hope this message finds you well". Ends with soft CTA.

## Interview Prep
Role summary (3 sentences) | What great looks like (3-5 bullets) | 8 tailored interview questions with what to listen for | Red flags | Scoring guide (1-5 scale).

## LinkedIn Post
Option 1: Short and punchy under 80 words. Option 2: Storytelling 100-150 words. Both: short sentences, warm and human, 1-3 emojis max, [RECRUITER NAME] placeholder, 2-3 hashtags. NEVER open with "Excited to share", "We're hiring!", or hype openers. No exclamation marks on every sentence.

## Boolean & X-Ray
LinkedIn Boolean string (single line) | Google X-Ray string (single line) | 4 alternative job title variants with one-line notes | Screening note: Minimum 3 years experience — must be confirmed at screening.

## Candidate Update
3 email templates: one post-interview update, one holding message, one rejection with care.

---

Street Group boilerplate: "We're an award-winning PropTech business based in Manchester, founded in 2015 by brother and sister duo, Tom & Heather Staff. Most of us have personal experience of how painful moving can be, and Tom and Heather saw an opportunity to change this: utilising technology, as well as our incredibly talented team, to improve the industry for everyone. Our products, Street.co.uk and Spectre form a powerful duo, working harmoniously together to transform an agent's job. From securing more leads and winning new instructions to streamlining business operations and growing market share, our products are supercharging 1,000s of agencies across the UK. Back in 2015, our co-Founder, Tom Staff, spent his evenings building Spectre v1.0. He'd seen first-hand an opportunity to automate the very manual process of winning new business for estate agents. Spectre is now our multi award-winning, instruction generation tool, generating an average return on investment for them of over 3000%."

Benefits:
🏠 Hybrid-working - up to 4 days WFH
🏖️ £1000 holiday allowance after year one
💪 Culture that supports development and growth
📚 £500 yearly L&D budget
🎂 Birthday off
🙋 2 paid volunteering days
👶 Enhanced maternity, paternity & adoption pay
🧠 Mental health support via Health Assured
🕒 Flexible working hours
🚂 Season ticket loans
🌷 Paid menopause leave
🌞 Holiday buying scheme
🚀 Exciting business with huge ambition
👩🏿‍💻 Cutting-edge technology
🐶 Office dogs welcome
🍻 Stocked fridge and beers on Fridays
🎊 Company off-sites and events
🚴 Cycle to work scheme
🚗 Electric car salary sacrifice
🌍 Climate-positive company

TOV: warm, direct, specific, no corporate fluff. Second person in "about you" section.`;
  };

  const parseResult = (text, outputIds) => {
    const parsed = {};
    outputIds.forEach((id) => {
      const heading = SECTION_HEADINGS[id];
      if (!heading) return;
      const start = text.indexOf(heading);
      if (start === -1) return;
      const contentStart = start + heading.length;
      const nextStarts = Object.values(SECTION_HEADINGS)
        .map((h) => text.indexOf(h, contentStart))
        .filter((i) => i > contentStart);
      const end = nextStarts.length ? Math.min(...nextStarts) : text.length;
      parsed[id] = text.slice(contentStart, end).trim();
    });
    return parsed;
  };

  const generate = async () => {
    if (!notes.trim()) return;
    setLoading(true);
    setError(null);
    setGenerated({});
    setActiveTab(null);
    setExpandedCandidate(null);

    const textIds = OUTPUTS.filter((o) => o.id !== "silver" && selected[o.id]).map((o) => o.id);
    const silverEnabled = selected.silver;

    try {
      const newGenerated = {};
      const tasks = [];

      if (textIds.length > 0) {
        setLoadingStatus("Generating your outputs…");
        tasks.push((async () => {
          const res = await fetch("/api/claude", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 4000,
              messages: [{ role: "user", content: buildPrompt(textIds) }],
            }),
          });
          const data = await res.json();
          const text = data.content?.map((b) => b.text || "").join("") || "";
          Object.assign(newGenerated, parseResult(text, textIds));
          newGenerated._raw = text;
        })());
      }

      if (silverEnabled) {
        tasks.push((async () => {
          try {
            newGenerated.silver = await fetchSilverMedallists();
          } catch (e) {
            newGenerated.silver = { error: `Couldn't fetch silver medallists: ${e.message}` };
          }
        })());
      }

      await Promise.all(tasks);
      setGenerated(newGenerated);
      setActiveTab(null);
    } catch (e) {
      setError("Something went wrong. Please try again.");
    }

    setLoadingStatus("");
    setLoading(false);
  };

  const copySection = (id) => {
    const c = generated[id];
    if (!c) return;
    navigator.clipboard.writeText(typeof c === "string" ? c : JSON.stringify(c, null, 2));
    setCopiedSection(id);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const scoreColor = (s) => s >= 80 ? "#16a34a" : s >= 60 ? "#d97706" : "#dc2626";
  const scoreBg = (s) => s >= 80 ? "#f0fdf4" : s >= 60 ? "#fffbeb" : "#fef2f2";
  const activeOutput = OUTPUTS.find((o) => o.id === activeTab);

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100vh", background: "#f0eeeb", color: "#1a1a2e", display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ background: "#1a1a2e", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "#e8440a", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14, color: "#fff" }}>S</div>
          <span style={{ fontWeight: 600, fontSize: 15, color: "#fff" }}>Street Group</span>
        </div>
        <div style={{ border: "1.5px solid #e8440a", color: "#e8440a", fontSize: 12, fontWeight: 600, padding: "4px 14px", borderRadius: 20 }}>Recruiter Agent</div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "28px 20px" }}>

        {!hasGenerated && !loading && (
          <>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: "0 0 6px" }}>Hiring kickoff</h1>
            <p style={{ fontSize: 14, color: "#888", margin: "0 0 24px", lineHeight: 1.5 }}>Paste your kickoff notes once — every output is generated automatically.</p>
          </>
        )}

        {!loading && (
          <div style={{ background: "#fff", borderRadius: 16, padding: "20px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#aaa", textTransform: "uppercase" }}>KICKOFF NOTES</div>
              {hasGenerated && (
                <button onClick={() => { setGenerated({}); setActiveTab(null); }} style={{ background: "#fff", border: "1px solid #e8e8e8", color: "#666", fontSize: 12, padding: "4px 12px", borderRadius: 16, cursor: "pointer" }}>← New role</button>
              )}
            </div>

            <div style={{ border: "1px solid #e8e8e8", borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Role title, team, salary, responsibilities, must-haves, interview process..."
                style={{ width: "100%", minHeight: hasGenerated ? 80 : 160, background: "transparent", border: "none", outline: "none", color: "#1a1a2e", fontSize: 14, lineHeight: 1.6, resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }}
              />
            </div>

            {/* Toggle buttons */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
              {OUTPUTS.map((o) => {
                const isOn = selected[o.id];
                const isReady = hasGenerated && (o.id === "silver" ? generated.silver !== undefined : !!generated[o.id]);
                const isActive = activeTab === o.id;

                let border = "1.5px solid #e8e8e8";
                let bg = "#f7f7f7";
                let color = "#999";
                if (isActive)     { border = "1.5px solid #e8440a"; bg = "#fff5f2"; color = "#e8440a"; }
                else if (isReady) { border = "1.5px solid #d0cfe8"; bg = "#f0effe"; color = "#5b5bd6"; }
                else if (isOn)    { border = "1.5px solid #d0cfe8"; bg = "#f0effe"; color = "#5b5bd6"; }

                return (
                  <button
                    key={o.id}
                    onClick={() => {
                      if (hasGenerated) {
                        setActiveTab(o.id);
                      } else {
                        toggleOutput(o.id);
                      }
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 20, border, background: bg, color, fontSize: 13, fontWeight: 500, cursor: "pointer", opacity: 1, transition: "all 0.15s" }}
                  >
                    <span style={{ fontSize: 14 }}>{o.emoji}</span>
                    {o.label}
                    {isReady && !isActive && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#5b5bd6", display: "inline-block", marginLeft: 2 }} />}
                  </button>
                );
              })}
            </div>

            <button
              onClick={generate}
              disabled={!notes.trim() || OUTPUTS.filter((o) => o.id !== "silver" && selected[o.id]).length === 0}
              style={{
                width: "100%", padding: "16px",
                background: notes.trim() ? "linear-gradient(135deg, #f05a28 0%, #e8440a 100%)" : "#e8e8e8",
                color: notes.trim() ? "#fff" : "#bbb",
                border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700,
                cursor: notes.trim() ? "pointer" : "not-allowed", transition: "all 0.15s",
              }}
            >
              {hasGenerated ? "Regenerate →" : "Generate everything →"}
            </button>
          </div>
        )}

        {loading && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 300, gap: 16 }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", border: "3px solid rgba(232,68,10,0.15)", borderTopColor: "#e8440a", animation: "spin 0.8s linear infinite" }} />
            <p style={{ color: "#888", fontSize: 14 }}>{loadingStatus || "Generating your outputs…"}</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {error && (
          <div style={{ background: "#fff5f2", border: "1px solid #ffd0c0", borderRadius: 10, padding: 16, color: "#e8440a", fontSize: 14, marginBottom: 16 }}>{error}</div>
        )}

        {/* Output panel */}
        {hasGenerated && !loading && activeTab && (
          <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 14, overflow: "hidden" }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: "#1a1a2e" }}>{activeOutput?.emoji} {activeOutput?.label}</div>
              {activeTab !== "silver" && generated[activeTab] && (
                <button onClick={() => copySection(activeTab)} style={{ padding: "5px 14px", background: "#f7f7f7", border: "1px solid #e8e8e8", color: copiedSection === activeTab ? "#5b5bd6" : "#555", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer" }}>
                  {copiedSection === activeTab ? "Copied ✓" : "Copy section"}
                </button>
              )}
            </div>

            {activeTab !== "silver" && (
              <div style={{ padding: "24px", fontSize: 14, lineHeight: 1.8, color: "#1a1a2e", whiteSpace: "pre-wrap", minHeight: 200 }}>
                {generated[activeTab] || "No content generated for this section."}
              </div>
            )}

            {activeTab === "silver" && (
              <div style={{ padding: "16px" }}>
                {generated.silver?.error && (
                  <div style={{ color: "#e8440a", fontSize: 14, padding: 8 }}>{generated.silver.error}</div>
                )}
                {Array.isArray(generated.silver) && generated.silver.length === 0 && (
                  <div style={{ color: "#888", fontSize: 14, padding: 8 }}>No silver medallist candidates found in Ashby.</div>
                )}
                {Array.isArray(generated.silver) && generated.silver.length > 0 && (
                  <>
                    <p style={{ fontSize: 13, color: "#888", margin: "0 0 14px" }}>
                      {generated.silver.length} candidates ranked by match — passed screening call, excluded poor culture fit
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {generated.silver.map((c, i) => (
                        <div key={c.id || i} style={{ border: "1px solid #e8e8e8", borderRadius: 10, overflow: "hidden" }}>
                          <div onClick={() => setExpandedCandidate(expandedCandidate === i ? null : i)}
                            style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                            <div style={{ width: 26, height: 26, borderRadius: "50%", background: i === 0 ? "#fef9c3" : "#f7f7f7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#555", flexShrink: 0 }}>{i + 1}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 14, color: "#1a1a2e" }}>{c.name}</div>
                              <div style={{ fontSize: 12, color: "#888", marginTop: 1 }}>
                                {[c.currentTitle, c.currentCompany].filter(Boolean).join(" · ")}
                                {c.previousRole && <span style={{ color: "#bbb" }}> · Previously: {c.previousRole}</span>}
                              </div>
                            </div>
                            <div style={{ background: scoreBg(c.matchScore), color: scoreColor(c.matchScore), fontSize: 12, fontWeight: 700, padding: "3px 9px", borderRadius: 16, flexShrink: 0 }}>{c.matchScore}%</div>
                            <div style={{ fontSize: 11, color: "#bbb", flexShrink: 0 }}>{expandedCandidate === i ? "▲" : "▼"}</div>
                          </div>

                          {expandedCandidate === i && (
                            <div style={{ borderTop: "1px solid #f0f0f0", padding: "14px", background: "#fafafa" }}>
                              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
                                {c.email && <div><div style={{ fontSize: 10, fontWeight: 700, color: "#aaa", textTransform: "uppercase", marginBottom: 2 }}>Email</div><a href={`mailto:${c.email}`} style={{ fontSize: 13, color: "#5b5bd6", textDecoration: "none" }}>{c.email}</a></div>}
                                {c.stageReached && <div><div style={{ fontSize: 10, fontWeight: 700, color: "#aaa", textTransform: "uppercase", marginBottom: 2 }}>Stage Reached</div><div style={{ fontSize: 13 }}>{c.stageReached}</div></div>}
                                {c.appliedAt && <div><div style={{ fontSize: 10, fontWeight: 700, color: "#aaa", textTransform: "uppercase", marginBottom: 2 }}>Applied</div><div style={{ fontSize: 13 }}>{c.appliedAt}</div></div>}
                                {c.archiveReason && <div><div style={{ fontSize: 10, fontWeight: 700, color: "#aaa", textTransform: "uppercase", marginBottom: 2 }}>Archive Reason</div><div style={{ fontSize: 13 }}>{c.archiveReason}</div></div>}
                              </div>
                              {c.matchReason && <div style={{ marginBottom: 12 }}><div style={{ fontSize: 10, fontWeight: 700, color: "#aaa", textTransform: "uppercase", marginBottom: 4 }}>Why they match</div><div style={{ fontSize: 13, color: "#444", lineHeight: 1.6 }}>{c.matchReason}</div></div>}
                              {c.suggestedOutreach && (
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: "#aaa", textTransform: "uppercase", marginBottom: 4 }}>Re-engagement message</div>
                                  <div style={{ background: "#fff", border: "1px solid #e8e8e8", borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", marginBottom: 8 }}>{c.suggestedOutreach}</div>
                                  <button onClick={() => navigator.clipboard.writeText(c.suggestedOutreach)} style={{ padding: "5px 12px", background: "#fff", border: "1px solid #e8e8e8", color: "#555", borderRadius: 8, fontSize: 12, cursor: "pointer" }}>Copy message</button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {hasGenerated && !loading && generated._raw && (
          <button onClick={() => navigator.clipboard.writeText(generated._raw)} style={{ marginTop: 12, width: "100%", padding: "13px", background: "#fff", border: "1px solid #e8e8e8", color: "#555", borderRadius: 10, fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
            Copy all outputs
          </button>
        )}
      </div>
    </div>
  );
}
