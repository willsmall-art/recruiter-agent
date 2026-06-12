import { useState, useRef, useEffect } from "react";

const OUTPUTS = [
  { id: "jd",        label: "Job Description",   icon: "📄", keyword: "Job Description" },
  { id: "sourcing",  label: "Sourcing Message",   icon: "💼", keyword: "Sourcing Message" },
  { id: "prep",      label: "Interview Prep",     icon: "📋", keyword: "Interview Prep" },
  { id: "post",      label: "LinkedIn Post",      icon: "📣", keyword: "LinkedIn Post" },
  { id: "boolean",   label: "Boolean & X-Ray",    icon: "🔍", keyword: "Boolean" },
  { id: "targets",   label: "Target Companies",   icon: "🎯", keyword: "Target Companies" },
  { id: "questions", label: "Interview Questions", icon: "💬", keyword: "Interview Questions" },
  { id: "silver",    label: "Silver Medalists",   icon: null, keyword: null, isAshby: true },
];

const MINT         = "#3ECFA3";
const NAVY         = "#111827";
const OFF          = "#f7f6f3";
const ASHBY_ORANGE = "#FF5B35";

// Street Group pipeline — stages AFTER Technical Interview count as silver
// Anyone at or past these stages (and archived) = silver medalist
const POST_TECHNICAL_STAGES = [
  "final interview", "final stage", "second interview", "third interview",
  "culture fit", "values interview", "executive interview", "ceo interview",
  "offer", "reference check", "references", "background check",
  "contract", "hired", "panel interview", "panel", "presentation",
  "case study", "task review", "take home review", "senior interview",
  "director interview", "vp interview"
];

// The technical interview stage itself counts too
const TECHNICAL_STAGE_NAMES = [
  "technical interview", "technical screen", "technical assessment",
  "technical", "tech interview", "coding interview", "skills test",
  "technical task", "take home", "take home task"
];

function isAtOrPastTechnical(stageName) {
  if (!stageName) return false;
  const s = stageName.toLowerCase();
  return TECHNICAL_STAGE_NAMES.some(t => s.includes(t)) ||
         POST_TECHNICAL_STAGES.some(t => s.includes(t));
}

const AshbyLogo = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
    <rect width="32" height="32" rx="6" fill={ASHBY_ORANGE}/>
    <path d="M16 7L22.5 19.5H9.5L16 7Z" fill="white"/>
    <circle cx="16" cy="23" r="3" fill="white"/>
  </svg>
);

function parseSections(text, activeIds) {
  const active = OUTPUTS.filter(o => activeIds.includes(o.id) && !o.isAshby);
  if (active.length === 0) return [{ id: "all", label: "Output", content: text }];
  const boundaries = [];
  for (const o of active) {
    const regex = new RegExp(`(^|\\n)[\\s#*_]*${o.keyword.replace(/&/g, "(&|and)")}[\\s#*_]*`, "i");
    const match = regex.exec(text);
    if (match) boundaries.push({ id: o.id, index: match.index + (match[1] ? 1 : 0) });
  }
  boundaries.sort((a, b) => a.index - b.index);
  if (boundaries.length === 0) return [{ id: active[0].id, label: active[0].label, icon: active[0].icon, content: text }];
  const sections = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].index;
    const end   = boundaries[i + 1]?.index ?? text.length;
    const o     = OUTPUTS.find(x => x.id === boundaries[i].id);
    sections.push({ id: o.id, label: o.label, icon: o.icon, content: text.slice(start, end).trim() });
  }
  if (boundaries[0].index > 0) {
    const prefix = text.slice(0, boundaries[0].index).trim();
    if (prefix) sections[0].content = prefix + "\n\n" + sections[0].content;
  }
  return sections;
}

// ─── ASHBY via Anthropic API (only allowed external call from claude.ai) ──────
// claude.ai blocks all external fetches except api.anthropic.com.
// We pass the Ashby request to Claude as a user message, Claude fetches
// recruiter-agent-three.vercel.app/api/ashby server-side and returns the JSON.

const VERCEL_ASHBY_URL = "https://recruiter-agent-three.vercel.app/api/ashby";

async function ashbyCall(apiKey, endpoint, body = {}) {
  const payload = JSON.stringify({ endpoint, body });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system: `You are a JSON API proxy. When asked to fetch a URL, fetch it and return ONLY the raw JSON response body. No explanation, no markdown, no extra text. Your entire response must be valid JSON starting with { or [.`,
      messages: [{
        role: "user",
        content: `Fetch this URL with a POST request and return ONLY the JSON response body:\n\nURL: ${VERCEL_ASHBY_URL}\nMethod: POST\nContent-Type: application/json\nBody: ${payload}\n\nReturn ONLY the raw JSON. Nothing else.`
      }]
    })
  });

  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text || "").join("");

  if (!text.trim()) throw new Error("Empty response");

  // Extract JSON robustly
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") { start = i; break; }
  }
  if (start === -1) throw new Error(`No JSON found: ${text.slice(0, 150)}`);

  const openChar = text[start], closeChar = openChar === "{" ? "}" : "]";
  let depth = 0, end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    if (text[i] === closeChar) depth--;
    if (depth === 0) { end = i; break; }
  }
  if (end === -1) throw new Error("Incomplete JSON");

  const parsed = JSON.parse(text.slice(start, end + 1));
  if (parsed?.error) throw new Error(parsed.error);
  return parsed;
}

async function ashbyListAll(apiKey, endpoint, extraBody = {}, maxPages = 5) {
  let results = [];
  let cursor  = null;
  let page    = 0;
  do {
    const data = await ashbyCall(apiKey, endpoint, { limit: 100, ...extraBody, ...(cursor ? { cursor } : {}) });
    results = results.concat(data.results || []);
    cursor  = data.nextCursor || null;
    page++;
  } while (cursor && page < maxPages);
  return results;
}

// Extract role title

// Extract role title — first try simple regex on notes, fallback to Claude
async function extractRoleTitle(notes) {
  const lines = notes.split("\n").map(l => l.trim()).filter(Boolean);

  // Try to find an explicit "Role: X" or "Title: X" line first
  for (const line of lines) {
    const m = line.match(/^(?:role|title|position|job title|hiring for)[:\s\-]+(.{3,60})$/i);
    if (m) return m[1].trim();
  }

  // Try first short line that looks like a job title (2-6 words, title case or all caps)
  for (const line of lines) {
    if (line.length >= 5 && line.length <= 60 && /^[A-Z]/.test(line) && line.split(" ").length <= 6 && !line.includes(",") && !line.includes(".")) {
      return line;
    }
  }

  // Fallback to Claude
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 30,
      messages: [{ role: "user", content: `What is the job title in these hiring notes? Reply with ONLY the job title, nothing else.\n\n${notes.slice(0, 400)}` }]
    })
  });
  const data = await res.json();
  return data.content?.map(b => b.text || "").join("").trim().replace(/^["']|["']$/g, "") || "this role";
}

async function getSimilarTitles(roleTitle) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      messages: [{ role: "user", content: `List 6 alternative job titles for "${roleTitle}". Return ONLY a JSON array of short title strings, nothing else. Example: ["Product Manager","Senior PM","Group PM","Head of Product","Principal PM","VP Product"]` }]
    })
  });
  const data = await res.json();
  const text = data.content?.map(b => b.text || "").join("") || "[]";
  try {
    const start = text.indexOf("[");
    const end   = text.lastIndexOf("]");
    if (start === -1 || end === -1) return [roleTitle];
    const arr = JSON.parse(text.slice(start, end + 1));
    return arr.filter(t => typeof t === "string" && t.length < 60 && !t.includes("."));
  } catch { return [roleTitle]; }
}

function titleMatches(jobTitle, targets) {
  const jt = jobTitle.toLowerCase().trim();
  return targets.some(t => {
    const target = t.toLowerCase().trim();
    if (!target || target.length < 3) return false;
    const targetWords = target.split(/\s+/).filter(w => w.length > 3);
    return jt === target ||
           jt.includes(target) ||
           target.includes(jt) ||
           (targetWords.length > 0 && targetWords.filter(w => jt.includes(w)).length >= Math.ceil(targetWords.length * 0.6));
  });
}

async function runFullAshbySearch(apiKey, notes, onProgress) {
  onProgress("Extracting job title from notes…");
  const roleTitle     = await extractRoleTitle(notes);

  onProgress(`Searching for "${roleTitle}" and similar titles…`);
  const similarTitles = await getSimilarTitles(roleTitle);
  const allTitles     = [roleTitle, ...similarTitles];

  onProgress(`Fetching all Ashby jobs to match against ${allTitles.length} titles…`);
  const allJobs     = await ashbyListAll(apiKey, "job.list", {}, 10);
  const matchedJobs = allJobs.filter(job => titleMatches(job.title || "", allTitles));

  if (matchedJobs.length === 0) {
    return { candidates: [], roleTitle, allTitles, matchedJobs: [], totalApps: 0 };
  }

  onProgress(`Found ${matchedJobs.length} matching job${matchedJobs.length !== 1 ? "s" : ""} — fetching applications…`);

  const silverMedalists = [];
  let totalApps = 0;

  // Your Street Group pipeline order (from Ashby):
  // 1: CV Shortlisting, 2: Screening Call, 3: Screening Call completed,
  // 4: Intro call, 5: Technical Interview, 6+: Final Interview, Offer etc.
  // "Archived" is a system stage (order 11) — must be excluded
  // Silver medalist = currentInterviewStage.title is NOT "Archived" AND
  // either the title matches technical/final/offer etc, OR orderInInterviewPlan >= 5

  const EXCLUDED_STAGES = ["archived", "hired", "withdrawn", "declined"];

  for (const job of matchedJobs.slice(0, 20)) {
    try {
      for (const status of ["Archived", "Active"]) {
        const apps = await ashbyListAll(apiKey, "application.list", { jobId: job.id, status }, 5);
        totalApps += apps.length;

        for (const app of apps) {
          // Read stage from the correct Ashby field
          const stageObj   = app.currentInterviewStage || {};
          const stageTitle = stageObj.title || app.currentInterviewStageName || app.interviewStageName || "";
          const stageOrder = stageObj.orderInInterviewPlan || 0;
          const stageLower = stageTitle.toLowerCase();

          // Skip system stages — these aren't real interview stages
          if (EXCLUDED_STAGES.some(e => stageLower === e)) continue;

          // Silver medalist = reached Technical Interview (order 5) or beyond
          // Also catch by name in case order varies
          const qualifies = stageOrder >= 5 || isAtOrPastTechnical(stageTitle);

          if (qualifies) {
            const candidateId = app.candidate?.id || app.candidateId;
            const dup = silverMedalists.some(
              sm => (sm.candidate?.id || sm.candidateId) === candidateId && sm._jobTitle === job.title
            );
            if (!dup) {
              silverMedalists.push({
                ...app,
                _jobTitle:   job.title,
                _jobStatus:  job.status || "Unknown",
                _stageFound: stageTitle,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Skipping job ${job.id}:`, e.message);
    }
  }

  silverMedalists.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  onProgress(null);
  return { candidates: silverMedalists, roleTitle, allTitles, matchedJobs, totalApps };
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────────────────
export default function RecruiterAgent() {
  const [notes,      setNotes]      = useState("");
  const [selected,   setSelected]   = useState(Object.fromEntries(OUTPUTS.map(o => [o.id, true])));
  const [loading,    setLoading]    = useState(false);
  const [sections,   setSections]   = useState(null);
  const [activeTab,  setActiveTab]  = useState(null);
  const [error,      setError]      = useState(null);
  const [copied,     setCopied]     = useState(false);

  const [ashbyKey,      setAshbyKey]      = useState("");
  const [ashbyKeyInput, setAshbyKeyInput] = useState("");
  const [ashbyKeySaved, setAshbyKeySaved] = useState(true); // Vercel handles the key
  const [ashbyLoading,  setAshbyLoading]  = useState(false);
  const [ashbyProgress, setAshbyProgress] = useState("");
  const [ashbyResults,  setAshbyResults]  = useState(null);
  const [ashbyError,    setAshbyError]    = useState(null);
  const [showKeyInput,  setShowKeyInput]  = useState(false);

  const contentRef = useRef(null);

  // Load saved Ashby key from persistent storage on first render
  useEffect(() => {
    (async () => {
      try {
        const stored = await window.storage.get("ashby_api_key");
        if (stored?.value) {
          setAshbyKey(stored.value);
          setAshbyKeySaved(true);
        }
      } catch {
        // Key not stored yet — that's fine
      }
    })();
  }, []);

  const activeOutputs = OUTPUTS.filter(o => selected[o.id]);
  const allSelected   = activeOutputs.length === OUTPUTS.length;
  const silverSelected = selected["silver"];

  const toggleOutput = id => setSelected(p => ({ ...p, [id]: !p[id] }));
  const toggleAll    = () => setSelected(Object.fromEntries(OUTPUTS.map(o => [o.id, !allSelected])));

  const buildPrompt = () => {
    const aiOutputs = activeOutputs.filter(o => !o.isAshby);
    const outputList = aiOutputs.map(o => o.label).join(", ");
    const sel = id => aiOutputs.some(o => o.id === id);

    // Base system context — always included, kept tight
    let prompt = `Street Group AI Recruiter Agent. Produce only the requested outputs, clearly labelled with exact heading names.

OUTPUTS NEEDED: ${outputList}

KICKOFF NOTES:
${notes}

---
`;

    // Only include instructions for selected outputs
    if (sel("jd")) prompt += `
JOB DESCRIPTION: Job title + 📍 location + 💰 salary | Company intro (use boilerplate below) | Role hook (2–3 sentences) | A bit about you (2nd person bullets) | What you'll be working on (action bullets) | D&I nudge (verbatim): "We recognise that women and people from underrepresented groups often only apply for jobs when they meet every single one of the requirements listed. If you fall into that category and are about to rule yourself out based on the above criteria; please consider applying anyway. We'd love to see your application!" | Who are Street Group? (boilerplate) | Why join us? (benefits list) | Salary caveat | Interview process + (verbatim): "We want to make our interviews as inclusive as possible, so if you need any adjustments made, or if there's anything you think we should be aware of during the interview process, please do let us know!" | AI note (verbatim): "As a fast-moving and rapidly evolving tech company, we embrace the advantages of AI and encourage its use throughout our application process. However, our goal is to get to know and hire the authentic you - your skills, experience, and values. We don't want to hire an AI-generated version of you. We consider AI to be a valuable tool, not something that should overshadow you as an individual."
`;

    if (sel("sourcing")) prompt += `
SOURCING MESSAGE: <100 words. Warm, direct, role-specific. [CANDIDATE NAME] placeholder. Don't open with "I hope this message finds you well". Soft CTA at end.
`;

    if (sel("prep")) prompt += `
INTERVIEW PREP: Role summary (3 sentences) | What great looks like (3–5 bullets) | 8 tailored questions with what to listen for | Red flags | Scoring guide (1–5).
`;

    if (sel("post")) prompt += `
LINKEDIN POST: Two options — Option 1: <80 words punchy. Option 2: 100–150 words storytelling. Both: short sentences, warm, 1–3 emojis max, [RECRUITER NAME] placeholder, 2–3 hashtags. Never open with "Excited to share" or "We're hiring!". No exclamation marks on every line.
`;

    if (sel("boolean")) prompt += `
BOOLEAN & X-RAY: LinkedIn Boolean string (1 line) | Google X-Ray string (1 line) | 4 alternative title variants with 1-line notes each | Note: confirm min 3 years experience at screening.
`;

    if (sel("targets")) prompt += `
TARGET COMPANIES: Using the role, seniority and skills from the kickoff notes, list 30 companies where this type of person is likely working now. Industry doesn't matter — focus on fit for THIS role. Include SaaS, fintech, healthtech, ecommerce, agencies, scale-ups with strong cultures. Geography: Manchester/NW first (MediaCityUK, Spinningfields, Salford, Stockport), then Leeds/Sheffield/Liverpool, then UK remote-first. For each: company + location | why strong source for this role (2 sentences, reference specific skills from notes) | team to target | culture fit note (1 sentence). Numbered 1–30.
`;

    if (sel("questions")) prompt += `
INTERVIEW QUESTIONS: 10 questions specific to this role and kickoff notes — no generic questions. Mix: behavioural, situational, technical, motivational. Progressive difficulty. For each: bold question + "What to listen for:" with 2–3 strong-answer indicators.
`;

    // Only include boilerplate/benefits if JD is selected
    if (sel("jd")) prompt += `
---
STREET GROUP BOILERPLATE: "We're an award-winning PropTech business based in Manchester, founded in 2015 by brother and sister duo, Tom & Heather Staff. Most of us have personal experience of how painful moving can be, and Tom and Heather saw an opportunity to change this: utilising technology, as well as our incredibly talented team, to improve the industry for everyone. Our products, Street.co.uk and Spectre form a powerful duo, working harmoniously together to transform an agent's job. From securing more leads and winning new instructions to streamlining business operations and growing market share, our products are supercharging 1,000s of agencies across the UK. Back in 2015, our co-Founder, Tom Staff, spent his evenings building Spectre v1.0. He'd seen first-hand an opportunity to automate the very manual process of winning new business for estate agents. Spectre is now our multi award-winning, instruction generation tool, generating an average return on investment for them of over 3000%."

BENEFITS: 🏠 Hybrid-working (4 days WFH) | 🏖️ £1000 holiday after year 1 | 💪 Culture supporting growth | 📚 £500 L&D budget | 🎂 Birthday off | 🙋 2 paid volunteering days | 👶 Enhanced parental pay | 🧠 Mental health support (Health Assured) | 🕒 Flexible hours | 🚂 Season ticket loans | 🌷 Paid menopause leave | 🌞 Holiday buying scheme | 🚀 Ambitious growing business | 👩🏿‍💻 Cutting-edge tech | 🐶 Office dogs | 🍻 Stocked fridge + Friday beers | 🎊 Offsites & events | 🚴 Cycle to work | 🚗 EV salary sacrifice | 🌍 Climate-positive
`;

    prompt += `
---
TOV: warm, direct, no corporate fluff. Second person in candidate-facing sections.
Each section heading must exactly match its output name.`;

    return prompt;
  };

  // Scale max_tokens to what's actually being generated
  const estimateMaxTokens = () => {
    const aiOutputs = activeOutputs.filter(o => !o.isAshby);
    const tokenMap = { jd: 1200, sourcing: 200, prep: 800, post: 400, boolean: 300, targets: 1800, questions: 900 };
    const total = aiOutputs.reduce((sum, o) => sum + (tokenMap[o.id] || 400), 0);
    return Math.min(Math.max(total + 200, 500), 6000);
  };

  const generate = async () => {
    if (!notes.trim() || activeOutputs.length === 0) return;
    setLoading(true);
    setSections(null);
    setAshbyResults(null);
    setAshbyError(null);
    setError(null);

    const aiOutputs = activeOutputs.filter(o => !o.isAshby);
    let parsedSections = [];

    if (aiOutputs.length > 0) {
      try {
        const res  = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: estimateMaxTokens(),
            messages: [{ role: "user", content: buildPrompt() }],
          }),
        });
        const data = await res.json();
        const text = data.content?.map(b => b.text || "").join("") || "";
        parsedSections = parseSections(text, aiOutputs.map(o => o.id));
      } catch {
        setError("AI generation failed. Please try again.");
        setLoading(false);
        return;
      }
    }

    if (silverSelected) {
      parsedSections.push({ id: "silver", label: "Silver Medalists", icon: null, isAshby: true });
    }

    setSections(parsedSections);
    setActiveTab(parsedSections[0]?.id ?? null);
    setLoading(false);

    // Kick off Ashby search if key is ready
    if (silverSelected && ashbyKeySaved && ashbyKey) {
      doAshbySearch();
    }
  };

  const doAshbySearch = async () => {
    setAshbyLoading(true);
    setAshbyResults(null);
    setAshbyError(null);
    try {
      const results = await runFullAshbySearch(null, notes, (msg) => setAshbyProgress(msg || ""));
      setAshbyResults(results);
    } catch (e) {
      let msg = e.message || "Unknown error";
      if (msg.includes("401") || msg.includes("403")) msg = "Invalid API key or missing permissions. Check candidatesRead + jobsRead in Ashby (Admin → Integrations → API Keys).";
      else if (msg.includes("404")) msg = "Ashby endpoint not found — check your API key is correct.";
      setAshbyError(msg);
    }
    setAshbyProgress("");
    setAshbyLoading(false);
  };

  const saveAshbyKey = async () => {
    if (!ashbyKeyInput.trim()) return;
    const key = ashbyKeyInput.trim();
    setAshbyKey(key);
    setAshbyKeySaved(true);
    setShowKeyInput(false);
    try { await window.storage.set("ashby_api_key", key); } catch {}
  };

  const removeAshbyKey = async () => {
    setAshbyKeySaved(false);
    setAshbyKey("");
    setAshbyKeyInput("");
    setShowKeyInput(false);
    try { await window.storage.delete("ashby_api_key"); } catch {}
  };

  const currentSection = sections?.find(s => s.id === activeTab);

  const handleCopy = () => {
    navigator.clipboard.writeText(currentSection?.content ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const handleCopyAll = () => {
    navigator.clipboard.writeText(sections?.filter(s => !s.isAshby).map(s => s.content).join("\n\n---\n\n") ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "silver" && ashbyKeySaved && ashbyKey && !ashbyResults && !ashbyLoading && !ashbyError && notes) {
      doAshbySearch();
    }
  }, [activeTab]);

  const tabIdx = sections ? sections.findIndex(s => s.id === activeTab) : -1;

  return (
    <div style={{ fontFamily: "'DM Sans','Inter',system-ui,sans-serif", minHeight: "100vh", background: OFF, color: NAVY }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        @keyframes spin   { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:.4} }
        .sg-toggle        { transition: all .15s; }
        .sg-toggle:hover  { border-color: #3ECFA3 !important; }
        .sg-toggle.on     { background:#edfaf5 !important; border-color:#3ECFA3 !important; color:#0a5c44 !important; }
        .sg-toggle.on .dot{ background:#3ECFA3 !important; }
        .sg-toggle.ashby-on { background:#edfaf5 !important; border-color:#3ECFA3 !important; color:#0a5c44 !important; }
        .sg-toggle.ashby-on .dot { background:#3ECFA3 !important; }
        .sg-tab           { transition: all .15s; cursor:pointer; }
        .sg-tab:hover     { border-color:#3ECFA3 !important; color:#0a5c44 !important; background:#edfaf5 !important; }
        .sg-tab.active    { background:#edfaf5 !important; border-color:#3ECFA3 !important; color:#0a5c44 !important; }
        .sg-tab.active .tab-dot { background:#3ECFA3 !important; }
        .sg-tab.ashby-tab:hover { border-color:#3ECFA3 !important; color:#0a5c44 !important; background:#edfaf5 !important; }
        .sg-tab.ashby-tab.active { background:#edfaf5 !important; border-color:#3ECFA3 !important; color:#0a5c44 !important; }
        .sg-tab.ashby-tab.active .tab-dot { background:#3ECFA3 !important; }
        .sg-generate:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 8px 24px rgba(62,207,163,.3) !important; }
        .sg-generate:active:not(:disabled){ transform:translateY(0); }
        .sg-sec:hover { border-color:#3ECFA3 !important; color:#0a5c44 !important; background:#f0fdf8 !important; }
        textarea:focus { outline:none; border-color:#3ECFA3 !important; box-shadow:0 0 0 3px rgba(62,207,163,.12) !important; }
        input:focus    { outline:none; border-color:#3ECFA3 !important; box-shadow:0 0 0 3px rgba(62,207,163,.12) !important; }
        .fade { animation: fadeUp .35s ease; }
        .cand-row:hover { background:#f7f6f3 !important; }
        .title-pill { font-size:11px; background:#edfaf5; border:1px solid #3ECFA3; color:#0a5c44; padding:2px 8px; border-radius:100px; font-weight:600; white-space:nowrap; }
      `}</style>

      {/* NAV */}
      <nav style={{ background: NAVY, padding: "0 24px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill={MINT}/>
            <path d="M8 11C8 11 10 9 14 9C18 9 20 12 16 14C12 16 10 17 10 20C10 22 12 23 16 23C19 23 21 22 22 21" stroke={NAVY} strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          <span style={{ fontWeight: 700, fontSize: 16, color: "#fff", letterSpacing: "-0.02em" }}>Street Group</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {ashbyKeySaved && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(62,207,163,.15)", border: "1px solid rgba(62,207,163,.4)", borderRadius: 100, padding: "4px 10px" }}>
              <AshbyLogo size={13}/>
              <span style={{ color: MINT, fontSize: 11, fontWeight: 600 }}>Ashby connected</span>
              <button onClick={removeAshbyKey} style={{ background: "none", border: "none", color: "rgba(62,207,163,.6)", fontSize: 11, cursor: "pointer", padding: "0 0 0 4px", fontFamily: "inherit", lineHeight: 1 }} title="Remove key">✕</button>
            </div>
          )}
          <div style={{ background: "rgba(62,207,163,.15)", border: "1px solid rgba(62,207,163,.4)", color: MINT, fontSize: 11, fontWeight: 600, padding: "5px 14px", borderRadius: 100, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Recruiter Agent
          </div>
        </div>
      </nav>

      <div style={{ maxWidth: 700, margin: "0 auto", padding: "0 20px 60px" }}>

        {/* ══ INPUT STATE ══ */}
        {!sections && !loading && (
          <div className="fade">
            <div style={{ padding: "44px 0 32px", position: "relative" }}>
              <svg style={{ position: "absolute", top: 16, right: -8, opacity: .1 }} width="120" height="90" viewBox="0 0 120 90" fill="none">
                <path d="M10 75 C 20 15, 60 15, 60 45 C 60 75, 100 75, 110 15" stroke={MINT} strokeWidth="4" strokeLinecap="round" fill="none"/>
              </svg>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MINT, margin: "0 0 10px" }}>Hiring Kickoff</p>
              <h1 style={{ fontSize: 34, fontWeight: 700, margin: "0 0 12px", color: NAVY, lineHeight: 1.15, letterSpacing: "-0.03em" }}>
                Generate everything.<br/><span style={{ color: MINT }}>In one go.</span>
              </h1>
              <p style={{ fontSize: 15, color: "#6b7280", margin: 0, lineHeight: 1.6 }}>
                Paste your kickoff notes — job description, sourcing, interview prep and more, ready instantly.
              </p>
            </div>

            <div style={{ background: "#fff", borderRadius: 20, padding: "28px", border: "1px solid #e8e6e1" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#9ca3af", textTransform: "uppercase" }}>Kickoff Notes</span>
                <span style={{ fontSize: 12, color: "#9ca3af" }}>{notes.length > 0 ? `${notes.length} chars` : "Paste or type below"}</span>
              </div>
              <textarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Role title, team, salary range, key responsibilities, must-haves, interview process..."
                style={{ width: "100%", minHeight: 160, background: OFF, border: "1.5px solid #e8e6e1", borderRadius: 12, padding: "14px 16px", color: NAVY, fontSize: 14, lineHeight: 1.65, resize: "vertical", fontFamily: "inherit", boxSizing: "border-box", transition: "border-color .15s, box-shadow .15s", marginBottom: 24 }}
              />

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#9ca3af", textTransform: "uppercase" }}>Outputs</span>
                <button onClick={toggleAll} style={{ background: "none", border: "none", fontSize: 12, color: MINT, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                  {allSelected ? "Deselect all" : "Select all"}
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
                {OUTPUTS.map(o => {
                  const isOn = selected[o.id];
                  const isAshby = o.isAshby;
                  return (
                    <button key={o.id} onClick={() => toggleOutput(o.id)}
                      className={`sg-toggle${isAshby ? (isOn ? " ashby-on" : "") : (isOn ? " on" : "")}`}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderRadius: 10,
                        border: `1.5px solid ${isAshby && isOn ? MINT : isOn ? MINT : "#e8e6e1"}`,
                        background: isAshby && isOn ? "#edfaf5" : isOn ? "#edfaf5" : "#fafaf9",
                        color: isAshby && isOn ? "#0a5c44" : isOn ? "#0a5c44" : "#6b7280",
                        fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                      <span className="dot" style={{ width: 8, height: 8, borderRadius: "50%",
                        background: isAshby && isOn ? MINT : isOn ? MINT : "#d1d5db",
                        flexShrink: 0, transition: "background .15s" }}/>
                      {isAshby ? <AshbyLogo size={15}/> : <span style={{ fontSize: 15 }}>{o.icon}</span>}
                      {o.label}
                    </button>
                  );
                })}
              </div>




              <button onClick={generate} disabled={!notes.trim() || activeOutputs.length === 0} className="sg-generate"
                style={{ width: "100%", padding: "17px", background: notes.trim() && activeOutputs.length > 0 ? MINT : "#e5e7eb", color: notes.trim() && activeOutputs.length > 0 ? NAVY : "#9ca3af", border: "none", borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: notes.trim() && activeOutputs.length > 0 ? "pointer" : "not-allowed", transition: "all .2s", letterSpacing: "-0.01em", fontFamily: "inherit" }}>
                Generate everything →
              </button>
            </div>
          </div>
        )}

        {/* ══ LOADING ══ */}
        {loading && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 20 }}>
            <div style={{ position: "relative", width: 60, height: 60 }}>
              <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "3px solid rgba(62,207,163,.15)", borderTopColor: MINT, animation: "spin .9s linear infinite" }}/>
              <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 10, height: 10, borderRadius: "50%", background: MINT, animation: "pulse 1.5s ease-in-out infinite" }}/>
            </div>
            <div style={{ textAlign: "center" }}>
              <p style={{ color: NAVY, fontWeight: 600, fontSize: 16, margin: "0 0 4px" }}>Working on it…</p>
              <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>
                Generating {activeOutputs.filter(o => !o.isAshby).length} AI output{activeOutputs.filter(o => !o.isAshby).length !== 1 ? "s" : ""}
                {silverSelected ? " + Ashby search queued" : ""}
              </p>
            </div>
          </div>
        )}

        {error && !loading && (
          <div style={{ background: "#fff5f2", border: "1px solid #fecaca", borderRadius: 12, padding: 16, color: "#dc2626", fontSize: 14, marginTop: 20 }}>{error}</div>
        )}

        {/* ══ RESULTS ══ */}
        {sections && !loading && (
          <div className="fade">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "36px 0 20px" }}>
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MINT, margin: "0 0 4px" }}>Done</p>
                <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: NAVY, letterSpacing: "-0.02em" }}>Your outputs</h2>
              </div>
              <button onClick={() => { setSections(null); setNotes(""); setAshbyResults(null); setAshbyError(null); }} className="sg-sec"
                style={{ background: "#fff", border: "1.5px solid #e8e6e1", color: "#6b7280", fontSize: 13, fontWeight: 600, padding: "9px 18px", borderRadius: 100, cursor: "pointer", fontFamily: "inherit" }}>
                ← New role
              </button>
            </div>

            {/* TABS */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#9ca3af", textTransform: "uppercase" }}>Outputs</span>
                <span style={{ fontSize: 12, color: "#9ca3af" }}>{sections.length} generated</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {sections.map(s => {
                  const isAshby  = s.isAshby;
                  const isActive = activeTab === s.id;
                  return (
                    <button key={s.id} onClick={() => setActiveTab(s.id)}
                      className={`sg-tab${isAshby ? " ashby-tab" : ""}${isActive ? " active" : ""}`}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderRadius: 10,
                        border: `1.5px solid ${isAshby && isActive ? MINT : isActive ? MINT : "#e8e6e1"}`,
                        background: isAshby && isActive ? "#edfaf5" : isActive ? "#edfaf5" : "#fff",
                        color: isAshby && isActive ? "#0a5c44" : isActive ? "#0a5c44" : "#6b7280",
                        fontSize: 13, fontWeight: 500, fontFamily: "inherit", textAlign: "left" }}>
                      <span className="tab-dot" style={{ width: 8, height: 8, borderRadius: "50%",
                        background: isAshby && isActive ? MINT : isActive ? MINT : "#d1d5db",
                        flexShrink: 0, transition: "background .15s" }}/>
                      {isAshby ? <AshbyLogo size={15}/> : <span style={{ fontSize: 15 }}>{s.icon}</span>}
                      {s.label}
                      {isAshby && ashbyLoading && (
                        <span style={{ marginLeft: "auto", width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(62,207,163,.2)", borderTopColor: MINT, animation: "spin .8s linear infinite", display: "inline-block" }}/>
                      )}
                      {isAshby && ashbyResults && !ashbyLoading && (
                        <span style={{ marginLeft: "auto", fontSize: 11, background: MINT, color: NAVY, padding: "2px 8px", borderRadius: 100, fontWeight: 700 }}>
                          {ashbyResults.candidates.length}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── AI SECTION CONTENT ── */}
            {currentSection && !currentSection.isAshby && (
              <div key={activeTab} className="fade">
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, padding: "10px 16px", background: "#edfaf5", borderRadius: 10, border: `1px solid ${MINT}` }}>
                  <span style={{ fontSize: 17 }}>{currentSection.icon}</span>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#0a5c44" }}>{currentSection.label}</span>
                  <div style={{ flex: 1 }}/>
                  <button onClick={handleCopy}
                    style={{ background: copied ? MINT : "#fff", border: `1px solid ${MINT}`, color: copied ? NAVY : "#0a5c44", fontSize: 12, fontWeight: 600, padding: "5px 14px", borderRadius: 100, cursor: "pointer", fontFamily: "inherit", transition: "all .2s" }}>
                    {copied ? "✓ Copied" : "Copy this"}
                  </button>
                </div>
                <div ref={contentRef} style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 16, padding: "24px 26px", fontSize: 14, lineHeight: 1.85, color: NAVY, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 520, overflowY: "auto" }}>
                  {currentSection.content}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 12, gap: 10 }}>
                  <button disabled={tabIdx === 0} onClick={() => { if (tabIdx > 0) setActiveTab(sections[tabIdx-1].id); }} className="sg-sec"
                    style={{ padding: "12px 20px", background: "#fff", border: "1.5px solid #e8e6e1", color: "#6b7280", borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: tabIdx === 0 ? "not-allowed" : "pointer", opacity: tabIdx === 0 ? .4 : 1, fontFamily: "inherit", transition: "all .15s" }}>
                    ← Previous
                  </button>
                  <button onClick={handleCopyAll}
                    style={{ flex: 1, padding: "12px", background: NAVY, border: "none", color: "#fff", borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    Copy all outputs
                  </button>
                  <button disabled={tabIdx === sections.length - 1} onClick={() => { if (tabIdx < sections.length-1) setActiveTab(sections[tabIdx+1].id); }} className="sg-sec"
                    style={{ padding: "12px 20px", background: "#fff", border: "1.5px solid #e8e6e1", color: "#6b7280", borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: tabIdx === sections.length-1 ? "not-allowed" : "pointer", opacity: tabIdx === sections.length-1 ? .4 : 1, fontFamily: "inherit", transition: "all .15s" }}>
                    Next →
                  </button>
                </div>
              </div>
            )}

            {/* ── SILVER MEDALIST TAB ── */}
            {currentSection?.isAshby && (
              <div key="silver" className="fade">

                {/* Header */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "10px 16px", background: "#edfaf5", borderRadius: 10, border: `1px solid ${MINT}` }}>
                  <AshbyLogo size={16}/>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 14, color: "#0a5c44" }}>Silver Medalists</span>
                    <span style={{ fontSize: 12, color: "#0a5c44", marginLeft: 8 }}>Candidates who reached Technical Interview or beyond</span>
                  </div>
                  <div style={{ flex: 1 }}/>
                  {ashbyKeySaved && ashbyResults && !ashbyLoading && (
                    <button onClick={() => doAshbySearch()}
                      style={{ fontSize: 12, fontWeight: 600, color: MINT, background: "none", border: `1px solid ${MINT}`, borderRadius: 100, padding: "4px 12px", cursor: "pointer", fontFamily: "inherit" }}>
                      Refresh
                    </button>
                  )}
                </div>

                {/* No API key */}
                {!ashbyKeySaved && (
                  <div style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 16, padding: "44px 28px", textAlign: "center" }}>
                    <AshbyLogo size={40}/>
                    <p style={{ fontWeight: 700, fontSize: 16, margin: "14px 0 6px", color: NAVY }}>Connect Ashby to search</p>
                    <p style={{ fontSize: 14, color: "#6b7280", margin: "0 0 24px", lineHeight: 1.6 }}>
                      Enter your Ashby API key — the tool will search all active, paused, and archived jobs for similar roles and surface anyone who made it past the Technical Interview.
                    </p>
                    <div style={{ display: "flex", gap: 8, maxWidth: 380, margin: "0 auto" }}>
                      <input type="password" value={ashbyKeyInput} onChange={e => setAshbyKeyInput(e.target.value)}
                        placeholder="ashby_api_key_••••••••"
                        onKeyDown={e => { if (e.key === "Enter") { saveAshbyKey(); doAshbySearch(); } }}
                        style={{ flex: 1, fontSize: 13, padding: "10px 14px", border: "1.5px solid #e8e6e1", borderRadius: 10, fontFamily: "inherit", background: OFF, color: NAVY }}/>
                      <button onClick={() => { saveAshbyKey(); if (ashbyKeyInput.trim()) doAshbySearch(); }}
                        style={{ fontSize: 13, fontWeight: 700, color: NAVY, background: MINT, border: "none", borderRadius: 10, padding: "10px 18px", cursor: "pointer", fontFamily: "inherit" }}>
                        Search
                      </button>
                    </div>
                  </div>
                )}

                {/* Loading */}
                {ashbyKeySaved && ashbyLoading && (
                  <div style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 16, padding: "48px 28px", textAlign: "center" }}>
                    <div style={{ width: 40, height: 40, borderRadius: "50%", border: "3px solid rgba(62,207,163,.15)", borderTopColor: MINT, animation: "spin .9s linear infinite", margin: "0 auto 16px" }}/>
                    <p style={{ color: NAVY, fontWeight: 600, fontSize: 15, margin: "0 0 6px" }}>{ashbyProgress || "Searching Ashby…"}</p>
                    <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>Checking active, paused and archived jobs for similar titles</p>
                  </div>
                )}

                {/* Error */}
                {ashbyKeySaved && ashbyError && !ashbyLoading && (
                  <div style={{ background: "#fff", border: "1px solid #fecaca", borderRadius: 16, padding: "24px 28px" }}>
                    <p style={{ color: "#dc2626", fontWeight: 700, fontSize: 14, margin: "0 0 6px" }}>Search failed</p>
                    <p style={{ color: "#dc2626", fontSize: 13, margin: "0 0 16px", lineHeight: 1.5 }}>{ashbyError}</p>
                    <p style={{ color: "#9ca3af", fontSize: 12, margin: "0 0 16px", lineHeight: 1.5 }}>
                      Make sure your API key has <strong>candidatesRead</strong> and <strong>jobsRead</strong> permissions enabled in Ashby (Admin → Integrations → API Keys).
                    </p>
                    <button onClick={() => doAshbySearch()}
                      style={{ fontSize: 13, fontWeight: 600, color: NAVY, background: MINT, border: "none", borderRadius: 8, padding: "9px 18px", cursor: "pointer", fontFamily: "inherit" }}>
                      Try again
                    </button>
                  </div>
                )}

                {/* Results */}
                {ashbyResults && !ashbyLoading && (
                  <div>
                    {/* Matched jobs + searched titles */}
                    <div style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 12, padding: "14px 18px", marginBottom: 12 }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 8px" }}>Searched job titles</p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {ashbyResults.allTitles.slice(0, 10).map(t => (
                          <span key={t} className="title-pill">{t}</span>
                        ))}
                      </div>
                      {ashbyResults.matchedJobs.length > 0 && (
                        <p style={{ fontSize: 12, color: "#6b7280", margin: "10px 0 0" }}>
                          Matched <strong>{ashbyResults.matchedJobs.length}</strong> job{ashbyResults.matchedJobs.length !== 1 ? "s" : ""} in Ashby across {ashbyResults.totalApps} total applications
                        </p>
                      )}
                    </div>

                    {ashbyResults.candidates.length === 0 ? (
                      <div style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 16, padding: "44px 28px", textAlign: "center" }}>
                        <p style={{ fontSize: 22 }}>🔍</p>
                        <p style={{ fontSize: 15, fontWeight: 600, color: NAVY, margin: "8px 0 6px" }}>No silver medalists found</p>
                        <p style={{ fontSize: 13, color: "#6b7280", margin: 0, lineHeight: 1.6 }}>
                          {ashbyResults.matchedJobs.length === 0
                            ? "No jobs with similar titles were found in Ashby. Try adding more detail to your kickoff notes."
                            : "No archived candidates who reached Technical Interview or beyond were found for these roles."}
                        </p>
                      </div>
                    ) : (
                      <div style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 16, overflow: "hidden" }}>
                        {/* Column headers */}
                        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 72px", padding: "10px 20px", borderBottom: "1px solid #e8e6e1", background: OFF }}>
                          {["Candidate", "Applied for", "Stage reached", ""].map(h => (
                            <span key={h} style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>{h}</span>
                          ))}
                        </div>

                        {ashbyResults.candidates.map((app, i) => {
                          const name  = app.candidate?.name || app.candidateName || "Unknown";
                          const job   = app._jobTitle || app.job?.title || app.jobTitle || "—";
                          const stage = app._stageFound || app.currentInterviewStage?.title || app.currentInterviewStageName || "—";
                          const cId   = app.candidate?.id || app.candidateId;
                          const ashbyUrl = cId ? `https://app.ashbyhq.com/candidates/${cId}` : null;
                          const isPostTech = isAtOrPastTechnical(stage);

                          return (
                            <div key={app.id || i} className="cand-row"
                              style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 72px", padding: "13px 20px", borderBottom: i < ashbyResults.candidates.length - 1 ? "1px solid #f3f3f0" : "none", alignItems: "center", background: "#fff", transition: "background .1s" }}>
                              <div>
                                <p style={{ fontSize: 14, fontWeight: 600, color: NAVY, margin: "0 0 2px" }}>{name}</p>
                              </div>
                              <p style={{ fontSize: 13, color: "#6b7280", margin: 0, paddingRight: 8 }}>{job}</p>
                              <div>
                                <span style={{ fontSize: 11, padding: "3px 9px", borderRadius: 100, fontWeight: 600, display: "inline-block",
                                  background: isPostTech ? "#edfaf5" : "#f0fdf8",
                                  color: isPostTech ? "#0a5c44" : "#065f46",
                                  border: `1px solid ${isPostTech ? "#3ECFA3" : "#a7f3d0"}` }}>
                                  {stage}
                                </span>
                              </div>
                              {ashbyUrl ? (
                                <a href={ashbyUrl} target="_blank" rel="noreferrer"
                                  style={{ fontSize: 12, fontWeight: 700, color: MINT, textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}>
                                  View ↗
                                </a>
                              ) : <span/>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Key saved but no results yet and not loading */}
                {ashbyKeySaved && !ashbyLoading && !ashbyResults && !ashbyError && (
                  <div style={{ background: "#fff", border: "1px solid #e8e6e1", borderRadius: 16, padding: "44px 28px", textAlign: "center" }}>
                    <button onClick={() => doAshbySearch()}
                      style={{ fontSize: 14, fontWeight: 700, color: NAVY, background: MINT, border: "none", borderRadius: 12, padding: "14px 28px", cursor: "pointer", fontFamily: "inherit" }}>
                      Search Ashby now
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
