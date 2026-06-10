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

const MINT = "#3ECFA3";
const NAVY = "#111827";
const OFF  = "#f7f6f3";
const ASHBY_ORANGE = "#FF5B35";

const POST_TECHNICAL_STAGES = [
  "final interview","final stage","second interview","third interview",
  "culture fit","values interview","executive interview","ceo interview",
  "offer","reference check","references","background check","contract",
  "hired","panel interview","panel","presentation","case study",
  "task review","take home review","senior interview","director interview","vp interview"
];
const TECHNICAL_STAGE_NAMES = [
  "technical interview","technical screen","technical assessment","technical",
  "tech interview","coding interview","skills test","technical task","take home","take home task"
];

function isAtOrPastTechnical(s) {
  if (!s) return false;
  const sl = s.toLowerCase();
  return TECHNICAL_STAGE_NAMES.some(t => sl.includes(t)) || POST_TECHNICAL_STAGES.some(t => sl.includes(t));
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
  if (!active.length) return [{ id: "all", label: "Output", content: text }];
  const boundaries = [];
  for (const o of active) {
    const regex = new RegExp(`(^|\\n)[\\s#*_]*${o.keyword.replace(/&/g,"(&|and)")}[\\s#*_]*`,"i");
    const match = regex.exec(text);
    if (match) boundaries.push({ id: o.id, index: match.index + (match[1] ? 1 : 0) });
  }
  boundaries.sort((a,b) => a.index - b.index);
  if (!boundaries.length) return [{ id: active[0].id, label: active[0].label, icon: active[0].icon, content: text }];
  const sections = [];
  for (let i = 0; i < boundaries.length; i++) {
    const o = OUTPUTS.find(x => x.id === boundaries[i].id);
    sections.push({ id: o.id, label: o.label, icon: o.icon, content: text.slice(boundaries[i].index, boundaries[i+1]?.index ?? text.length).trim() });
  }
  if (boundaries[0].index > 0) { const pre = text.slice(0, boundaries[0].index).trim(); if (pre) sections[0].content = pre + "\n\n" + sections[0].content; }
  return sections;
}

// ── Ashby calls go through /api/ashby (server-side, no CORS) ─────────────────
async function ashbyFetch(apiKey, endpoint, body = {}) {
  const res = await fetch("/api/ashby", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, body, apiKey }),
  });
  const data = await res.json();
  if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function ashbyListAll(apiKey, endpoint, extraBody = {}, maxPages = 5) {
  let results = [], cursor = null, page = 0;
  do {
    const data = await ashbyFetch(apiKey, endpoint, { limit: 100, ...extraBody, ...(cursor ? { cursor } : {}) });
    results = results.concat(data.results || []);
    cursor = data.nextCursor || null; page++;
  } while (cursor && page < maxPages);
  return results;
}

async function extractRoleTitle(notes) {
  const lines = notes.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(?:role|title|position|job title|hiring for)[:\s\-]+(.{3,60})$/i);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    if (line.length >= 5 && line.length <= 60 && /^[A-Z]/.test(line) && line.split(" ").length <= 6 && !line.includes(",") && !line.includes(".")) return line;
  }
  const res = await fetch("/api/anthropic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: `What is the job title in these hiring notes? Reply with ONLY the job title, nothing else.\n\n${notes.slice(0,400)}`, maxTokens: 30 }) });
  const data = await res.json();
  return data.text?.trim().replace(/^["']|["']$/g,"") || "this role";
}

async function getSimilarTitles(roleTitle) {
  const res = await fetch("/api/anthropic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: `List 6 alternative job titles for "${roleTitle}". Return ONLY a JSON array of short title strings, nothing else.`, maxTokens: 200 }) });
  const data = await res.json();
  try {
    const t = data.text || "[]";
    const s = t.indexOf("["), e = t.lastIndexOf("]");
    if (s === -1 || e === -1) return [roleTitle];
    const arr = JSON.parse(t.slice(s, e+1));
    return arr.filter(x => typeof x === "string" && x.length < 60 && !x.includes("."));
  } catch { return [roleTitle]; }
}

function titleMatches(jobTitle, targets) {
  const jt = jobTitle.toLowerCase().trim();
  return targets.some(t => {
    const target = t.toLowerCase().trim();
    if (!target || target.length < 3) return false;
    const words = target.split(/\s+/).filter(w => w.length > 3);
    return jt === target || jt.includes(target) || target.includes(jt) ||
      (words.length > 0 && words.filter(w => jt.includes(w)).length >= Math.ceil(words.length * 0.6));
  });
}

async function runFullAshbySearch(apiKey, notes, onProgress) {
  onProgress("Extracting job title from notes…");
  const roleTitle = await extractRoleTitle(notes);
  onProgress(`Searching for "${roleTitle}" and similar titles…`);
  const similarTitles = await getSimilarTitles(roleTitle);
  const allTitles = [roleTitle, ...similarTitles];
  onProgress(`Fetching all Ashby jobs…`);
  const allJobs = await ashbyListAll(apiKey, "job.list", {}, 10);
  const matchedJobs = allJobs.filter(job => titleMatches(job.title || "", allTitles));
  if (!matchedJobs.length) return { candidates: [], roleTitle, allTitles, matchedJobs: [], totalApps: 0 };
  onProgress(`Found ${matchedJobs.length} matching job${matchedJobs.length !== 1 ? "s" : ""} — fetching applications…`);
  const silverMedalists = []; let totalApps = 0;
  for (const job of matchedJobs.slice(0, 20)) {
    try {
      for (const status of ["Archived", "Active"]) {
        const apps = await ashbyListAll(apiKey, "application.list", { jobId: job.id, status }, 5);
        totalApps += apps.length;
        for (const app of apps) {
          if (app.status === "Hired" || app.currentInterviewStageName?.toLowerCase() === "hired") continue;
          const currentStage = app.currentInterviewStageName || app.interviewStageName || "";
          const stageHistory = [
            ...(app.interviewStages || []).map(s => s.name || s.title || ""),
            ...(app.interviews || []).map(s => s.interviewStageName || s.stageName || ""),
            ...(app.applicationHistory || []).map(s => s.stageName || s.name || ""),
          ];
          const allStages = [currentStage, ...stageHistory].filter(Boolean);
          if (allStages.some(s => isAtOrPastTechnical(s))) {
            const dup = silverMedalists.some(sm => (sm.candidateId || sm.candidate?.id) === (app.candidateId || app.candidate?.id) && sm._jobTitle === job.title);
            if (!dup) silverMedalists.push({ ...app, _jobTitle: job.title, _jobStatus: job.status || "Unknown", _stageFound: allStages.find(s => isAtOrPastTechnical(s)) || currentStage });
          }
        }
      }
    } catch(e) { console.warn(`Skipping ${job.id}:`, e.message); }
  }
  silverMedalists.sort((a,b) => new Date(b.updatedAt||0) - new Date(a.updatedAt||0));
  onProgress(null);
  return { candidates: silverMedalists, roleTitle, allTitles, matchedJobs, totalApps };
}

export default function RecruiterAgent() {
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState(Object.fromEntries(OUTPUTS.map(o => [o.id, true])));
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState(null);
  const [activeTab, setActiveTab] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [ashbyKey, setAshbyKey] = useState("");
  const [ashbyKeyInput, setAshbyKeyInput] = useState("");
  const [ashbyKeySaved, setAshbyKeySaved] = useState(false);
  const [ashbyLoading, setAshbyLoading] = useState(false);
  const [ashbyProgress, setAshbyProgress] = useState("");
  const [ashbyResults, setAshbyResults] = useState(null);
  const [ashbyError, setAshbyError] = useState(null);
  const contentRef = useRef(null);

  // Load Ashby key from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("ashby_api_key");
    if (saved) { setAshbyKey(saved); setAshbyKeySaved(true); }
  }, []);

  const activeOutputs = OUTPUTS.filter(o => selected[o.id]);
  const allSelected = activeOutputs.length === OUTPUTS.length;
  const silverSelected = selected["silver"];

  const toggleOutput = id => setSelected(p => ({ ...p, [id]: !p[id] }));
  const toggleAll = () => setSelected(Object.fromEntries(OUTPUTS.map(o => [o.id, !allSelected])));

  const buildPrompt = () => {
    const aiOutputs = activeOutputs.filter(o => !o.isAshby);
    const sel = id => aiOutputs.some(o => o.id === id);
    let prompt = `Street Group AI Recruiter Agent. Produce only the requested outputs, clearly labelled with exact heading names.\n\nOUTPUTS NEEDED: ${aiOutputs.map(o=>o.label).join(", ")}\n\nKICKOFF NOTES:\n${notes}\n\n---\n`;
    if (sel("jd")) prompt += `\nJOB DESCRIPTION: Job title + 📍 location + 💰 salary | Company intro (use boilerplate below) | Role hook (2–3 sentences) | A bit about you (2nd person bullets) | What you'll be working on (action bullets) | D&I nudge (verbatim): "We recognise that women and people from underrepresented groups often only apply for jobs when they meet every single one of the requirements listed. If you fall into that category and are about to rule yourself out based on the above criteria; please consider applying anyway. We'd love to see your application!" | Who are Street Group? (boilerplate) | Why join us? (benefits list) | Salary caveat | Interview process + (verbatim): "We want to make our interviews as inclusive as possible, so if you need any adjustments made, or if there's anything you think we should be aware of during the interview process, please do let us know!" | AI note (verbatim): "As a fast-moving and rapidly evolving tech company, we embrace the advantages of AI and encourage its use throughout our application process. However, our goal is to get to know and hire the authentic you - your skills, experience, and values. We don't want to hire an AI-generated version of you. We consider AI to be a valuable tool, not something that should overshadow you as an individual."\n`;
    if (sel("sourcing")) prompt += `\nSOURCING MESSAGE: <100 words. Warm, direct, role-specific. [CANDIDATE NAME] placeholder. Don't open with "I hope this message finds you well". Soft CTA at end.\n`;
    if (sel("prep")) prompt += `\nINTERVIEW PREP: Role summary (3 sentences) | What great looks like (3–5 bullets) | 8 tailored questions with what to listen for | Red flags | Scoring guide (1–5).\n`;
    if (sel("post")) prompt += `\nLINKEDIN POST: Two options — Option 1: <80 words punchy. Option 2: 100–150 words storytelling. Both: short sentences, warm, 1–3 emojis max, [RECRUITER NAME] placeholder, 2–3 hashtags. Never open with "Excited to share" or "We're hiring!". No exclamation marks on every line.\n`;
    if (sel("boolean")) prompt += `\nBOOLEAN & X-RAY: LinkedIn Boolean string (1 line) | Google X-Ray string (1 line) | 4 alternative title variants with 1-line notes each | Note: confirm min 3 years experience at screening.\n`;
    if (sel("targets")) prompt += `\nTARGET COMPANIES: Using the role, seniority and skills from the kickoff notes, list 30 companies where this type of person is likely working now. Industry doesn't matter — focus on fit for THIS role. Include SaaS, fintech, healthtech, ecommerce, agencies, scale-ups with strong cultures. Geography: Manchester/NW first (MediaCityUK, Spinningfields, Salford, Stockport), then Leeds/Sheffield/Liverpool, then UK remote-first. For each: company + location | why strong source for this role (2 sentences, reference specific skills from notes) | team to target | culture fit note (1 sentence). Numbered 1–30.\n`;
    if (sel("questions")) prompt += `\nINTERVIEW QUESTIONS: 10 questions specific to this role and kickoff notes — no generic questions. Mix: behavioural, situational, technical, motivational. Progressive difficulty. For each: bold question + "What to listen for:" with 2–3 strong-answer indicators.\n`;
    if (sel("jd")) prompt += `\n---\nSTREET GROUP BOILERPLATE: "We're an award-winning PropTech business based in Manchester, founded in 2015 by brother and sister duo, Tom & Heather Staff. Most of us have personal experience of how painful moving can be, and Tom and Heather saw an opportunity to change this: utilising technology, as well as our incredibly talented team, to improve the industry for everyone. Our products, Street.co.uk and Spectre form a powerful duo, working harmoniously together to transform an agent's job. From securing more leads and winning new instructions to streamlining business operations and growing market share, our products are supercharging 1,000s of agencies across the UK. Back in 2015, our co-Founder, Tom Staff, spent his evenings building Spectre v1.0. He'd seen first-hand an opportunity to automate the very manual process of winning new business for estate agents. Spectre is now our multi award-winning, instruction generation tool, generating an average return on investment for them of over 3000%."\n\nBENEFITS: 🏠 Hybrid-working (4 days WFH) | 🏖️ £1000 holiday after year 1 | 💪 Culture supporting growth | 📚 £500 L&D budget | 🎂 Birthday off | 🙋 2 paid volunteering days | 👶 Enhanced parental pay | 🧠 Mental health support (Health Assured) | 🕒 Flexible hours | 🚂 Season ticket loans | 🌷 Paid menopause leave | 🌞 Holiday buying scheme | 🚀 Ambitious growing business | 👩🏿‍💻 Cutting-edge tech | 🐶 Office dogs | 🍻 Stocked fridge + Friday beers | 🎊 Offsites & events | 🚴 Cycle to work | 🚗 EV salary sacrifice | 🌍 Climate-positive\n`;
    prompt += `\n---\nTOV: warm, direct, no corporate fluff. Second person in candidate-facing sections.\nEach section heading must exactly match its output name.`;
    return prompt;
  };

  const estimateMaxTokens = () => {
    const aiOutputs = activeOutputs.filter(o => !o.isAshby);
    const tokenMap = { jd:1200, sourcing:200, prep:800, post:400, boolean:300, targets:1800, questions:900 };
    return Math.min(Math.max(aiOutputs.reduce((s,o) => s+(tokenMap[o.id]||400), 200), 500), 6000);
  };

  const generate = async () => {
    if (!notes.trim() || !activeOutputs.length) return;
    setLoading(true); setSections(null); setAshbyResults(null); setAshbyError(null); setError(null);
    const aiOutputs = activeOutputs.filter(o => !o.isAshby);
    let parsedSections = [];
    if (aiOutputs.length) {
      try {
        const res = await fetch("/api/anthropic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: buildPrompt(), maxTokens: estimateMaxTokens() }) });
        const data = await res.json();
        parsedSections = parseSections(data.text || "", aiOutputs.map(o => o.id));
      } catch { setError("Generation failed. Please try again."); setLoading(false); return; }
    }
    if (silverSelected) parsedSections.push({ id: "silver", label: "Silver Medalists", icon: null, isAshby: true });
    setSections(parsedSections);
    setActiveTab(parsedSections[0]?.id ?? null);
    setLoading(false);
    if (silverSelected && ashbyKeySaved && ashbyKey) doAshbySearch(ashbyKey);
  };

  const doAshbySearch = async (key) => {
    setAshbyLoading(true); setAshbyResults(null); setAshbyError(null);
    try {
      const results = await runFullAshbySearch(key, notes, msg => setAshbyProgress(msg || ""));
      setAshbyResults(results);
    } catch(e) {
      let msg = e.message || "Unknown error";
      if (msg.includes("401") || msg.includes("403")) msg = "Invalid API key or missing permissions. Check candidatesRead + jobsRead in Ashby (Admin → Integrations → API Keys).";
      setAshbyError(msg);
    }
    setAshbyProgress(""); setAshbyLoading(false);
  };

  const saveAshbyKey = () => {
    if (!ashbyKeyInput.trim()) return;
    const key = ashbyKeyInput.trim();
    setAshbyKey(key); setAshbyKeySaved(true);
    localStorage.setItem("ashby_api_key", key);
  };

  const removeAshbyKey = () => {
    setAshbyKeySaved(false); setAshbyKey(""); setAshbyKeyInput("");
    localStorage.removeItem("ashby_api_key");
  };

  const currentSection = sections?.find(s => s.id === activeTab);
  const tabIdx = sections ? sections.findIndex(s => s.id === activeTab) : -1;

  const handleCopy = () => { navigator.clipboard.writeText(currentSection?.content ?? ""); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const handleCopyAll = () => { navigator.clipboard.writeText(sections?.filter(s => !s.isAshby).map(s => s.content).join("\n\n---\n\n") ?? ""); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [activeTab]);
  useEffect(() => { if (activeTab === "silver" && ashbyKeySaved && ashbyKey && !ashbyResults && !ashbyLoading && !ashbyError && notes) doAshbySearch(ashbyKey); }, [activeTab]);

  return (
    <div style={{ fontFamily:"'DM Sans','Inter',system-ui,sans-serif", minHeight:"100vh", background:OFF, color:NAVY }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        @keyframes spin { to { transform:rotate(360deg); } }
        @keyframes fadeUp { from { opacity:0;transform:translateY(10px); } to { opacity:1;transform:translateY(0); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        .sg-toggle { transition:all .15s; }
        .sg-toggle:hover { border-color:#3ECFA3!important; }
        .sg-toggle.on { background:#edfaf5!important;border-color:#3ECFA3!important;color:#0a5c44!important; }
        .sg-toggle.on .dot { background:#3ECFA3!important; }
        .sg-tab { transition:all .15s;cursor:pointer; }
        .sg-tab:hover { border-color:#3ECFA3!important;color:#0a5c44!important;background:#edfaf5!important; }
        .sg-tab.active { background:#edfaf5!important;border-color:#3ECFA3!important;color:#0a5c44!important; }
        .sg-tab.active .tab-dot { background:#3ECFA3!important; }
        .sg-generate:hover:not(:disabled) { transform:translateY(-1px);box-shadow:0 8px 24px rgba(62,207,163,.3)!important; }
        .sg-sec:hover { border-color:#3ECFA3!important;color:#0a5c44!important;background:#f0fdf8!important; }
        textarea:focus,input:focus { outline:none;border-color:#3ECFA3!important;box-shadow:0 0 0 3px rgba(62,207,163,.12)!important; }
        .fade { animation:fadeUp .35s ease; }
        .cand-row:hover { background:#f7f6f3!important; }
        .title-pill { font-size:11px;background:#edfaf5;border:1px solid #3ECFA3;color:#0a5c44;padding:2px 8px;border-radius:100px;font-weight:600; }
      `}</style>

      <nav style={{ background:NAVY, padding:"0 24px", height:60, display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none"><rect width="32" height="32" rx="8" fill={MINT}/><path d="M8 11C8 11 10 9 14 9C18 9 20 12 16 14C12 16 10 17 10 20C10 22 12 23 16 23C19 23 21 22 22 21" stroke={NAVY} strokeWidth="2.5" strokeLinecap="round"/></svg>
          <span style={{ fontWeight:700, fontSize:16, color:"#fff", letterSpacing:"-0.02em" }}>Street Group</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {ashbyKeySaved && (
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"rgba(62,207,163,.15)", border:"1px solid rgba(62,207,163,.4)", borderRadius:100, padding:"4px 10px" }}>
              <AshbyLogo size={13}/>
              <span style={{ color:MINT, fontSize:11, fontWeight:600 }}>Ashby connected</span>
              <button onClick={removeAshbyKey} style={{ background:"none", border:"none", color:"rgba(62,207,163,.6)", fontSize:11, cursor:"pointer", padding:"0 0 0 4px", fontFamily:"inherit" }} title="Remove key">✕</button>
            </div>
          )}
          <div style={{ background:"rgba(62,207,163,.15)", border:"1px solid rgba(62,207,163,.4)", color:MINT, fontSize:11, fontWeight:600, padding:"5px 14px", borderRadius:100, letterSpacing:"0.06em", textTransform:"uppercase" }}>Recruiter Agent</div>
        </div>
      </nav>

      <div style={{ maxWidth:700, margin:"0 auto", padding:"0 20px 60px" }}>
        {!sections && !loading && (
          <div className="fade">
            <div style={{ padding:"44px 0 32px", position:"relative" }}>
              <svg style={{ position:"absolute", top:16, right:-8, opacity:.1 }} width="120" height="90" viewBox="0 0 120 90" fill="none"><path d="M10 75 C 20 15, 60 15, 60 45 C 60 75, 100 75, 110 15" stroke={MINT} strokeWidth="4" strokeLinecap="round" fill="none"/></svg>
              <p style={{ fontSize:11, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:MINT, margin:"0 0 10px" }}>Hiring Kickoff</p>
              <h1 style={{ fontSize:34, fontWeight:700, margin:"0 0 12px", color:NAVY, lineHeight:1.15, letterSpacing:"-0.03em" }}>Generate everything.<br/><span style={{ color:MINT }}>In one go.</span></h1>
              <p style={{ fontSize:15, color:"#6b7280", margin:0, lineHeight:1.6 }}>Paste your kickoff notes — job description, sourcing, interview prep and more, ready instantly.</p>
            </div>
            <div style={{ background:"#fff", borderRadius:20, padding:"28px", border:"1px solid #e8e6e1" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                <span style={{ fontSize:11, fontWeight:700, letterSpacing:"0.1em", color:"#9ca3af", textTransform:"uppercase" }}>Kickoff Notes</span>
                <span style={{ fontSize:12, color:"#9ca3af" }}>{notes.length > 0 ? `${notes.length} chars` : "Paste or type below"}</span>
              </div>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Role title, team, salary range, key responsibilities, must-haves, interview process..." style={{ width:"100%", minHeight:160, background:OFF, border:"1.5px solid #e8e6e1", borderRadius:12, padding:"14px 16px", color:NAVY, fontSize:14, lineHeight:1.65, resize:"vertical", fontFamily:"inherit", boxSizing:"border-box", marginBottom:24 }}/>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                <span style={{ fontSize:11, fontWeight:700, letterSpacing:"0.1em", color:"#9ca3af", textTransform:"uppercase" }}>Outputs</span>
                <button onClick={toggleAll} style={{ background:"none", border:"none", fontSize:12, color:MINT, fontWeight:600, cursor:"pointer", padding:0, fontFamily:"inherit" }}>{allSelected ? "Deselect all" : "Select all"}</button>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:20 }}>
                {OUTPUTS.map(o => {
                  const isOn = selected[o.id];
                  return (
                    <button key={o.id} onClick={() => toggleOutput(o.id)} className={`sg-toggle${isOn ? " on" : ""}`}
                      style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 14px", borderRadius:10, border:`1.5px solid ${isOn ? MINT : "#e8e6e1"}`, background:isOn ? "#edfaf5" : "#fafaf9", color:isOn ? "#0a5c44" : "#6b7280", fontSize:13, fontWeight:500, cursor:"pointer", fontFamily:"inherit", textAlign:"left" }}>
                      <span className="dot" style={{ width:8, height:8, borderRadius:"50%", background:isOn ? MINT : "#d1d5db", flexShrink:0, transition:"background .15s" }}/>
                      {o.isAshby ? <AshbyLogo size={15}/> : <span style={{ fontSize:15 }}>{o.icon}</span>}
                      {o.label}
                    </button>
                  );
                })}
              </div>
              <button onClick={generate} disabled={!notes.trim() || !activeOutputs.length} className="sg-generate"
                style={{ width:"100%", padding:"17px", background:notes.trim() && activeOutputs.length ? MINT : "#e5e7eb", color:notes.trim() && activeOutputs.length ? NAVY : "#9ca3af", border:"none", borderRadius:12, fontSize:15, fontWeight:700, cursor:notes.trim() && activeOutputs.length ? "pointer" : "not-allowed", transition:"all .2s", fontFamily:"inherit" }}>
                Generate everything →
              </button>
            </div>
          </div>
        )}

        {loading && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"60vh", gap:20 }}>
            <div style={{ position:"relative", width:60, height:60 }}>
              <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:"3px solid rgba(62,207,163,.15)", borderTopColor:MINT, animation:"spin .9s linear infinite" }}/>
              <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", width:10, height:10, borderRadius:"50%", background:MINT, animation:"pulse 1.5s ease-in-out infinite" }}/>
            </div>
            <p style={{ color:NAVY, fontWeight:600, fontSize:16, margin:0 }}>Working on it…</p>
          </div>
        )}

        {error && !loading && <div style={{ background:"#fff5f2", border:"1px solid #fecaca", borderRadius:12, padding:16, color:"#dc2626", fontSize:14, marginTop:20 }}>{error}</div>}

        {sections && !loading && (
          <div className="fade">
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"36px 0 20px" }}>
              <div>
                <p style={{ fontSize:11, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color:MINT, margin:"0 0 4px" }}>Done</p>
                <h2 style={{ fontSize:24, fontWeight:700, margin:0, color:NAVY, letterSpacing:"-0.02em" }}>Your outputs</h2>
              </div>
              <button onClick={() => { setSections(null); setNotes(""); setAshbyResults(null); setAshbyError(null); }} className="sg-sec"
                style={{ background:"#fff", border:"1.5px solid #e8e6e1", color:"#6b7280", fontSize:13, fontWeight:600, padding:"9px 18px", borderRadius:100, cursor:"pointer", fontFamily:"inherit" }}>← New role</button>
            </div>

            <div style={{ marginBottom:16 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                <span style={{ fontSize:11, fontWeight:700, letterSpacing:"0.1em", color:"#9ca3af", textTransform:"uppercase" }}>Outputs</span>
                <span style={{ fontSize:12, color:"#9ca3af" }}>{sections.length} generated</span>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {sections.map(s => {
                  const isAshby = s.isAshby, isActive = activeTab === s.id;
                  return (
                    <button key={s.id} onClick={() => setActiveTab(s.id)} className={`sg-tab${isActive ? " active" : ""}`}
                      style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 14px", borderRadius:10, border:`1.5px solid ${isActive ? MINT : "#e8e6e1"}`, background:isActive ? "#edfaf5" : "#fff", color:isActive ? "#0a5c44" : "#6b7280", fontSize:13, fontWeight:500, fontFamily:"inherit", textAlign:"left" }}>
                      <span className="tab-dot" style={{ width:8, height:8, borderRadius:"50%", background:isActive ? MINT : "#d1d5db", flexShrink:0 }}/>
                      {isAshby ? <AshbyLogo size={15}/> : <span style={{ fontSize:15 }}>{s.icon}</span>}
                      {s.label}
                      {isAshby && ashbyLoading && <span style={{ marginLeft:"auto", width:14, height:14, borderRadius:"50%", border:"2px solid rgba(62,207,163,.2)", borderTopColor:MINT, animation:"spin .8s linear infinite", display:"inline-block" }}/>}
                      {isAshby && ashbyResults && !ashbyLoading && <span style={{ marginLeft:"auto", fontSize:11, background:MINT, color:NAVY, padding:"2px 8px", borderRadius:100, fontWeight:700 }}>{ashbyResults.candidates.length}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {currentSection && !currentSection.isAshby && (
              <div key={activeTab} className="fade">
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10, padding:"10px 16px", background:"#edfaf5", borderRadius:10, border:`1px solid ${MINT}` }}>
                  <span style={{ fontSize:17 }}>{currentSection.icon}</span>
                  <span style={{ fontWeight:700, fontSize:14, color:"#0a5c44" }}>{currentSection.label}</span>
                  <div style={{ flex:1 }}/>
                  <button onClick={handleCopy} style={{ background:copied ? MINT : "#fff", border:`1px solid ${MINT}`, color:copied ? NAVY : "#0a5c44", fontSize:12, fontWeight:600, padding:"5px 14px", borderRadius:100, cursor:"pointer", fontFamily:"inherit" }}>{copied ? "✓ Copied" : "Copy this"}</button>
                </div>
                <div ref={contentRef} style={{ background:"#fff", border:"1px solid #e8e6e1", borderRadius:16, padding:"24px 26px", fontSize:14, lineHeight:1.85, color:NAVY, whiteSpace:"pre-wrap", wordBreak:"break-word", maxHeight:520, overflowY:"auto" }}>{currentSection.content}</div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:12, gap:10 }}>
                  <button disabled={tabIdx===0} onClick={() => tabIdx > 0 && setActiveTab(sections[tabIdx-1].id)} className="sg-sec" style={{ padding:"12px 20px", background:"#fff", border:"1.5px solid #e8e6e1", color:"#6b7280", borderRadius:12, fontSize:13, fontWeight:600, cursor:tabIdx===0?"not-allowed":"pointer", opacity:tabIdx===0?.4:1, fontFamily:"inherit" }}>← Previous</button>
                  <button onClick={handleCopyAll} style={{ flex:1, padding:"12px", background:NAVY, border:"none", color:"#fff", borderRadius:12, fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>Copy all outputs</button>
                  <button disabled={tabIdx===sections.length-1} onClick={() => tabIdx < sections.length-1 && setActiveTab(sections[tabIdx+1].id)} className="sg-sec" style={{ padding:"12px 20px", background:"#fff", border:"1.5px solid #e8e6e1", color:"#6b7280", borderRadius:12, fontSize:13, fontWeight:600, cursor:tabIdx===sections.length-1?"not-allowed":"pointer", opacity:tabIdx===sections.length-1?.4:1, fontFamily:"inherit" }}>Next →</button>
                </div>
              </div>
            )}

            {currentSection?.isAshby && (
              <div key="silver" className="fade">
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, padding:"10px 16px", background:"#edfaf5", borderRadius:10, border:`1px solid ${MINT}` }}>
                  <AshbyLogo size={16}/>
                  <div><span style={{ fontWeight:700, fontSize:14, color:"#0a5c44" }}>Silver Medalists</span><span style={{ fontSize:12, color:"#6b7280", marginLeft:8 }}>Candidates who reached Technical Interview or beyond</span></div>
                  <div style={{ flex:1 }}/>
                  {ashbyKeySaved && ashbyResults && !ashbyLoading && <button onClick={() => doAshbySearch(ashbyKey)} style={{ fontSize:12, fontWeight:600, color:MINT, background:"none", border:`1px solid ${MINT}`, borderRadius:100, padding:"4px 12px", cursor:"pointer", fontFamily:"inherit" }}>Refresh</button>}
                </div>

                {!ashbyKeySaved && (
                  <div style={{ background:"#fff", border:"1px solid #e8e6e1", borderRadius:16, padding:"44px 28px", textAlign:"center" }}>
                    <AshbyLogo size={40}/>
                    <p style={{ fontWeight:700, fontSize:16, margin:"14px 0 6px", color:NAVY }}>Connect Ashby</p>
                    <p style={{ fontSize:14, color:"#6b7280", margin:"0 0 24px", lineHeight:1.6 }}>Enter your Ashby API key to search for silver medalists.</p>
                    <div style={{ display:"flex", gap:8, maxWidth:380, margin:"0 auto" }}>
                      <input type="password" value={ashbyKeyInput} onChange={e => setAshbyKeyInput(e.target.value)} placeholder="ashby_api_key_••••••••" onKeyDown={e => { if (e.key==="Enter") { saveAshbyKey(); if (ashbyKeyInput.trim()) doAshbySearch(ashbyKeyInput.trim()); }}} style={{ flex:1, fontSize:13, padding:"10px 14px", border:"1.5px solid #e8e6e1", borderRadius:10, fontFamily:"inherit", background:OFF, color:NAVY }}/>
                      <button onClick={() => { saveAshbyKey(); if (ashbyKeyInput.trim()) doAshbySearch(ashbyKeyInput.trim()); }} style={{ fontSize:13, fontWeight:700, color:NAVY, background:MINT, border:"none", borderRadius:10, padding:"10px 18px", cursor:"pointer", fontFamily:"inherit" }}>Search</button>
                    </div>
                  </div>
                )}

                {ashbyKeySaved && ashbyLoading && (
                  <div style={{ background:"#fff", border:"1px solid #e8e6e1", borderRadius:16, padding:"48px 28px", textAlign:"center" }}>
                    <div style={{ width:40, height:40, borderRadius:"50%", border:"3px solid rgba(62,207,163,.15)", borderTopColor:MINT, animation:"spin .9s linear infinite", margin:"0 auto 16px" }}/>
                    <p style={{ color:NAVY, fontWeight:600, fontSize:15, margin:"0 0 6px" }}>{ashbyProgress || "Searching Ashby…"}</p>
                    <p style={{ color:"#9ca3af", fontSize:13, margin:0 }}>Checking active, paused and archived jobs for similar titles</p>
                  </div>
                )}

                {ashbyKeySaved && ashbyError && !ashbyLoading && (
                  <div style={{ background:"#fff", border:"1px solid #fecaca", borderRadius:16, padding:"24px 28px" }}>
                    <p style={{ color:"#dc2626", fontWeight:700, fontSize:14, margin:"0 0 6px" }}>Search failed</p>
                    <p style={{ color:"#dc2626", fontSize:13, margin:"0 0 16px", lineHeight:1.5 }}>{ashbyError}</p>
                    <button onClick={() => doAshbySearch(ashbyKey)} style={{ fontSize:13, fontWeight:600, color:NAVY, background:MINT, border:"none", borderRadius:8, padding:"9px 18px", cursor:"pointer", fontFamily:"inherit" }}>Try again</button>
                  </div>
                )}

                {ashbyResults && !ashbyLoading && (
                  <div>
                    <div style={{ background:"#fff", border:"1px solid #e8e6e1", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
                      <p style={{ fontSize:11, fontWeight:700, color:"#9ca3af", textTransform:"uppercase", letterSpacing:"0.08em", margin:"0 0 8px" }}>Searched job titles</p>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                        {ashbyResults.allTitles.slice(0,10).map(t => <span key={t} className="title-pill">{t}</span>)}
                      </div>
                      {ashbyResults.matchedJobs.length > 0 && <p style={{ fontSize:12, color:"#6b7280", margin:"10px 0 0" }}>Matched <strong>{ashbyResults.matchedJobs.length}</strong> job{ashbyResults.matchedJobs.length !== 1?"s":""} across {ashbyResults.totalApps} total applications</p>}
                    </div>
                    {ashbyResults.candidates.length === 0 ? (
                      <div style={{ background:"#fff", border:"1px solid #e8e6e1", borderRadius:16, padding:"44px 28px", textAlign:"center" }}>
                        <p style={{ fontSize:22 }}>🔍</p>
                        <p style={{ fontSize:15, fontWeight:600, color:NAVY, margin:"8px 0 6px" }}>No silver medalists found</p>
                        <p style={{ fontSize:13, color:"#6b7280", margin:0, lineHeight:1.6 }}>{ashbyResults.matchedJobs.length === 0 ? "No jobs with similar titles found in Ashby." : "No archived candidates who reached Technical Interview or beyond found for these roles."}</p>
                      </div>
                    ) : (
                      <div style={{ background:"#fff", border:"1px solid #e8e6e1", borderRadius:16, overflow:"hidden" }}>
                        <div style={{ display:"grid", gridTemplateColumns:"1.2fr 1fr 1fr 72px", padding:"10px 20px", borderBottom:"1px solid #e8e6e1", background:OFF }}>
                          {["Candidate","Applied for","Stage reached",""].map(h => <span key={h} style={{ fontSize:11, fontWeight:700, color:"#9ca3af", textTransform:"uppercase", letterSpacing:"0.07em" }}>{h}</span>)}
                        </div>
                        {ashbyResults.candidates.map((app, i) => {
                          const name  = app.candidateName || app.candidate?.name || "Unknown";
                          const job   = app._jobTitle || app.job?.title || "—";
                          const stage = app._stageFound || app.currentInterviewStageName || "—";
                          const cId   = app.candidateId || app.candidate?.id;
                          const url   = cId ? `https://app.ashbyhq.com/candidates/${cId}` : null;
                          return (
                            <div key={app.id||i} className="cand-row" style={{ display:"grid", gridTemplateColumns:"1.2fr 1fr 1fr 72px", padding:"13px 20px", borderBottom:i<ashbyResults.candidates.length-1?"1px solid #f3f3f0":"none", alignItems:"center", background:"#fff", transition:"background .1s" }}>
                              <p style={{ fontSize:14, fontWeight:600, color:NAVY, margin:0 }}>{name}</p>
                              <p style={{ fontSize:13, color:"#6b7280", margin:0, paddingRight:8 }}>{job}</p>
                              <span style={{ fontSize:11, padding:"3px 9px", borderRadius:100, fontWeight:600, display:"inline-block", background:"#edfaf5", color:"#0a5c44", border:`1px solid ${MINT}` }}>{stage}</span>
                              {url ? <a href={url} target="_blank" rel="noreferrer" style={{ fontSize:12, fontWeight:700, color:MINT, textDecoration:"none" }}>View ↗</a> : <span/>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {ashbyKeySaved && !ashbyLoading && !ashbyResults && !ashbyError && (
                  <div style={{ background:"#fff", border:"1px solid #e8e6e1", borderRadius:16, padding:"44px 28px", textAlign:"center" }}>
                    <button onClick={() => doAshbySearch(ashbyKey)} style={{ fontSize:14, fontWeight:700, color:NAVY, background:MINT, border:"none", borderRadius:12, padding:"14px 28px", cursor:"pointer", fontFamily:"inherit" }}>Search Ashby now</button>
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
