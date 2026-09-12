import React, { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

// ============================================================================
// Backed by Supabase. Projects are the spine. Day view groups tasks under
// their project (projects alphabetical). Tasks with date=null are "Someday"
// and also surface at the bottom of Upcoming. Project notes are discrete
// dated entries, not one pad. Reminders removed.
// ============================================================================

const RECUR = [
  { id: "none", label: "Does not repeat" },
  { id: "daily", label: "Every day" },
  { id: "weekly", label: "Every week" },
  { id: "monthly", label: "Every month" },
];

const PROJECT_COLORS = ["#f0806c", "#3bb89a", "#6c9ee8", "#f2a65a", "#b884d8", "#e86b9e", "#4ec0c0", "#f5c451"];
// Not a real project: a reserved row (fixed id) that only holds the "No
// project" bucket's notes, so the app doesn't need a nullable-FK edge case
// in the tasks table. Filtered out of every normal project listing below.
const NO_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

const iso = (d) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const addDays = (dateStr, n) => { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const fmtLong = (s) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const fmtShort = (s) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const fmtNote = (s) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
const relativeLabel = (s) => {
  const t = today();
  if (s === t) return "Today";
  if (s === addDays(t, 1)) return "Tomorrow";
  if (s === addDays(t, -1)) return "Yesterday";
  return null;
};
const alphaProjects = (projs) => [...projs].sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }));

let ORDER_SEQ = 0;
let currentUserId = null;
// Mirrors of the last loadProjects() result, kept in sync so getProject()
// and addProject()'s color cycling can stay synchronous (same pattern the
// in-memory version used, just fed from the DB instead of a local array).
let PROJECTS_CACHE = [];
let NO_PROJECT_CACHE = { id: NO_PROJECT_ID, label: "No project", color: "#9aa6a0", notes: [] };

const BIN_DAYS = 7;
const binEntry = (kind, payload, meta = {}) => {
  const now = new Date();
  const expires = new Date(now); expires.setDate(expires.getDate() + BIN_DAYS);
  return { binId: crypto.randomUUID(), kind, deletedAt: iso(now), expiresAt: iso(expires), payload, meta };
};

// Row <-> app-shape mappers (DB uses snake_case; the app uses camelCase).
const toTaskRow = (t) => ({
  id: t.id, user_id: currentUserId, title: t.title, notes: t.notes || "",
  project: t.project || null, date: t.date || null,
  recur: t.recur || "none", recur_end: t.recurEnd || "none",
  recur_end_date: t.recurEndDate || null, recur_end_count: t.recurEndCount || null,
  skip_dates: t.skipDates || [], done_dates: t.doneDates || [], ord: t.order || 0,
});
const fromTaskRow = (r) => ({
  id: r.id, title: r.title, notes: r.notes || "", project: r.project,
  date: r.date, recur: r.recur, recurEnd: r.recur_end, recurEndDate: r.recur_end_date,
  recurEndCount: r.recur_end_count, skipDates: r.skip_dates || [], doneDates: r.done_dates || [],
  order: r.ord,
});
const toProjectRow = (p) => ({ id: p.id, user_id: currentUserId, label: p.label, color: p.color, notes: p.notes || [] });
const fromProjectRow = (r) => ({ id: r.id, label: r.label, color: r.color, notes: r.notes || [] });
const toBinRow = (e) => ({ bin_id: e.binId, user_id: currentUserId, kind: e.kind, payload: e.payload, meta: e.meta, deleted_at: e.deletedAt, expires_at: e.expiresAt });
const fromBinRow = (r) => ({ binId: r.bin_id, kind: r.kind, payload: r.payload, meta: r.meta, deletedAt: r.deleted_at, expiresAt: r.expires_at });
const toExpenseRow = (e) => ({ id: e.id, user_id: currentUserId, name: e.name, date: e.date, amount: e.amount, claimed: !!e.claimed });
const fromExpenseRow = (r) => ({ id: r.id, name: r.name, date: r.date, amount: Number(r.amount), claimed: !!r.claimed });
const check = (error) => { if (error) throw new Error(error.message); };

const api = {
  signIn: async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    check(error);
    currentUserId = data.user.id;
    return { email: data.user.email };
  },
  signUp: async (email, password) => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    check(error);
    if (!data.session) throw new Error("Account created — check your email to confirm it, then sign in.");
    currentUserId = data.user.id;
    return { email: data.user.email };
  },
  loadTasks: async () => {
    const { data, error } = await supabase.from("tasks").select("*").order("ord", { ascending: true });
    check(error);
    const tasks = (data || []).map(fromTaskRow);
    ORDER_SEQ = Math.max(ORDER_SEQ, 0, ...tasks.map((t) => t.order || 0));
    return tasks;
  },
  saveTask: async (task) => {
    const { data, error } = await supabase.from("tasks").upsert(toTaskRow(task)).select().single();
    check(error);
    return fromTaskRow(data);
  },
  saveTasks: async (tasks) => {
    const { error } = await supabase.from("tasks").upsert(tasks.map(toTaskRow));
    check(error);
  },
  // Soft-delete: task goes to the bin.
  deleteTask: async (id) => {
    const { data: row, error: selErr } = await supabase.from("tasks").select("*").eq("id", id).single();
    check(selErr);
    const t = fromTaskRow(row);
    check((await supabase.from("bin").insert(toBinRow(binEntry("task", t, { title: t.title })))).error);
    check((await supabase.from("tasks").delete().eq("id", id)).error);
  },
  // Skip a single occurrence of a recurring task (does not bin anything).
  skipOccurrence: async (id, dateStr) => {
    const { data: row, error: selErr } = await supabase.from("tasks").select("skip_dates").eq("id", id).single();
    check(selErr);
    const skips = new Set(row.skip_dates || []); skips.add(dateStr);
    check((await supabase.from("tasks").update({ skip_dates: [...skips] }).eq("id", id)).error);
  },
  // Move ONE occurrence of a recurring task: skip it in the series and create a standalone one-off on the target date.
  moveOccurrence: async (id, occurrenceDate, newDate) => {
    const { data: row, error: selErr } = await supabase.from("tasks").select("*").eq("id", id).single();
    check(selErr);
    const t = fromTaskRow(row);
    const skips = new Set(t.skipDates || []); skips.add(occurrenceDate);
    check((await supabase.from("tasks").update({ skip_dates: [...skips] }).eq("id", id)).error);
    const newTask = { id: crypto.randomUUID(), title: t.title, notes: t.notes, project: t.project, date: newDate, recur: "none", recurEnd: "none", recurEndDate: null, recurEndCount: null, skipDates: [], order: ++ORDER_SEQ, doneDates: [] };
    check((await supabase.from("tasks").insert(toTaskRow(newTask))).error);
  },
  loadProjects: async () => {
    const { data, error } = await supabase.from("projects").select("*");
    check(error);
    const rows = (data || []).map(fromProjectRow);
    NO_PROJECT_CACHE = rows.find((p) => p.id === NO_PROJECT_ID) || { id: NO_PROJECT_ID, label: "No project", color: "#9aa6a0", notes: [] };
    PROJECTS_CACHE = rows.filter((p) => p.id !== NO_PROJECT_ID);
    return PROJECTS_CACHE;
  },
  getProject: (id) => (id === NO_PROJECT_ID ? NO_PROJECT_CACHE : PROJECTS_CACHE.find((p) => p.id === id)),
  addProject: async (label) => {
    const color = PROJECT_COLORS[PROJECTS_CACHE.length % PROJECT_COLORS.length];
    const p = { id: crypto.randomUUID(), label, color, notes: [] };
    check((await supabase.from("projects").insert(toProjectRow(p))).error);
    return p;
  },
  saveProject: async (proj) => {
    const { data, error } = await supabase.from("projects").upsert(toProjectRow(proj)).select().single();
    check(error);
    const saved = fromProjectRow(data);
    if (proj.id === NO_PROJECT_ID) NO_PROJECT_CACHE = saved;
    return saved;
  },
  // Soft-delete a project: bin the project together with its tasks and notes.
  deleteProject: async (id) => {
    const { data: pRow, error: pErr } = await supabase.from("projects").select("*").eq("id", id).single();
    check(pErr);
    const p = fromProjectRow(pRow);
    const { data: tRows, error: tErr } = await supabase.from("tasks").select("*").eq("project", id);
    check(tErr);
    const projTasks = (tRows || []).map(fromTaskRow);
    check((await supabase.from("bin").insert(toBinRow(binEntry("project", { project: p, tasks: projTasks }, { label: p.label, taskCount: projTasks.length, noteCount: (p.notes || []).length })))).error);
    check((await supabase.from("tasks").delete().eq("project", id)).error);
    check((await supabase.from("projects").delete().eq("id", id)).error);
  },
  // Soft-delete a single note from a project.
  deleteNote: async (projectId, noteId) => {
    const { data: row, error: selErr } = await supabase.from("projects").select("*").eq("id", projectId).single();
    const proj = row ? fromProjectRow(row) : (projectId === NO_PROJECT_ID ? NO_PROJECT_CACHE : null);
    if (selErr && projectId !== NO_PROJECT_ID) check(selErr);
    if (!proj) return;
    const note = (proj.notes || []).find((n) => n.id === noteId);
    if (note) check((await supabase.from("bin").insert(toBinRow(binEntry("note", note, { projectId, projectLabel: proj.label })))).error);
    const updated = { ...proj, notes: (proj.notes || []).filter((n) => n.id !== noteId) };
    const { data: saved, error: upErr } = await supabase.from("projects").upsert(toProjectRow(updated)).select().single();
    check(upErr);
    if (projectId === NO_PROJECT_ID) NO_PROJECT_CACHE = fromProjectRow(saved);
  },
  loadBin: async () => {
    // Purge anything past expiry (in a real backend this'd be a scheduled job).
    await supabase.from("bin").delete().lt("expires_at", today());
    const { data, error } = await supabase.from("bin").select("*").order("deleted_at", { ascending: false });
    check(error);
    return (data || []).map(fromBinRow);
  },
  restoreFromBin: async (binId) => {
    const { data: row, error: selErr } = await supabase.from("bin").select("*").eq("bin_id", binId).single();
    check(selErr);
    const e = fromBinRow(row);
    if (e.kind === "task") {
      check((await supabase.from("tasks").insert(toTaskRow(e.payload))).error);
    } else if (e.kind === "project") {
      // payload is { project, tasks }
      check((await supabase.from("projects").insert(toProjectRow(e.payload.project))).error);
      const tasks = e.payload.tasks || [];
      if (tasks.length) check((await supabase.from("tasks").insert(tasks.map(toTaskRow))).error);
    } else if (e.kind === "note") {
      const pid = e.meta.projectId;
      const { data: pRow, error: pErr } = await supabase.from("projects").select("*").eq("id", pid).single();
      const proj = pRow ? fromProjectRow(pRow) : (pid === NO_PROJECT_ID ? NO_PROJECT_CACHE : null);
      if (pErr && pid !== NO_PROJECT_ID) check(pErr);
      if (proj) {
        const updated = { ...proj, notes: [...(proj.notes || []), e.payload] };
        const { data: saved, error: upErr } = await supabase.from("projects").upsert(toProjectRow(updated)).select().single();
        check(upErr);
        if (pid === NO_PROJECT_ID) NO_PROJECT_CACHE = fromProjectRow(saved);
      }
    }
    check((await supabase.from("bin").delete().eq("bin_id", binId)).error);
  },
  purgeFromBin: async (binId) => check((await supabase.from("bin").delete().eq("bin_id", binId)).error),
  emptyBin: async () => check((await supabase.from("bin").delete().not("bin_id", "is", null)).error),
  loadExpenses: async () => {
    const { data, error } = await supabase.from("expenses").select("*").order("date", { ascending: false });
    check(error);
    return (data || []).map(fromExpenseRow);
  },
  saveExpense: async (expense) => {
    const { data, error } = await supabase.from("expenses").upsert(toExpenseRow(expense)).select().single();
    check(error);
    return fromExpenseRow(data);
  },
  deleteExpense: async (id) => check((await supabase.from("expenses").delete().eq("id", id)).error),
};

const nextOrder = () => ++ORDER_SEQ;

function occursOn(task, dateStr) {
  if (!task.date) return false;
  if (task.recur === "none") return task.date === dateStr;
  if (dateStr < task.date) return false;
  if ((task.skipDates || []).includes(dateStr)) return false;
  // End by date: nothing on or after the end falls due (end date is exclusive-inclusive: tasks up to and including end).
  if (task.recurEnd === "date" && task.recurEndDate && dateStr > task.recurEndDate) return false;
  const start = new Date(task.date + "T00:00:00");
  const target = new Date(dateStr + "T00:00:00");
  const diffDays = Math.round((target - start) / 86400000);
  let isOccurrence = false;
  if (task.recur === "daily") isOccurrence = true;
  else if (task.recur === "weekly") isOccurrence = diffDays % 7 === 0;
  else if (task.recur === "monthly") isOccurrence = start.getDate() === target.getDate();
  if (!isOccurrence) return false;
  // End after N occurrences: count occurrences from start up to and including this date.
  if (task.recurEnd === "count" && task.recurEndCount) {
    const n = occurrenceIndex(task, dateStr); // 1-based
    if (n > task.recurEndCount) return false;
  }
  return true;
}

// 1-based index of an occurrence date within the series (ignores skips for numbering).
function occurrenceIndex(task, dateStr) {
  const start = new Date(task.date + "T00:00:00");
  const target = new Date(dateStr + "T00:00:00");
  const diffDays = Math.round((target - start) / 86400000);
  if (task.recur === "daily") return diffDays + 1;
  if (task.recur === "weekly") return Math.floor(diffDays / 7) + 1;
  if (task.recur === "monthly") {
    return (target.getFullYear() - start.getFullYear()) * 12 + (target.getMonth() - start.getMonth()) + 1;
  }
  return 1;
}

function upcomingOccurrences(task, fromDate, horizonDays = 400) {
  const out = [];
  if (!task.date) return out;
  if (task.recur === "none") { if (task.date >= fromDate) out.push(task.date); return out; }
  for (let i = 0; i < horizonDays; i++) { const d = addDays(fromDate, i); if (occursOn(task, d)) out.push(d); if (out.length >= 12) break; }
  return out;
}

const isDone = (task, dateStr) => (task.doneDates || []).includes(dateStr);
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

// Group a list of tasks under their projects, projects alphabetical, an
// "Unassigned" bucket last. Returns [{project|null, tasks:[]}].
function groupByProject(tasks, projects) {
  const map = new Map();
  tasks.forEach((t) => { const key = t.project || "__none__"; if (!map.has(key)) map.set(key, []); map.get(key).push(t); });
  const groups = [];
  alphaProjects(projects).forEach((p) => { if (map.has(p.id)) groups.push({ project: p, tasks: map.get(p.id).sort(byOrder) }); });
  if (map.has("__none__")) groups.push({ project: null, tasks: map.get("__none__").sort(byOrder) });
  return groups;
}

// Logo: a sun cresting a curved path. Evokes "day" + "path".
function Logo({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="16" cy="13" r="5" fill={ACCENT} />
      <path d="M3 24 C 9 24, 9 18, 16 18 C 23 18, 23 24, 29 24" stroke="#7ba8e0" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <line x1="16" y1="3" x2="16" y2="5.5" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
      <line x1="6.5" y1="6.5" x2="8.2" y2="8.2" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
      <line x1="25.5" y1="6.5" x2="23.8" y2="8.2" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Small line icons, sharing one stroke style so the nav looks cohesive.
function Icon({ name, size = 16 }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
  if (name === "upcoming") return (<svg {...common}><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="14" y2="17" /></svg>);
  if (name === "bin") return (<svg {...common}><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>);
  if (name === "search") return (<svg {...common}><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></svg>);
  if (name === "done") return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></svg>);
  return null;
}

// Interaction layer: hover/focus/motion states that inline styles can't express.
// One signature element: the "path" line threading the Upcoming timeline.
function GlobalStyles() {
  return (
    <style>{`
      button { transition: background .12s ease, border-color .12s ease, transform .08s ease, box-shadow .15s ease, color .12s ease; }
      button:active { transform: scale(.97); }
      button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
        outline: 2px solid rgba(123,168,224,.65); outline-offset: 2px; border-radius: 6px;
      }
      .dp-card { transition: box-shadow .15s ease, transform .15s ease, border-color .15s ease, opacity .2s ease; }
      .dp-card:hover { box-shadow: 0 4px 14px rgba(45,75,65,.10) !important; transform: translateY(-1px); border-color: rgba(0,0,0,.12) !important; }
      .dp-check:hover { border-color: #f0806c !important; }
      .dp-navhover:not(.dp-active):hover { background: #f2f5f9 !important; }
      .dp-fab { transition: transform .15s ease, box-shadow .2s ease; }
      .dp-fab:hover { transform: scale(1.06); box-shadow: 0 10px 28px rgba(240,128,108,.5) !important; }
      .dp-overlay { animation: dp-fade .18s ease; }
      .dp-sheet { animation: dp-rise .22s cubic-bezier(.2,.8,.3,1); }
      .dp-pop { animation: dp-pop .14s ease; transform-origin: top right; }
      @keyframes dp-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes dp-rise { from { opacity: 0; transform: translateY(14px) scale(.985) } to { opacity: 1; transform: none } }
      @keyframes dp-pop { from { opacity: 0; transform: scale(.96) } to { opacity: 1; transform: none } }
      .dp-timeline { position: relative; }
      .dp-timeline::before { content: ""; position: absolute; left: 106px; top: 22px; bottom: 10px; width: 2px; border-radius: 1px; background: #e3edf9; }
      .dp-tlgroup { position: relative; }
      .dp-tlgroup::before { content: ""; position: absolute; left: 101px; top: 19px; width: 12px; height: 12px; border-radius: 50%; background: #fff; border: 2.5px solid #7ba8e0; box-sizing: border-box; z-index: 1; }
      .dp-tlgroup.dp-overdue::before { border-color: #f0806c; }
      @media (max-width: 720px) { .dp-timeline::before, .dp-tlgroup::before { display: none; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
    `}</style>
  );
}

// ============================================================================
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("up");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr(""); setBusy(true);
    try { onAuthed(mode === "in" ? await api.signIn(email.trim(), password) : await api.signUp(email.trim(), password)); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div style={S.authWrap}>
      <GlobalStyles />
      <div style={S.authCard}>
        <div style={S.brand}><Logo size={30} /> Daypath</div>
        <input style={{ ...S.input, marginTop: 22 }} type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={S.input} type="password" placeholder="Password (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        {err && <div style={S.err}>{err}</div>}
        <button style={S.authBtn} onClick={submit} disabled={busy}>{busy ? "…" : mode === "in" ? "Sign in" : "Create account"}</button>
        <div style={S.switchRow}>{mode === "in" ? "New here?" : "Already have an account?"} <span style={S.link} onClick={() => { setMode(mode === "in" ? "up" : "in"); setErr(""); }}>{mode === "in" ? "Create one" : "Sign in"}</span></div>
        <div style={S.demoHint}>New account: 6+ character password. Depending on your project's auth settings, you may need to confirm your email before signing in.</div>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [view, setView] = useState({ type: "upcoming" });
  const [editing, setEditing] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dragTask, setDragTask] = useState(null);
  const [search, setSearch] = useState("");

  // Restore an existing session on load, and stay in sync with sign-out
  // (e.g. token expiry, or signing out in another tab).
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      currentUserId = session?.user?.id ?? null;
      setUser(session?.user ? { email: session.user.email } : null);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      currentUserId = session?.user?.id ?? null;
      setUser(session?.user ? { email: session.user.email } : null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (!user) return; api.loadTasks().then(setTasks); api.loadProjects().then(setProjects); api.loadExpenses().then(setExpenses); }, [user]);

  // Keyboard quick-add: press N (when not typing in a field) to open a new task.
  useEffect(() => {
    if (!user) return;
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") { e.preventDefault(); setEditing("new"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user]);

  const refresh = async () => { setTasks(await api.loadTasks()); setProjects(await api.loadProjects()); setExpenses(await api.loadExpenses()); };
  if (!authReady) return <div style={S.authWrap} />;
  if (!user) return <AuthScreen onAuthed={setUser} />;

  const moveTaskToDate = async (dragged, newDate) => {
    const t = tasks.find((x) => x.id === dragged.id);
    if (!t) return;
    if (t.recur && t.recur !== "none" && dragged.__occDate) await api.moveOccurrence(t.id, dragged.__occDate, newDate);
    else await api.saveTask({ ...t, date: newDate, order: nextOrder() });
    refresh();
  };

  return (
    <div style={S.shell}>
      <GlobalStyles />
      <Sidebar user={user} tasks={tasks} projects={projects} view={view} setView={setView}
        onSignOut={async () => { await supabase.auth.signOut(); setUser(null); setTasks([]); setProjects([]); setExpenses([]); }} collapsed={collapsed} setCollapsed={setCollapsed}
        dragTask={dragTask} onDropDate={moveTaskToDate} refresh={refresh} search={search} setSearch={setSearch} />
      <div style={S.content}>
        {view.type === "upcoming" && <UpcomingView tasks={tasks} projects={projects} expenses={expenses} refresh={refresh} openEditor={setEditing} goToDay={(d) => setView({ type: "day", date: d })} setDragTask={setDragTask} />}
        {view.type === "day" && <DayView date={view.date} setView={setView} tasks={tasks} projects={projects} refresh={refresh} openEditor={setEditing} setDragTask={setDragTask} />}
        {view.type === "project" && <ProjectView projectId={view.id} tasks={tasks} projects={projects} refresh={refresh} openEditor={setEditing} setDragTask={setDragTask} setView={setView} />}
        {view.type === "bin" && <BinView refresh={refresh} />}
        {view.type === "done" && <DoneView tasks={tasks} projects={projects} refresh={refresh} openEditor={setEditing} />}
        {view.type === "search" && <SearchView query={search} tasks={tasks} projects={projects} openEditor={setEditing} goToProject={(id) => setView({ type: "project", id })} />}
      </div>
      {editing && <TaskEditor task={editing === "new" ? null : editing} defaultDate={view.type === "day" ? view.date : null} defaultProject={view.type === "project" ? view.id : null} projects={projects} refresh={refresh} onClose={() => setEditing(null)} />}
      <button className="dp-fab" style={S.fab} onClick={() => setEditing("new")} aria-label="Add task" title="New task (or press N)">+</button>
    </div>
  );
}

// ============================================================================
function Sidebar({ user, tasks, projects, view, setView, onSignOut, collapsed, setCollapsed, dragTask, onDropDate, refresh, search, setSearch }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [dragOverDate, setDragOverDate] = useState(null);
  const [addingProject, setAddingProject] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const grid = useMemo(() => {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const startPad = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(iso(new Date(y, m, d)));
    return cells;
  }, [cursor]);
  const hasTask = (d) => tasks.some((t) => occursOn(t, d));
  const monthLabel = cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const shift = (n) => { const d = new Date(cursor); d.setMonth(d.getMonth() + n); setCursor(d); };
  const submitNewProject = async () => { const name = newProjName.trim(); if (!name) { setAddingProject(false); return; } await api.addProject(name); setNewProjName(""); setAddingProject(false); refresh(); };
  const sortedProjects = alphaProjects(projects);

  if (collapsed) {
    return (
      <aside style={S.sidebarCollapsed}>
        <button style={S.collapseBtn} onClick={() => setCollapsed(false)} title="Expand">›</button>
        <button style={S.railIcon} onClick={() => setView({ type: "upcoming" })} title="Upcoming"><Icon name="upcoming" /></button>
        <button style={S.railIcon} onClick={() => setView({ type: "done" })} title="Done"><Icon name="done" /></button>
        <button style={S.railIcon} onClick={() => setView({ type: "bin" })} title="Bin"><Icon name="bin" /></button>
        <div style={S.railProjects}>
          {sortedProjects.map((p) => <button key={p.id} style={{ ...S.railDot, background: p.color }} onClick={() => setView({ type: "project", id: p.id })} title={p.label} />)}
        </div>
      </aside>
    );
  }

  return (
    <aside style={S.sidebar}>
      <div style={S.sidebarTop}>
        <div style={S.brandSmall}><Logo size={22} /> Daypath</div>
        <button style={S.collapseBtn} onClick={() => setCollapsed(true)} title="Collapse">‹</button>
      </div>
      <nav style={S.nav}>
        <button className={"dp-navhover"+(view.type==="upcoming"?" dp-active":"")} style={{ ...S.navItem, ...(view.type === "upcoming" ? S.navItemOn : {}) }} onClick={() => setView({ type: "upcoming" })}><span style={S.navIcon}><Icon name="upcoming" /></span> Upcoming</button>
        <button className={"dp-navhover"+(view.type==="done"?" dp-active":"")} style={{ ...S.navItem, ...(view.type === "done" ? S.navItemOn : {}) }} onClick={() => setView({ type: "done" })}><span style={S.navIcon}><Icon name="done" /></span> Done</button>
        <button className={"dp-navhover"+(view.type==="bin"?" dp-active":"")} style={{ ...S.navItem, ...(view.type === "bin" ? S.navItemOn : {}) }} onClick={() => setView({ type: "bin" })}><span style={S.navIcon}><Icon name="bin" /></span> Bin</button>
      </nav>
      <div style={S.searchRow}>
        <span style={S.searchIcon}><Icon name="search" size={15} /></span>
        <input style={S.searchInput} placeholder="Search…" value={search} onChange={(e) => { setSearch(e.target.value); setView({ type: "search" }); }} />
      </div>
      <div style={S.projHeader}>
        <span style={S.projHeaderLabel}>Projects</span>
        <button style={S.projAdd} onClick={() => setAddingProject(true)} title="New project">+</button>
      </div>
      {addingProject && (
        <div style={S.projAddRow}>
          <input autoFocus style={S.projAddInput} placeholder="Project name" value={newProjName}
            onChange={(e) => setNewProjName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitNewProject(); if (e.key === "Escape") { setAddingProject(false); setNewProjName(""); } }}
            onBlur={submitNewProject} />
        </div>
      )}
      <div style={S.projList}>
        {sortedProjects.length === 0 && <div style={S.projEmpty}>None yet. Tap + to add one.</div>}
        {sortedProjects.map((p) => {
          const count = tasks.filter((t) => t.project === p.id && !(t.doneDates || []).length).length;
          return (
            <button key={p.id} className={"dp-navhover"+(view.type==="project"&&view.id===p.id?" dp-active":"")} style={{ ...S.projItem, ...(view.type === "project" && view.id === p.id ? S.projItemOn : {}) }} onClick={() => setView({ type: "project", id: p.id })}>
              <span style={{ ...S.projDot, background: p.color }} />
              <span style={S.projLabel}>{p.label}</span>
              {count > 0 && <span style={S.projCount}>{count}</span>}
            </button>
          );
        })}
        {(() => {
          const count = tasks.filter((t) => !t.project && !(t.doneDates || []).length).length;
          return (
            <button className={"dp-navhover"+(view.type==="project"&&view.id===NO_PROJECT_ID?" dp-active":"")} style={{ ...S.projItem, ...(view.type === "project" && view.id === NO_PROJECT_ID ? S.projItemOn : {}) }} onClick={() => setView({ type: "project", id: NO_PROJECT_ID })}>
              <span style={{ ...S.projDot, background: "#9aa6a0" }} />
              <span style={{ ...S.projLabel, fontStyle: "italic", color: "#8a8275" }}>No project</span>
              {count > 0 && <span style={S.projCount}>{count}</span>}
            </button>
          );
        })()}
      </div>
      <div style={S.calHead}>
        <button style={S.navBtn} onClick={() => shift(-1)}>‹</button>
        <span style={S.calMonth}>{monthLabel}</span>
        <button style={S.navBtn} onClick={() => shift(1)}>›</button>
      </div>
      {dragTask && <div style={S.dropHint}>Drop on a day to reschedule</div>}
      <div style={S.dow}>{["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i}>{d}</span>)}</div>
      <div style={S.calGrid}>
        {grid.map((d, i) => {
          if (!d) return <span key={i} />;
          const isSel = d === (view.type === "day" ? view.date : null);
          const isToday = d === today();
          const isDragOver = dragOverDate === d;
          return (
            <button key={i}
              onClick={() => setView({ type: "day", date: d })}
              onDragOver={(e) => { if (dragTask) { e.preventDefault(); setDragOverDate(d); } }}
              onDragLeave={() => setDragOverDate(null)}
              onDrop={(e) => { e.preventDefault(); setDragOverDate(null); if (dragTask) onDropDate(dragTask, d); }}
              style={{ ...S.dayCell, ...(isToday ? S.dayToday : {}), ...(isSel ? S.daySel : {}), ...(isDragOver ? S.dayDragOver : {}) }}>
              {Number(d.slice(-2))}
              {hasTask(d) && <span style={{ ...S.dot, background: isSel ? "#fff" : "#c9a888" }} />}
            </button>
          );
        })}
      </div>
      <div style={S.userBox}>
        <div style={S.userEmail}>{user.email}</div>
        <button style={S.signOut} onClick={onSignOut}>Sign out</button>
      </div>
    </aside>
  );
}

// ============================================================================
function TaskCard({ task, date, projects, onToggle, onOpen, refresh, done, draggable, onDragStartTask, dragHandlers, showProjectChip = true }) {
  const project = projects.find((p) => p.id === task.project);
  const [moving, setMoving] = useState(false);
  const [delChoice, setDelChoice] = useState(false);
  const isRecurring = task.recur && task.recur !== "none";
  const move = async (newDate) => {
    if (isRecurring && date) await api.moveOccurrence(task.id, date, newDate);
    else await api.saveTask({ ...task, date: newDate, order: nextOrder() });
    setMoving(false); refresh();
  };
  const del = async (e) => {
    e.stopPropagation();
    // For a recurring occurrence shown on a real date, offer skip-vs-series.
    if (isRecurring && date) { setDelChoice(true); return; }
    await api.deleteTask(task.id); refresh();
  };
  const skipThis = async () => { await api.skipOccurrence(task.id, date); setDelChoice(false); refresh(); };
  const deleteSeries = async () => { await api.deleteTask(task.id); setDelChoice(false); refresh(); };
  return (
    <div className="dp-card" draggable={draggable} onDragStart={(e) => { if (onDragStartTask) onDragStartTask(e, { ...task, __occDate: date || null }); }} {...(dragHandlers || {})}
      style={{ ...S.card, ...(done ? S.cardDone : {}), ...(project ? { borderLeft: `3px solid ${project.color}` } : {}) }}>
      {draggable && <span style={S.grip} title="Drag to reorder or onto a day">⠿</span>}
      <button className="dp-check" style={{ ...S.check, ...(done ? S.checkOn : {}) }} onClick={onToggle}>{done ? "✓" : ""}</button>
      <div style={S.cardBody} onClick={onOpen}>
        <div style={S.cardTopline}><span style={{ ...S.cardTitle, ...(done ? S.strike : {}) }}>{task.title}</span></div>
        {task.notes && <div style={S.cardNotes}>{task.notes}</div>}
        {(showProjectChip && project) || isRecurring ? (
          <div style={S.cardMeta}>
            {showProjectChip && project && <span style={{ ...S.projChip, color: project.color, background: project.color + "1a" }}>{project.label}</span>}
            {isRecurring && <span style={S.metaText}>↻ {RECUR.find((r) => r.id === task.recur)?.label}{recurEndSuffix(task)}</span>}
          </div>
        ) : null}
      </div>
      <div style={S.cardActions}>
        {date !== undefined && !done && <button style={S.moveBtn} onClick={() => setMoving((m) => !m)} title="Move to another day">⤷</button>}
        <button style={S.delBtn} onClick={del} title={isRecurring && date ? "Delete options" : "Delete to bin"}>✕</button>
        {moving && <MoveMenu currentDate={date || today()} onPick={move} onClose={() => setMoving(false)} />}
        {delChoice && <DeleteMenu onSkip={skipThis} onSeries={deleteSeries} onClose={() => setDelChoice(false)} />}
      </div>
    </div>
  );
}

function recurEndSuffix(task) {
  if (task.recurEnd === "date" && task.recurEndDate) return ` until ${fmtShort(task.recurEndDate)}`;
  if (task.recurEnd === "count" && task.recurEndCount) return ` ×${task.recurEndCount}`;
  return "";
}

function DeleteMenu({ onSkip, onSeries, onClose }) {
  const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, [onClose]);
  return (
    <div ref={ref} className="dp-pop" style={S.movePop}>
      <div style={S.moveTitle}>Recurring task</div>
      <button style={S.moveOpt} onClick={onSkip}>Skip just this one</button>
      <button style={{ ...S.moveOpt, color: "#d85c44" }} onClick={onSeries}>Delete whole series</button>
    </div>
  );
}

function MoveMenu({ currentDate, onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, [onClose]);
  const quick = [{ label: "Today", date: today() }, { label: "Tomorrow", date: addDays(today(), 1) }, { label: "Next week", date: addDays(today(), 7) }];
  return (
    <div ref={ref} className="dp-pop" style={S.movePop}>
      <div style={S.moveTitle}>Move to</div>
      {quick.map((q) => <button key={q.label} style={S.moveOpt} onClick={() => onPick(q.date)}>{q.label}<span style={S.moveOptDate}>{fmtShort(q.date)}</span></button>)}
      <div style={S.moveDivider} />
      <div style={S.moveNudges}>
        <button style={S.nudge} onClick={() => onPick(addDays(currentDate, -1))}>−1 day</button>
        <button style={S.nudge} onClick={() => onPick(addDays(currentDate, 1))}>+1 day</button>
      </div>
      <input type="date" style={S.moveDateInput} defaultValue={currentDate} onChange={(e) => e.target.value && onPick(e.target.value)} />
    </div>
  );
}

function useReorder(items, onCommit) {
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const start = (e, task) => { setDragId(task.id); e.dataTransfer.effectAllowed = "move"; };
  const over = (e, task) => { e.preventDefault(); if (task.id !== overId) setOverId(task.id); };
  const drop = (e, task) => {
    e.preventDefault();
    if (!dragId || dragId === task.id) { setDragId(null); setOverId(null); return; }
    const ordered = [...items];
    const from = ordered.findIndex((t) => t.id === dragId);
    const to = ordered.findIndex((t) => t.id === task.id);
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    onCommit(ordered.map((t, i) => ({ ...t, order: i + 1 })));
    setDragId(null); setOverId(null);
  };
  const end = () => { setDragId(null); setOverId(null); };
  return { dragId, overId, start, over, drop, end };
}

// ============================================================================
// UPCOMING (dated tasks soonest-first, then a pinned "No date" section)
// ============================================================================
function UpcomingView({ tasks, projects, expenses, refresh, openEditor, goToDay, setDragTask }) {
  const t0 = today();
  // Overdue: non-recurring dated tasks whose date is before today and not done.
  const overdue = useMemo(() => {
    return tasks.filter((t) => t.date && t.recur === "none" && t.date < t0 && !isDone(t, t.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [tasks]);
  const overdueGroups = useMemo(() => groupByProject(overdue, projects), [overdue, projects]);

  const items = useMemo(() => {
    const flat = [];
    tasks.forEach((task) => upcomingOccurrences(task, t0).forEach((d) => { if (!isDone(task, d)) flat.push({ task, date: d }); }));
    flat.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.task.order || 0) - (b.task.order || 0)));
    return flat.slice(0, 20);
  }, [tasks]);
  const groups = useMemo(() => { const g = []; items.forEach((it) => { const last = g[g.length - 1]; if (last && last.date === it.date) last.items.push(it); else g.push({ date: it.date, items: [it] }); }); return g; }, [items]);
  const someday = useMemo(() => tasks.filter((t) => !t.date && !(t.doneDates || []).length).sort(byOrder), [tasks]);
  const toggle = async (task, date) => { const s = new Set(task.doneDates || []); s.has(date) ? s.delete(date) : s.add(date); await api.saveTask({ ...task, doneDates: [...s] }); refresh(); };

  return (
    <main style={S.main}>
      <header style={S.viewHeader}>
        <h1 style={S.viewTitle}>Upcoming</h1>
      </header>
      {items.length === 0 && someday.length === 0 && overdue.length === 0 && <div style={S.empty}>Nothing yet. Tap + to add a task.</div>}

      <div style={S.upcomingCols}>
        <div style={S.upcomingMain}>
          <div className="dp-timeline" style={S.timeline}>
            {overdue.length > 0 && (
              <section className="dp-tlgroup dp-overdue" style={S.tlGroup}>
                <div style={S.tlDate}>
                  <span style={{ ...S.tlDateMain, color: ACCENT }}>Overdue</span>
                  <span style={S.tlDateSub}>{overdue.length} {overdue.length === 1 ? "task" : "tasks"}</span>
                </div>
                <div style={S.tlItems}>
                  {overdueGroups.map((pg) => (
                    <div key={pg.project?.id || "none"} style={S.tlProjGroup}>
                      <div style={S.tlProjHead}>
                        <span style={{ ...S.tlProjDot, background: pg.project ? pg.project.color : "#9aa6a0" }} />
                        <span style={S.tlProjName}>{pg.project ? pg.project.label : "No project"}</span>
                      </div>
                      {pg.tasks.map((task) => (
                        <TaskCard key={task.id} task={task} date={task.date} projects={projects} done={false} showProjectChip={false}
                          onToggle={() => toggle(task, task.date)} onOpen={() => openEditor(task)} refresh={refresh}
                          draggable onDragStartTask={(e, t) => { setDragTask(t); e.dataTransfer.effectAllowed = "move"; }}
                          dragHandlers={{ onDragEnd: () => setDragTask(null) }} />
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            )}
            {groups.map((grp) => {
              const rel = relativeLabel(grp.date);
              const projGroups = groupByProject(grp.items.map((it) => it.task), projects);
              return (
                <section key={grp.date} className="dp-tlgroup" style={S.tlGroup}>
                  <button style={S.tlDate} onClick={() => goToDay(grp.date)}>
                    <span style={S.tlDateMain}>{rel || fmtShort(grp.date)}</span>
                    {rel && <span style={S.tlDateSub}>{fmtShort(grp.date)}</span>}
                  </button>
                  <div style={S.tlItems}>
                    {projGroups.map((pg) => (
                      <div key={pg.project?.id || "none"} style={S.tlProjGroup}>
                        <div style={S.tlProjHead}>
                          <span style={{ ...S.tlProjDot, background: pg.project ? pg.project.color : "#9c958a" }} />
                          <span style={S.tlProjName}>{pg.project ? pg.project.label : "No project"}</span>
                        </div>
                        {pg.tasks.map((task) => (
                          <TaskCard key={task.id + grp.date} task={task} date={grp.date} projects={projects} done={false} showProjectChip={false}
                            onToggle={() => toggle(task, grp.date)} onOpen={() => openEditor(task)} refresh={refresh}
                            draggable onDragStartTask={(e, t) => { setDragTask(t); e.dataTransfer.effectAllowed = "move"; }}
                            dragHandlers={{ onDragEnd: () => setDragTask(null) }} />
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
            {groups.length === 0 && <div style={S.colEmpty}>No dated tasks.</div>}
          </div>
        </div>

        <div style={S.sideCol}>
          <aside style={S.somedayCol}>
            <div style={{ ...S.somedayColHead, marginBottom: 16 }}>
              <span style={S.somedayColTitle}>◇ Someday</span>
              {someday.length > 0 && <span style={S.somedayColCount}>{someday.length}</span>}
            </div>
            <div style={S.list}>
              {someday.length === 0 && <div style={S.colEmpty}>Empty</div>}
              {someday.map((task) => (
                <TaskCard key={task.id} task={task} date={null} projects={projects} done={false}
                  onToggle={async () => { await api.saveTask({ ...task, doneDates: (task.doneDates || []).length ? [] : [today()] }); refresh(); }}
                  onOpen={() => openEditor(task)} refresh={refresh}
                  draggable onDragStartTask={(e, t) => { setDragTask(t); e.dataTransfer.effectAllowed = "move"; }}
                  dragHandlers={{ onDragEnd: () => setDragTask(null) }} />
              ))}
            </div>
          </aside>
          <ExpensesBox expenses={expenses} refresh={refresh} />
        </div>
      </div>
    </main>
  );
}

// ============================================================================
// EXPENSES (name + date + amount; check off once claimed back)
// ============================================================================
function ExpensesBox({ expenses, refresh }) {
  const [name, setName] = useState("");
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState("");

  const sorted = useMemo(() => {
    const pending = expenses.filter((e) => !e.claimed).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const claimed = expenses.filter((e) => e.claimed).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return [...pending, ...claimed];
  }, [expenses]);
  const pendingTotal = useMemo(() => expenses.filter((e) => !e.claimed).reduce((sum, e) => sum + (Number(e.amount) || 0), 0), [expenses]);

  const add = async () => {
    const amt = Number(amount);
    if (!name.trim() || !amt || amt <= 0) return;
    await api.saveExpense({ id: crypto.randomUUID(), name: name.trim(), date, amount: amt, claimed: false });
    setName(""); setAmount(""); refresh();
  };
  const toggleClaimed = async (exp) => { await api.saveExpense({ ...exp, claimed: !exp.claimed }); refresh(); };
  const remove = async (id) => { await api.deleteExpense(id); refresh(); };

  return (
    <aside style={S.expensesCol}>
      <div style={{ ...S.expensesColHead, marginBottom: 14 }}>
        <span style={S.expensesColTitle}>◈ Expenses</span>
        {pendingTotal > 0 && <span style={S.expensesColCount}>£{pendingTotal.toFixed(2)} to claim</span>}
      </div>
      <div style={S.expenseComposer}>
        <input style={S.expenseNameInput} placeholder="What was it?" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <input type="date" style={S.expenseDateInput} value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="number" min="0" step="0.01" style={S.expenseAmountInput} placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button style={S.smallBtn} onClick={add}>Add</button>
      </div>
      <div style={S.list}>
        {sorted.length === 0 && <div style={S.colEmpty}>Empty</div>}
        {sorted.map((exp) => (
          <div key={exp.id} style={{ ...S.expenseRow, ...(exp.claimed ? S.expenseRowClaimed : {}) }}>
            <button className="dp-check" style={{ ...S.check, ...(exp.claimed ? S.checkOn : {}) }} onClick={() => toggleClaimed(exp)} title="Mark claimed back">{exp.claimed ? "✓" : ""}</button>
            <div style={S.expenseBody}>
              <div style={{ ...S.expenseName, ...(exp.claimed ? S.strike : {}) }}>{exp.name}</div>
              <div style={S.expenseMeta}>{fmtShort(exp.date)}</div>
            </div>
            <div style={S.expenseAmount}>£{Number(exp.amount).toFixed(2)}</div>
            <button style={S.delBtn} onClick={() => remove(exp.id)} title="Delete">✕</button>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ============================================================================
// DAY (grouped by project; project heading, tasks nested; projects alpha)
// ============================================================================
function DayView({ date, setView, tasks, projects, refresh, openEditor, setDragTask }) {
  const open = useMemo(() => tasks.filter((t) => occursOn(t, date) && !isDone(t, date)), [tasks, date]);
  const done = useMemo(() => tasks.filter((t) => occursOn(t, date) && isDone(t, date)).sort(byOrder), [tasks, date]);
  const groups = useMemo(() => groupByProject(open, projects), [open, projects]);
  const rel = relativeLabel(date);
  const toggle = async (task) => { const s = new Set(task.doneDates || []); s.has(date) ? s.delete(date) : s.add(date); await api.saveTask({ ...task, doneDates: [...s] }); refresh(); };

  return (
    <main style={S.main}>
      <header style={S.dayHeader}>
        <div>
          {rel && <div style={S.relLabel}>{rel}</div>}
          <h1 style={S.dayTitle}>{fmtLong(date)}</h1>
        </div>
        <div style={S.dayNav}>
          <button style={S.navBtnLg} onClick={() => setView({ type: "day", date: addDays(date, -1) })}>‹</button>
          <button style={S.todayBtn} onClick={() => setView({ type: "day", date: today() })}>Today</button>
          <button style={S.navBtnLg} onClick={() => setView({ type: "day", date: addDays(date, 1) })}>›</button>
        </div>
      </header>

      {open.length === 0 && done.length === 0 && <div style={S.empty}>Nothing scheduled for this day.</div>}

      <div style={S.projGroups}>
        {groups.map((grp) => (
          <DayProjectGroup key={grp.project?.id || "none"} group={grp} date={date} projects={projects} refresh={refresh} openEditor={openEditor} setDragTask={setDragTask} onToggle={toggle} setView={setView} />
        ))}
      </div>

      {done.length > 0 && (
        <>
          <div style={S.doneHead}>Done · {done.length}</div>
          <div style={S.list}>
            {done.map((task) => <TaskCard key={task.id} task={task} date={date} projects={projects} done onToggle={() => toggle(task)} onOpen={() => openEditor(task)} refresh={refresh} />)}
          </div>
        </>
      )}
    </main>
  );
}

function DayProjectGroup({ group, date, projects, refresh, openEditor, setDragTask, onToggle, setView }) {
  const { project, tasks } = group;
  const reorder = useReorder(tasks, (renum) => { api.saveTasks(renum).then(refresh); });
  return (
    <section style={S.projGroup}>
      <div style={S.projGroupHead}>
        <span style={{ ...S.projGroupDot, background: project ? project.color : "#cbbba8" }} />
        {project
          ? <button style={S.projGroupTitle} onClick={() => setView({ type: "project", id: project.id })}>{project.label}</button>
          : <span style={S.projGroupTitle}>Unassigned</span>}
        <span style={S.projGroupCount}>{tasks.length}</span>
      </div>
      <div style={S.projGroupItems}>
        {tasks.map((task) => (
          <div key={task.id} onDragOver={(e) => reorder.over(e, task)} onDrop={(e) => reorder.drop(e, task)}
            style={{ ...(reorder.overId === task.id && reorder.dragId !== task.id ? S.dropLine : {}), ...(reorder.dragId === task.id ? { opacity: 0.4 } : {}) }}>
            <TaskCard task={task} date={date} projects={projects} done={false} showProjectChip={false}
              onToggle={() => onToggle(task)} onOpen={() => openEditor(task)} refresh={refresh}
              draggable onDragStartTask={(e, t) => { reorder.start(e, t); setDragTask(t); }}
              dragHandlers={{ onDragEnd: () => { reorder.end(); setDragTask(null); } }} />
          </div>
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// PROJECT (tasks + discrete dated notes)
// ============================================================================
function ProjectView({ projectId, tasks, projects, refresh, openEditor, setDragTask, setView }) {
  const isNoProject = projectId === NO_PROJECT_ID;
  const project = isNoProject ? api.getProject(NO_PROJECT_ID) : projects.find((p) => p.id === projectId);
  const [noteText, setNoteText] = useState("");
  const [noteDate, setNoteDate] = useState(today());
  const [editingProj, setEditingProj] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editNoteText, setEditNoteText] = useState("");
  const [editNoteDate, setEditNoteDate] = useState(today());

  const matchesProject = (t) => isNoProject ? !t.project : t.project === projectId;
  const open = useMemo(() => tasks.filter((t) => matchesProject(t) && !(t.doneDates || []).length).sort((a, b) => { if (!a.date && b.date) return 1; if (a.date && !b.date) return -1; if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1; return byOrder(a, b); }), [tasks, projectId]);
  const done = useMemo(() => tasks.filter((t) => matchesProject(t) && (t.doneDates || []).length).sort(byOrder), [tasks, projectId]);
  const notes = useMemo(() => [...(project?.notes || [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)), [project]);

  const addNote = async () => {
    if (!noteText.trim()) return;
    const entry = { id: crypto.randomUUID(), date: noteDate, text: noteText.trim() };
    await api.saveProject({ ...project, notes: [...(project.notes || []), entry] });
    setNoteText(""); setNoteDate(today()); refresh();
  };
  const deleteNote = async (id) => { await api.deleteNote(projectId, id); refresh(); };
  const deleteProject = async () => { await api.deleteProject(projectId); refresh(); setView({ type: "upcoming" }); };
  const toggle = async (task) => { await api.saveTask({ ...task, doneDates: (task.doneDates || []).length ? [] : [today()] }); refresh(); };

  const startEditProj = () => { setEditLabel(project.label); setEditColor(project.color); setEditingProj(true); };
  const saveEditProj = async () => { if (!editLabel.trim()) { setEditingProj(false); return; } await api.saveProject({ ...project, label: editLabel.trim(), color: editColor }); setEditingProj(false); refresh(); };

  const startEditNote = (n) => { setEditingNoteId(n.id); setEditNoteText(n.text); setEditNoteDate(n.date); };
  const saveEditNote = async () => {
    if (!editNoteText.trim()) { setEditingNoteId(null); return; }
    const updated = (project.notes || []).map((n) => n.id === editingNoteId ? { ...n, text: editNoteText.trim(), date: editNoteDate } : n);
    await api.saveProject({ ...project, notes: updated });
    setEditingNoteId(null); refresh();
  };

  if (!project) return <main style={S.main}><div style={S.empty}>Project not found.</div></main>;

  return (
    <main style={S.main}>
      <header style={S.viewHeader}>
        <div style={S.projHeaderRow}>
          {editingProj ? (
            <div style={S.projEditRow}>
              <input autoFocus style={S.projEditInput} value={editLabel} onChange={(e) => setEditLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveEditProj(); if (e.key === "Escape") setEditingProj(false); }} />
              <div style={S.colorPicker}>
                {PROJECT_COLORS.map((c) => (
                  <button key={c} onClick={() => setEditColor(c)} style={{ ...S.colorSwatch, background: c, ...(editColor === c ? S.colorSwatchOn : {}) }} title="Set colour" />
                ))}
              </div>
              <button style={S.smallBtn} onClick={saveEditProj}>Save</button>
              <button style={S.ghostBtnSm} onClick={() => setEditingProj(false)}>Cancel</button>
            </div>
          ) : (
            <>
              <div style={S.projTitleRow}>
                <span style={{ ...S.projTitleDot, background: project.color }} />
                <h1 style={S.viewTitle}>{project.label}</h1>
                {!isNoProject && <button style={S.projEditBtn} onClick={startEditProj} title="Rename or recolour">Edit</button>}
              </div>
              {!isNoProject && <button style={S.projDeleteBtn} onClick={deleteProject} title="Delete project">Delete project</button>}
            </>
          )}
        </div>
        <p style={S.viewSub}>{open.length} open {open.length === 1 ? "task" : "tasks"} · {notes.length} {notes.length === 1 ? "note" : "notes"}</p>
      </header>

      <div style={S.projSectionHead}>Notes</div>
      <div style={S.noteComposer}>
        <input type="date" style={S.noteDate} value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />
        <input style={S.noteInput} placeholder="Add a note…" value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} />
        <button style={S.smallBtn} onClick={addNote}>Add</button>
      </div>
      <div style={S.noteList}>
        {notes.length === 0 && <div style={S.noteEmpty}>No notes yet. Add a dated note above.</div>}
        {notes.map((n) => (
          editingNoteId === n.id ? (
            <div key={n.id} style={{ ...S.noteItem, borderLeft: `3px solid ${project.color}` }}>
              <input type="date" style={S.noteDate} value={editNoteDate} onChange={(e) => setEditNoteDate(e.target.value)} />
              <input autoFocus style={S.noteInput} value={editNoteText} onChange={(e) => setEditNoteText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveEditNote(); if (e.key === "Escape") setEditingNoteId(null); }} />
              <button style={S.smallBtn} onClick={saveEditNote}>Save</button>
            </div>
          ) : (
            <div key={n.id} style={{ ...S.noteItem, borderLeft: `3px solid ${project.color}` }}>
              <div style={S.noteItemDate}>{fmtNote(n.date)}</div>
              <div style={S.noteItemText} onClick={() => startEditNote(n)}>{n.text}</div>
              <button style={S.noteEdit} onClick={() => startEditNote(n)} title="Edit note">Edit</button>
              <button style={S.noteDelete} onClick={() => deleteNote(n.id)} title="Delete note">✕</button>
            </div>
          )
        ))}
      </div>

      <div style={{ ...S.projSectionHead, marginTop: 32 }}>Tasks</div>
      {open.length === 0 && done.length === 0 && <div style={S.empty}>No tasks in this project yet.</div>}
      <div style={S.list}>
        {open.map((task) => (
          <TaskCard key={task.id} task={task} date={task.date} projects={projects} done={false} showProjectChip={false}
            onToggle={() => toggle(task)} onOpen={() => openEditor(task)} refresh={refresh}
            draggable onDragStartTask={(e, t) => { setDragTask(t); e.dataTransfer.effectAllowed = "move"; }}
            dragHandlers={{ onDragEnd: () => setDragTask(null) }} />
        ))}
      </div>
      {done.length > 0 && (
        <>
          <div style={S.doneHead}>Done · {done.length}</div>
          <div style={S.list}>{done.map((task) => <TaskCard key={task.id} task={task} date={task.date} projects={projects} done showProjectChip={false} onToggle={() => toggle(task)} onOpen={() => openEditor(task)} refresh={refresh} />)}</div>
        </>
      )}
    </main>
  );
}

// ============================================================================
// BIN (30-day soft-delete; restore or delete forever)
// ============================================================================
function BinView({ refresh }) {
  const [entries, setEntries] = useState(null);
  const reload = async () => setEntries(await api.loadBin());
  useEffect(() => { reload(); }, []);

  const restore = async (binId) => { await api.restoreFromBin(binId); await reload(); refresh(); };
  const purge = async (binId) => { await api.purgeFromBin(binId); await reload(); };
  const empty = async () => { await api.emptyBin(); await reload(); };

  const kindLabel = (e) => e.kind === "task" ? "Task" : e.kind === "project" ? "Project" : "Note";
  const itemTitle = (e) => {
    if (e.kind === "task") return e.payload.title;
    if (e.kind === "project") return e.payload.project.label;
    return e.payload.text;
  };
  const daysLeft = (e) => { const ms = new Date(e.expiresAt + "T00:00:00") - new Date(today() + "T00:00:00"); return Math.max(0, Math.round(ms / 86400000)); };

  return (
    <main style={S.main}>
      <header style={S.viewHeader}>
        <div style={S.projHeaderRow}>
          <h1 style={S.viewTitle}>Bin</h1>
          {entries && entries.length > 0 && <button style={S.projDeleteBtn} onClick={empty}>Empty bin</button>}
        </div>
      </header>
      {entries === null && <div style={S.empty}>Loading…</div>}
      {entries && entries.length === 0 && <div style={S.empty}>The bin is empty.</div>}
      <div style={S.list}>
        {entries && entries.map((e) => (
          <div key={e.binId} style={S.binItem}>
            <div style={S.binBody}>
              <div style={S.binTopline}>
                <span style={S.binKind}>{kindLabel(e)}</span>
                <span style={S.binTitle}>{itemTitle(e)}</span>
              </div>
              <div style={S.binMeta}>Deleted {fmtNote(e.deletedAt)} · {daysLeft(e)} {daysLeft(e) === 1 ? "day" : "days"} left{e.kind === "note" && e.meta.projectLabel ? ` · from ${e.meta.projectLabel}` : ""}{e.kind === "project" ? ` · ${e.meta.taskCount} ${e.meta.taskCount === 1 ? "task" : "tasks"}, ${e.meta.noteCount} ${e.meta.noteCount === 1 ? "note" : "notes"}` : ""}</div>
            </div>
            <div style={S.binActions}>
              <button style={S.binRestore} onClick={() => restore(e.binId)}>Restore</button>
              <button style={S.binPurge} onClick={() => purge(e.binId)} title="Delete forever">✕</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

// ============================================================================
// DONE (completion history, newest first)
// ============================================================================
function DoneView({ tasks, projects, refresh, openEditor }) {
  // A task counts as done if it has any completion date. Show most recent first.
  const items = useMemo(() => {
    return tasks
      .filter((t) => (t.doneDates || []).length)
      .map((t) => ({ task: t, when: [...(t.doneDates || [])].sort().slice(-1)[0] }))
      .sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
  }, [tasks]);
  const groups = useMemo(() => { const g = []; items.forEach((it) => { const last = g[g.length - 1]; if (last && last.when === it.when) last.items.push(it); else g.push({ when: it.when, items: [it] }); }); return g; }, [items]);
  const untick = async (task) => { await api.saveTask({ ...task, doneDates: [] }); refresh(); };

  return (
    <main style={S.main}>
      <header style={S.viewHeader}><h1 style={S.viewTitle}>Done</h1></header>
      {items.length === 0 && <div style={S.empty}>Nothing completed yet.</div>}
      <div className="dp-timeline" style={S.timeline}>
        {groups.map((grp) => {
          const rel = relativeLabel(grp.when);
          return (
            <section key={grp.when} className="dp-tlgroup" style={S.tlGroup}>
              <div style={S.tlDate}><span style={S.tlDateMain}>{rel || fmtShort(grp.when)}</span>{rel && <span style={S.tlDateSub}>{fmtShort(grp.when)}</span>}</div>
              <div style={S.tlItems}>
                {grp.items.map(({ task }) => (
                  <TaskCard key={task.id} task={task} date={undefined} projects={projects} done
                    onToggle={() => untick(task)} onOpen={() => openEditor(task)} refresh={refresh} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

// ============================================================================
// SEARCH (across task titles, task notes, and project notes)
// ============================================================================
function SearchView({ query, tasks, projects, openEditor, goToProject }) {
  const q = (query || "").trim().toLowerCase();
  const taskHits = useMemo(() => {
    if (!q) return [];
    return tasks.filter((t) => (t.title || "").toLowerCase().includes(q) || (t.notes || "").toLowerCase().includes(q));
  }, [q, tasks]);
  const noteHits = useMemo(() => {
    if (!q) return [];
    const hits = [];
    const scan = (proj) => (proj.notes || []).forEach((n) => { if ((n.text || "").toLowerCase().includes(q)) hits.push({ proj, note: n }); });
    projects.forEach(scan);
    scan(api.getProject(NO_PROJECT_ID));
    return hits;
  }, [q, projects]);

  return (
    <main style={S.main}>
      <header style={S.viewHeader}>
        <h1 style={S.viewTitle}>Search</h1>
        {q && <p style={S.viewSub}>{taskHits.length + noteHits.length} {taskHits.length + noteHits.length === 1 ? "result" : "results"} for “{query}”.</p>}
      </header>
      {!q && <div style={S.empty}>Search tasks and notes.</div>}
      {q && taskHits.length === 0 && noteHits.length === 0 && <div style={S.empty}>No matches.</div>}

      {taskHits.length > 0 && (
        <>
          <div style={S.projSectionHead}>Tasks</div>
          <div style={S.list}>
            {taskHits.map((t) => (
              <div key={t.id} style={{ ...S.card, ...(t.project ? { borderLeft: `3px solid ${(projects.find((p) => p.id === t.project) || {}).color || "#9c958a"}` } : {}) }}>
                <div style={S.cardBody} onClick={() => openEditor(t)}>
                  <div style={S.cardTopline}><span style={S.cardTitle}>{t.title}</span></div>
                  {t.notes && <div style={S.cardNotes}>{t.notes}</div>}
                  <div style={S.cardMeta}>{t.date ? <span style={S.metaText}>{fmtShort(t.date)}</span> : <span style={S.metaText}>Someday</span>}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {noteHits.length > 0 && (
        <>
          <div style={{ ...S.projSectionHead, marginTop: 24 }}>Notes</div>
          <div style={S.noteList}>
            {noteHits.map(({ proj, note }) => (
              <div key={note.id} style={{ ...S.noteItem, borderLeft: `3px solid ${proj.color}`, cursor: "pointer" }} onClick={() => proj.id !== NO_PROJECT_ID ? goToProject(proj.id) : goToProject(NO_PROJECT_ID)}>
                <div style={S.noteItemDate}>{fmtNote(note.date)}</div>
                <div style={S.noteItemText}>{note.text}</div>
                <span style={S.noteProjTag}>{proj.label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

// ============================================================================
// TASK EDITOR (project first, optional date, no reminders)
// ============================================================================
function TaskEditor({ task, defaultDate, defaultProject, projects, refresh, onClose }) {
  const sorted = alphaProjects(projects);
  const [project, setProject] = useState(task?.project ?? defaultProject ?? "");
  const [title, setTitle] = useState(task?.title || "");
  const [notes, setNotes] = useState(task?.notes || "");
  const [hasDate, setHasDate] = useState(task ? !!task.date : (defaultDate !== null));
  const [date, setDate] = useState(task?.date || (defaultDate || today()));
  const [recur, setRecur] = useState(task?.recur || "none");
  const [recurEnd, setRecurEnd] = useState(task?.recurEnd || "none");
  const [recurEndDate, setRecurEndDate] = useState(task?.recurEndDate || addDays(today(), 30));
  const [recurEndCount, setRecurEndCount] = useState(task?.recurEndCount || 10);
  const [newProj, setNewProj] = useState("");
  const [showNewProj, setShowNewProj] = useState(false);
  const [localProjects, setLocalProjects] = useState(sorted);

  const save = async () => {
    if (!title.trim()) return;
    const repeats = hasDate && recur !== "none";
    await api.saveTask({
      id: task?.id || crypto.randomUUID(),
      title: title.trim(), notes: notes.trim(), project: project || null,
      date: hasDate ? date : null, recur: hasDate ? recur : "none",
      recurEnd: repeats ? recurEnd : "none",
      recurEndDate: repeats && recurEnd === "date" ? recurEndDate : null,
      recurEndCount: repeats && recurEnd === "count" ? Number(recurEndCount) : null,
      skipDates: task?.skipDates || [],
      order: task?.order || nextOrder(), doneDates: task?.doneDates || [],
    });
    refresh(); onClose();
  };
  const remove = async () => { if (task) { await api.deleteTask(task.id); refresh(); onClose(); } };
  const createProject = async () => { if (!newProj.trim()) return; const p = await api.addProject(newProj.trim()); setLocalProjects(alphaProjects([...localProjects, p])); setProject(p.id); setNewProj(""); setShowNewProj(false); };

  return (
    <div className="dp-overlay" style={S.overlay} onClick={onClose}>
      <div className="dp-sheet" style={S.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.sheetHandle} />
        <div style={S.field}>
          <label style={S.fieldLabel}>Project</label>
          {showNewProj ? (
            <div style={S.newProjRow}>
              <input autoFocus style={S.fieldInput} placeholder="New project name" value={newProj} onChange={(e) => setNewProj(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createProject()} />
              <button style={S.smallBtn} onClick={createProject}>Add</button>
            </div>
          ) : (
            <div style={S.projRow}>
              <select style={S.fieldInput} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">No project</option>
                {localProjects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <button style={S.smallBtn} onClick={() => setShowNewProj(true)}>+ New</button>
            </div>
          )}
        </div>
        <input style={S.sheetTitle} placeholder="Task title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea style={S.notesInput} placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        <label style={S.dateToggle}>
          <input type="checkbox" checked={hasDate} onChange={(e) => setHasDate(e.target.checked)} />
          <span>Give this a due day</span>
        </label>
        {hasDate && (
          <>
            <div style={S.field}>
              <label style={S.fieldLabel}>Date</label>
              <input type="date" style={S.fieldInput} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div style={S.field}>
              <label style={S.fieldLabel}>Repeat</label>
              <select style={S.fieldInput} value={recur} onChange={(e) => setRecur(e.target.value)}>
                {RECUR.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
            {recur !== "none" && (
              <div style={S.field}>
                <label style={S.fieldLabel}>Ends</label>
                <select style={S.fieldInput} value={recurEnd} onChange={(e) => setRecurEnd(e.target.value)}>
                  <option value="none">Never</option>
                  <option value="date">On a date</option>
                  <option value="count">After a number of times</option>
                </select>
                {recurEnd === "date" && (
                  <input type="date" style={{ ...S.fieldInput, marginTop: 8 }} value={recurEndDate} min={date} onChange={(e) => setRecurEndDate(e.target.value)} />
                )}
                {recurEnd === "count" && (
                  <div style={S.countRow}>
                    <input type="number" min="1" style={S.countInput} value={recurEndCount} onChange={(e) => setRecurEndCount(e.target.value)} />
                    <span style={S.countLabel}>occurrences</span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <div style={S.sheetActions}>
          {task ? <button style={S.deleteBtn} onClick={remove}>Delete</button> : <span />}
          <div style={{ display: "flex", gap: 10 }}>
            <button style={S.ghostBtn} onClick={onClose}>Cancel</button>
            <button style={S.primaryBtn} onClick={save}>{task ? "Save" : "Add task"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
const ACCENT = "#f0806c";
const SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif";
const SURFACE = "#fdfffe";
const S = {
  shell: { display: "flex", height: "100vh", fontFamily: SANS, background: "#ffffff", color: "#1c1917", overflow: "hidden", WebkitFontSmoothing: "antialiased" },
  content: { flex: 1, display: "flex", overflow: "hidden" },
  authWrap: { height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at 30% 20%, #e6f0fc, #fdeee6)", fontFamily: SANS },
  authCard: { background: SURFACE, padding: "44px 40px", borderRadius: 20, width: 340, boxShadow: "0 20px 60px rgba(45,75,65,0.13)", border: "1px solid rgba(0,0,0,0.04)" },
  brand: { fontSize: 30, fontWeight: 700, letterSpacing: "-1px", color: ACCENT, display: "flex", alignItems: "center", gap: 9 },
  input: { width: "100%", padding: "13px 15px", marginBottom: 11, border: "1px solid #e7ddd0", borderRadius: 11, fontSize: 15, fontFamily: SANS, background: "#f4faf7", boxSizing: "border-box", outline: "none" },
  err: { color: "#b91c1c", fontSize: 13, marginBottom: 12 },
  authBtn: { width: "100%", padding: "13px", background: ACCENT, color: "#fff", border: "none", borderRadius: 11, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: SANS },
  switchRow: { textAlign: "center", marginTop: 18, fontSize: 13, color: "#8a7d6f" },
  link: { color: ACCENT, cursor: "pointer", fontWeight: 600 },
  demoHint: { textAlign: "center", marginTop: 20, fontSize: 11, color: "#bcae9d" },

  sidebar: { width: 264, background: SURFACE, borderRight: "1px solid rgba(0,0,0,0.05)", padding: "18px 16px", display: "flex", flexDirection: "column", flexShrink: 0, overflowY: "auto" },
  sidebarCollapsed: { width: 56, background: SURFACE, borderRight: "1px solid rgba(0,0,0,0.05)", padding: "18px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, flexShrink: 0 },
  sidebarTop: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, padding: "0 6px" },
  brandSmall: { fontSize: 20, fontWeight: 700, color: ACCENT, letterSpacing: "-0.8px", display: "flex", alignItems: "center", gap: 7 },
  collapseBtn: { border: "none", background: "#eef2f7", width: 26, height: 26, borderRadius: 7, cursor: "pointer", fontSize: 15, color: "#8a7d6f", lineHeight: 1 },
  railIcon: { border: "none", background: "none", width: 38, height: 38, borderRadius: 9, cursor: "pointer", fontSize: 16, color: "#5c5247" },
  railProjects: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 },
  railDot: { width: 16, height: 16, borderRadius: "50%", border: "none", cursor: "pointer" },

  nav: { display: "flex", flexDirection: "column", gap: 2, marginBottom: 18 },
  navItem: { display: "flex", alignItems: "center", gap: 11, padding: "9px 12px", border: "none", background: "none", borderRadius: 9, cursor: "pointer", fontSize: 14.5, fontWeight: 500, color: "#4b4339", fontFamily: SANS, textAlign: "left", width: "100%" },
  navItemOn: { background: "#fde6df", color: ACCENT, fontWeight: 600 },
  navIcon: { width: 16, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.85 },
  searchRow: { display: "flex", alignItems: "center", gap: 8, background: "#eef2f7", borderRadius: 9, padding: "0 10px", marginBottom: 18 },
  searchIcon: { color: "#8a8275", display: "flex", alignItems: "center" },
  searchInput: { flex: 1, border: "none", background: "none", padding: "9px 0", fontSize: 13.5, fontFamily: SANS, outline: "none", color: "#1c1917" },

  projHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px 8px" },
  projHeaderLabel: { fontSize: 11, fontWeight: 700, color: "#a99c8b", textTransform: "uppercase", letterSpacing: "0.8px" },
  projAdd: { border: "none", background: "#eef2f7", width: 22, height: 22, borderRadius: 6, cursor: "pointer", fontSize: 15, color: "#8a7d6f", lineHeight: 1 },
  projList: { display: "flex", flexDirection: "column", gap: 1, marginBottom: 18 },
  projAddRow: { marginBottom: 8 },
  projAddInput: { width: "100%", border: "1px solid #e7ddd0", borderRadius: 8, padding: "8px 10px", fontSize: 13.5, fontFamily: SANS, background: SURFACE, boxSizing: "border-box", outline: "none", color: "#1c1917" },
  projEmpty: { fontSize: 12.5, color: "#bcae9d", padding: "4px 8px" },
  projItem: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "none", background: "none", borderRadius: 8, cursor: "pointer", width: "100%", textAlign: "left", fontFamily: SANS },
  projItemOn: { background: "#eef2f7" },
  projDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  projLabel: { flex: 1, fontSize: 14, color: "#3c352d", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  projCount: { fontSize: 11.5, color: "#a99c8b", background: "#eef2f7", borderRadius: 10, padding: "1px 7px", fontWeight: 600 },

  calHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, padding: "0 4px" },
  calMonth: { fontSize: 13, fontWeight: 600 },
  navBtn: { border: "none", background: "#eef2f7", width: 24, height: 24, borderRadius: 7, cursor: "pointer", fontSize: 14, color: "#8a7d6f", lineHeight: 1 },
  dropHint: { fontSize: 11, color: ACCENT, textAlign: "center", padding: "2px 0 6px", fontWeight: 600 },
  dow: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, fontSize: 9.5, color: "#bcae9d", textAlign: "center", marginBottom: 4, fontWeight: 600 },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 },
  dayCell: { aspectRatio: "1", border: "none", background: "transparent", borderRadius: 7, cursor: "pointer", fontSize: 12, color: "#3c352d", position: "relative", fontFamily: SANS, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 500 },
  dayToday: { fontWeight: 800, color: ACCENT },
  daySel: { background: ACCENT, color: "#fff", fontWeight: 600 },
  dayDragOver: { background: "#d3e3f7", outline: `2px solid ${ACCENT}` },
  dot: { position: "absolute", bottom: 3, left: "50%", transform: "translateX(-50%)", width: 4, height: 4, borderRadius: "50%", background: "#c9a888" },

  userBox: { marginTop: "auto", paddingTop: 14, borderTop: "1px solid #f0e8dc", padding: "14px 8px 0" },
  userEmail: { fontSize: 12, color: "#8a7d6f", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  signOut: { fontSize: 12, color: ACCENT, background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 500 },

  main: { flex: 1, padding: "40px 56px 120px", overflowY: "auto" },
  viewHeader: { marginBottom: 26 },
  viewTitle: { fontSize: 33, fontWeight: 700, letterSpacing: "-1px", margin: 0 },
  viewSub: { color: "#8a7d6f", fontSize: 14.5, marginTop: 5, maxWidth: 560, lineHeight: 1.5 },
  projTitleRow: { display: "flex", alignItems: "center", gap: 12 },
  projTitleDot: { width: 16, height: 16, borderRadius: "50%" },
  projHeaderRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 },
  projDeleteBtn: { border: "1px solid #e0c9c2", background: "#fdf6f4", color: "#d85c44", cursor: "pointer", fontSize: 12.5, fontWeight: 600, fontFamily: SANS, padding: "7px 13px", borderRadius: 9, whiteSpace: "nowrap" },
  projEditBtn: { border: "1px solid #d3e3f7", background: SURFACE, color: "#3f7bbf", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: SANS, padding: "5px 11px", borderRadius: 8, marginLeft: 4 },
  projEditRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", width: "100%" },
  projEditInput: { border: "1px solid #d8cab6", borderRadius: 9, padding: "9px 12px", fontSize: 19, fontWeight: 700, fontFamily: SANS, outline: "none", color: "#1c1917", letterSpacing: "-0.5px", minWidth: 180 },
  colorPicker: { display: "flex", gap: 5, flexWrap: "wrap" },
  colorSwatch: { width: 22, height: 22, borderRadius: "50%", border: "2px solid transparent", cursor: "pointer", padding: 0 },
  colorSwatchOn: { border: "2px solid #1c1917", transform: "scale(1.12)" },
  ghostBtnSm: { padding: "8px 13px", background: SURFACE, border: "1px solid #e7ddd0", borderRadius: 9, cursor: "pointer", fontSize: 13, fontFamily: SANS, color: "#5c5247", fontWeight: 600 },
  binItem: { display: "flex", alignItems: "center", gap: 14, background: SURFACE, padding: "14px 16px", borderRadius: 13, border: "1px solid rgba(0,0,0,0.04)", boxShadow: "0 1px 3px rgba(45,75,65,0.05)" },
  binBody: { flex: 1, minWidth: 0 },
  binTopline: { display: "flex", alignItems: "baseline", gap: 10 },
  binKind: { fontSize: 10.5, fontWeight: 700, color: "#7d968c", textTransform: "uppercase", letterSpacing: "0.7px", background: "#eef2f7", padding: "2px 7px", borderRadius: 5 },
  binTitle: { fontSize: 15, fontWeight: 600, color: "#3c352d", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  binMeta: { fontSize: 12, color: "#a99c8b", marginTop: 5 },
  binActions: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  binRestore: { border: "1px solid #d8cab6", background: SURFACE, color: "#5c5247", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: SANS, padding: "7px 14px", borderRadius: 9 },
  binPurge: { border: "none", background: "none", color: "#c4a59a", cursor: "pointer", fontSize: 14, padding: 4 },

  dayHeader: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 28 },
  relLabel: { color: ACCENT, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1.2px", marginBottom: 5 },
  dayTitle: { fontSize: 31, fontWeight: 700, letterSpacing: "-1px", margin: 0 },
  dayNav: { display: "flex", gap: 8, alignItems: "center" },
  navBtnLg: { border: "1px solid #e7ddd0", background: SURFACE, width: 38, height: 38, borderRadius: 10, cursor: "pointer", fontSize: 18, color: "#5c5247" },
  todayBtn: { border: "1px solid #e7ddd0", background: SURFACE, padding: "0 16px", height: 38, borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#5c5247" },

  empty: { padding: "50px 0", color: "#bcae9d", fontSize: 15.5, textAlign: "center", maxWidth: 520 },
  timeline: { display: "flex", flexDirection: "column", gap: 24 },
  tlGroup: { display: "flex", gap: 22, alignItems: "flex-start" },
  tlDate: { flexShrink: 0, width: 96, textAlign: "right", border: "none", background: "none", cursor: "pointer", paddingTop: 14, fontFamily: SANS },
  tlDateMain: { display: "block", fontSize: 14, fontWeight: 700, color: "#1c1917", letterSpacing: "-0.3px" },
  tlDateSub: { display: "block", fontSize: 11.5, color: "#a99c8b", marginTop: 2 },
  tlItems: { flex: 1, display: "flex", flexDirection: "column", gap: 14 },
  tlProjGroup: { display: "flex", flexDirection: "column", gap: 6 },
  tlProjHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 1 },
  tlProjDot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
  tlProjName: { fontSize: 12.5, fontWeight: 700, color: "#6f6a5f", letterSpacing: "-0.2px" },
  list: { display: "flex", flexDirection: "column", gap: 8 },

  upcomingCols: { display: "flex", gap: 36, alignItems: "flex-start", flexWrap: "wrap" },
  upcomingMain: { flex: "1 1 460px", minWidth: 0 },
  sideCol: { display: "flex", flexDirection: "column", gap: 20, flex: "0 1 300px", minWidth: 260 },
  somedayCol: { background: "#f3f8fd", borderRadius: 16, padding: "14px 18px 20px", border: "1px solid #e1ebf7" },
  somedayColHead: { display: "flex", alignItems: "center", gap: 9 },
  somedayColTitle: { fontSize: 16, fontWeight: 700, color: "#3a6ba8", letterSpacing: "-0.3px" },
  somedayColCount: { fontSize: 12, color: "#3f7bbf", background: "#d6e6fa", borderRadius: 10, padding: "1px 8px", fontWeight: 600 },
  colEmpty: { fontSize: 13.5, color: "#aab09c", padding: "8px 2px", fontStyle: "italic" },

  expensesCol: { background: "#f0f9f4", borderRadius: 16, padding: "14px 18px 20px", border: "1px solid #dcefe1" },
  expensesColHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, flexWrap: "wrap" },
  expensesColTitle: { fontSize: 16, fontWeight: 700, color: "#2f8a5b", letterSpacing: "-0.3px" },
  expensesColCount: { fontSize: 11.5, color: "#2f8a5b", background: "#d9f0e2", borderRadius: 10, padding: "2px 9px", fontWeight: 700, whiteSpace: "nowrap" },
  expenseComposer: { display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" },
  expenseNameInput: { flex: "1 1 100px", minWidth: 90, border: "1px solid #cfe6d7", borderRadius: 9, padding: "8px 10px", fontSize: 13.5, fontFamily: SANS, background: SURFACE, outline: "none", color: "#1c1917" },
  expenseDateInput: { border: "1px solid #cfe6d7", borderRadius: 9, padding: "8px 8px", fontSize: 12.5, fontFamily: SANS, background: SURFACE, color: "#5c5247", outline: "none" },
  expenseAmountInput: { width: 72, border: "1px solid #cfe6d7", borderRadius: 9, padding: "8px 8px", fontSize: 13.5, fontFamily: SANS, background: SURFACE, outline: "none", color: "#1c1917" },
  expenseRow: { display: "flex", alignItems: "center", gap: 10, background: SURFACE, padding: "10px 12px", borderRadius: 11, border: "1px solid rgba(0,0,0,0.05)" },
  expenseRowClaimed: { opacity: 0.5 },
  expenseBody: { flex: 1, minWidth: 0 },
  expenseName: { fontSize: 14, fontWeight: 600, color: "#1c1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  expenseMeta: { fontSize: 11.5, color: "#a99c8b", marginTop: 2 },
  expenseAmount: { fontSize: 13.5, fontWeight: 700, color: "#2f8a5b", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },

  projGroups: { display: "flex", flexDirection: "column", gap: 22 },
  projGroup: {},
  projGroupHead: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid #ece2d4" },
  projGroupDot: { width: 11, height: 11, borderRadius: "50%", flexShrink: 0 },
  projGroupTitle: { fontSize: 16, fontWeight: 700, color: "#1c1917", letterSpacing: "-0.3px", border: "none", background: "none", padding: 0, cursor: "pointer", fontFamily: SANS },
  projGroupCount: { fontSize: 12, color: "#a99c8b", background: "#eef2f7", borderRadius: 10, padding: "1px 8px", fontWeight: 600 },
  projGroupItems: { display: "flex", flexDirection: "column", gap: 8 },

  card: { display: "flex", alignItems: "flex-start", gap: 12, background: SURFACE, padding: "14px 15px", borderRadius: 13, border: "1px solid rgba(0,0,0,0.08)", boxShadow: "0 1px 3px rgba(45,75,65,0.07)", position: "relative" },
  cardDone: { opacity: 0.5 },
  grip: { color: "#cbbba8", fontSize: 14, cursor: "grab", marginTop: 2, userSelect: "none", lineHeight: 1 },
  check: { width: 21, height: 21, borderRadius: "50%", border: "2px solid #d8cab6", background: SURFACE, cursor: "pointer", flexShrink: 0, marginTop: 1, color: "#fff", fontSize: 11, lineHeight: 1 },
  checkOn: { background: ACCENT, borderColor: ACCENT },
  cardBody: { flex: 1, cursor: "pointer", minWidth: 0 },
  cardTopline: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  cardTitle: { fontSize: 15.5, fontWeight: 600, letterSpacing: "-0.2px" },
  strike: { textDecoration: "line-through" },
  cardNotes: { fontSize: 13.5, color: "#7d7264", marginTop: 4, lineHeight: 1.4 },
  cardMeta: { display: "flex", gap: 9, marginTop: 8, alignItems: "center", flexWrap: "wrap" },
  projChip: { fontSize: 11.5, padding: "2px 9px", borderRadius: 6, fontWeight: 700 },
  metaText: { fontSize: 12, color: "#a99c8b" },
  cardActions: { position: "relative", flexShrink: 0 },
  moveBtn: { border: "none", background: "#eef2f7", color: "#8a7d6f", width: 30, height: 30, borderRadius: 8, cursor: "pointer", fontSize: 15 },
  delBtn: { border: "none", background: "none", color: "#c4a59a", width: 28, height: 30, borderRadius: 8, cursor: "pointer", fontSize: 13 },
  dropLine: { boxShadow: `inset 0 3px 0 ${ACCENT}`, borderRadius: 13 },

  movePop: { position: "absolute", top: 36, right: 0, background: SURFACE, borderRadius: 13, boxShadow: "0 12px 36px rgba(25,45,38,0.18)", border: "1px solid rgba(0,0,0,0.05)", padding: 8, width: 190, zIndex: 30 },
  moveTitle: { fontSize: 11, fontWeight: 700, color: "#a99c8b", textTransform: "uppercase", letterSpacing: "0.8px", padding: "4px 8px 6px" },
  moveOpt: { display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", border: "none", background: "none", padding: "8px", borderRadius: 8, cursor: "pointer", fontSize: 14, color: "#1c1917", fontFamily: SANS, fontWeight: 500 },
  moveOptDate: { fontSize: 12, color: "#a99c8b" },
  moveDivider: { height: 1, background: "#dcebe4", margin: "6px 4px" },
  moveNudges: { display: "flex", gap: 6, padding: "0 4px" },
  nudge: { flex: 1, border: "1px solid #e7ddd0", background: SURFACE, padding: "7px", borderRadius: 8, cursor: "pointer", fontSize: 12.5, color: "#5c5247", fontFamily: SANS, fontWeight: 500 },
  moveDateInput: { width: "100%", marginTop: 8, padding: "7px 8px", border: "1px solid #e7ddd0", borderRadius: 8, fontSize: 13, fontFamily: SANS, boxSizing: "border-box", color: "#5c5247" },
  doneHead: { margin: "26px 0 12px", fontSize: 11.5, color: "#bcae9d", textTransform: "uppercase", letterSpacing: "1px", fontWeight: 700 },

  projSectionHead: { fontSize: 12, fontWeight: 700, color: "#a99c8b", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 12 },
  noteComposer: { display: "flex", gap: 8, marginBottom: 14 },
  noteDate: { border: "1px solid #e7ddd0", borderRadius: 9, padding: "9px 10px", fontSize: 13, fontFamily: SANS, background: SURFACE, color: "#5c5247", outline: "none" },
  noteInput: { flex: 1, border: "1px solid #e7ddd0", borderRadius: 9, padding: "9px 12px", fontSize: 14.5, fontFamily: SANS, background: SURFACE, outline: "none", color: "#1c1917" },
  noteList: { display: "flex", flexDirection: "column", gap: 8 },
  noteEmpty: { fontSize: 13.5, color: "#bcae9d", padding: "4px 2px" },
  noteItem: { display: "flex", alignItems: "flex-start", gap: 12, background: SURFACE, padding: "12px 14px", borderRadius: 11, border: "1px solid rgba(0,0,0,0.04)", boxShadow: "0 1px 3px rgba(45,75,65,0.04)" },
  noteItemDate: { fontSize: 11.5, fontWeight: 700, color: "#a99c8b", whiteSpace: "nowrap", paddingTop: 2, minWidth: 78 },
  noteItemText: { flex: 1, fontSize: 14.5, color: "#3c352d", lineHeight: 1.45, whiteSpace: "pre-wrap" },
  noteDelete: { border: "none", background: "none", color: "#cbbba8", cursor: "pointer", fontSize: 13, padding: 2 },
  noteEdit: { border: "none", background: "none", color: "#7ba0cc", cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: SANS, padding: "2px 4px" },
  noteProjTag: { fontSize: 11, fontWeight: 600, color: "#3f7bbf", background: "#eaf2fc", padding: "2px 8px", borderRadius: 6, whiteSpace: "nowrap", alignSelf: "center" },

  fab: { position: "fixed", bottom: 32, right: 32, width: 56, height: 56, borderRadius: "50%", background: ACCENT, color: "#fff", border: "none", fontSize: 28, cursor: "pointer", boxShadow: "0 8px 24px rgba(240,128,108,0.4)", lineHeight: 1, zIndex: 20 },
  overlay: { position: "fixed", inset: 0, background: "rgba(20,28,38,0.32)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40, padding: 20 },
  sheet: { background: "#ffffff", borderRadius: 22, padding: "20px 24px 24px", width: 440, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 70px rgba(30,45,60,0.28)" },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, background: "#ddd0bf", margin: "0 auto 18px" },
  sheetTitle: { width: "100%", border: "none", background: "none", fontSize: 22, fontWeight: 700, fontFamily: SANS, outline: "none", letterSpacing: "-0.5px", marginBottom: 12, color: "#1c1917" },
  notesInput: { width: "100%", border: "1px solid #e7ddd0", borderRadius: 11, padding: "11px 13px", fontSize: 14.5, fontFamily: SANS, background: SURFACE, boxSizing: "border-box", resize: "vertical", outline: "none", color: "#3c352d", marginBottom: 16, lineHeight: 1.45 },
  field: { marginBottom: 16 },
  fieldLabel: { display: "block", fontSize: 12, fontWeight: 700, color: "#a99c8b", textTransform: "uppercase", letterSpacing: "0.7px", marginBottom: 8 },
  fieldInput: { width: "100%", border: "1px solid #e7ddd0", borderRadius: 10, padding: "10px 12px", fontSize: 14.5, fontFamily: SANS, background: SURFACE, boxSizing: "border-box", outline: "none", color: "#1c1917" },
  countRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 8 },
  countInput: { width: 80, border: "1px solid #e7ddd0", borderRadius: 10, padding: "10px 12px", fontSize: 14.5, fontFamily: SANS, background: SURFACE, outline: "none", color: "#1c1917" },
  countLabel: { fontSize: 14, color: "#7d7264" },
  projRow: { display: "flex", gap: 8 },
  newProjRow: { display: "flex", gap: 8 },
  smallBtn: { border: "1px solid #e7ddd0", background: SURFACE, padding: "0 14px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontFamily: SANS, fontWeight: 600, color: ACCENT, whiteSpace: "nowrap" },
  dateToggle: { display: "flex", alignItems: "center", gap: 10, fontSize: 14.5, color: "#3c352d", cursor: "pointer", marginBottom: 16, fontWeight: 500 },
  sheetActions: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  deleteBtn: { border: "none", background: "none", color: "#b91c1c", cursor: "pointer", fontSize: 14, fontWeight: 600, fontFamily: SANS, padding: "10px 4px" },
  ghostBtn: { padding: "11px 18px", background: SURFACE, border: "1px solid #e7ddd0", borderRadius: 11, cursor: "pointer", fontSize: 14.5, fontFamily: SANS, color: "#5c5247", fontWeight: 600 },
  primaryBtn: { padding: "11px 22px", background: ACCENT, color: "#fff", border: "none", borderRadius: 11, fontSize: 14.5, fontWeight: 600, cursor: "pointer", fontFamily: SANS },
};

export default App;
