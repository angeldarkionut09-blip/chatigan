import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Ban, Bell, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Command, FileClock, Fingerprint,
  Gauge, KeyRound, LayoutDashboard, LockKeyhole, LogOut, Menu, MessageSquareWarning, MoreHorizontal,
  MessageCircle, Search, Settings2, Shield, ShieldCheck, Smartphone, Users, UsersRound, X,
} from "lucide-react";
import { api, ApiError } from "./api.js";

const ChatApp = lazy(() => import("./ChatApp.js"));

type User = {
  id: string; displayName: string; phone: string; role: string; status: string;
  mustChangePassword: boolean; createdAt: string; lastLoginAt: string | null;
};
type AdminSection = "overview" | "users" | "reports" | "groups" | "settings" | "sessions" | "audit" | "system";
type Report = { id: string; category: string; summary: string; status: string; createdAt: string; submitter: { displayName: string; phone: string } | null };
type Group = { id: string; name: string; description: string; status: string; visibility: string; memberCount: number; createdAt: string };
type Session = { id: string; userId: string; user: { displayName: string; phone: string; role: string }; createdAt: string; expiresAt: string; userAgent: string | null; isCurrent: boolean };
type AuditEvent = { id: string; action: string; subjectType: string | null; subjectId: string | null; details: string | null; createdAt: string; actor: { displayName: string; phone: string } | null };
type AdminUser = User;
type Stats = { totalUsers: number; activeUsers: number; suspendedUsers: number; openReports: number; activeGroups: number; activeSessions: number; newUsers: number };

const navigation: { id: AdminSection; label: string; icon: typeof Gauge; group: string }[] = [
  { id: "overview", label: "Privire de ansamblu", icon: LayoutDashboard, group: "GENERAL" },
  { id: "users", label: "Utilizatori", icon: Users, group: "GESTIONARE" },
  { id: "reports", label: "Raportări", icon: MessageSquareWarning, group: "GESTIONARE" },
  { id: "groups", label: "Grupuri", icon: UsersRound, group: "GESTIONARE" },
  { id: "settings", label: "Setări aplicație", icon: Settings2, group: "SISTEM" },
  { id: "sessions", label: "Sesiuni active", icon: Fingerprint, group: "SISTEM" },
  { id: "audit", label: "Jurnal de audit", icon: FileClock, group: "SISTEM" },
  { id: "system", label: "Stare servicii", icon: Activity, group: "SISTEM" },
];

const sectionTitles: Record<AdminSection, string> = {
  overview: "Privire de ansamblu", users: "Utilizatori", reports: "Raportări și abuzuri", groups: "Grupuri",
  settings: "Setări aplicație", sessions: "Sesiuni active", audit: "Jurnal de audit", system: "Stare servicii",
};

function dateTime(value: string | null | undefined) {
  if (!value) return "Niciodată";
  return new Intl.DateTimeFormat("ro-RO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("ro-RO", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    ACTIVE: "Activ", SUSPENDED: "Suspendat", OPEN: "Nouă", REVIEWING: "În analiză", RESOLVED: "Rezolvată",
    DISMISSED: "Respinsă", PRIVATE: "Privat", INVITE_ONLY: "Doar cu invitație", PUBLIC: "Public", NOT_CONNECTED: "Neconectat",
  };
  return labels[status] ?? status;
}

function statusTone(status: string) {
  if (["ACTIVE", "RESOLVED", "HEALTHY"].includes(status)) return "success";
  if (["SUSPENDED", "DISMISSED", "UNAVAILABLE"].includes(status)) return "danger";
  if (["OPEN", "REVIEWING", "NOT_CONNECTED"].includes(status)) return "warning";
  return "neutral";
}

function Brand({ compact = false, control = false }: { compact?: boolean; control?: boolean }) {
  return <div className={`brand ${compact ? "brand-compact" : ""}`}><span className="brand-mark"><MessageCircle size={19} strokeWidth={2.4} /></span><span className="brand-name">ChaTiganu{control && <span>CONTROL</span>}</span></div>;
}

function Login({ onLogin }: { onLogin: (phone: string, password: string) => Promise<void> }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true); setError("");
    try { await onLogin(phone, password); }
    catch (err) { setError(err instanceof Error ? err.message : "Autentificarea a eșuat."); }
    finally { setPending(false); }
  }
  return <main className="login-page">
    <section className="login-visual">
      <img className="login-visual-art" src="/assets/chatiganu-login-art.webp" alt="" />
      <div className="login-visual-top"><Brand /><span className="secure-tag"><LockKeyhole size={13} /> ACCES SECURIZAT</span></div>
      <div className="login-hero-copy"><div className="eyebrow"><span className="live-dot" /> CHA TIGANU · CHAT PRIVAT</div><h1>Conversații private.<br /><em>Comunitate în siguranță.</em></h1><p>Mesagerie privată și administrare responsabilă, într-un singur spațiu.</p></div>
      <div className="login-visual-foot"><span>CONFIDENȚIALITATE PRIN DESIGN</span><span>ChaTiganu © 2026</span></div>
    </section>
    <section className="login-form-side">
      <div className="login-card-wrap"><div className="mobile-brand"><Brand /></div><div className="login-heading"><div className="login-icon"><ShieldCheck size={23} /></div><div><div className="eyebrow">BINE AI REVENIT</div><h2>Conectează-te</h2></div></div>
        <p className="muted login-subtitle">Autentifică-te cu numărul de telefon și parola contului ChaTiganu.</p>
        <form onSubmit={submit} className="form-stack">
          <label className="field"><span>Număr de telefon</span><div className="input-wrap"><Smartphone size={17} /><input autoComplete="username" inputMode="tel" placeholder="07xx xxx xxx" value={phone} onChange={(event) => setPhone(event.target.value)} required /></div></label>
          <label className="field"><span>Parolă</span><div className="input-wrap"><KeyRound size={17} /><input type="password" autoComplete="current-password" placeholder="Introdu parola" value={password} onChange={(event) => setPassword(event.target.value)} required /></div></label>
          {error && <div className="inline-error"><AlertTriangle size={16} />{error}</div>}
          <button className="button button-primary login-submit" disabled={pending}>{pending ? <span className="spinner" /> : null}{pending ? "Se verifică..." : "Autentificare"}<ChevronRight size={17} /></button>
        </form>
        <div className="login-help"><LockKeyhole size={15} /><span>Sesiunea este privată și protejată.</span><button type="button" title="Contactează administratorul sistemului"><CircleHelp size={16} /></button></div>
      </div>
      <div className="login-form-foot">Ai nevoie de acces? <span>Contactează administratorul platformei.</span></div>
    </section>
  </main>;
}

function PasswordChange({ onChanged, onLogout }: { onChanged: (user: User) => void; onLogout: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (newPassword !== repeatPassword) { setError("Parolele noi nu coincid."); return; }
    setPending(true);
    try {
      const result = await api<{ user: User }>("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      onChanged(result.user);
    } catch (err) { setError(err instanceof Error ? err.message : "Parola nu a putut fi actualizată."); }
    finally { setPending(false); }
  }
  return <main className="password-page"><div className="password-brand"><Brand /></div><div className="password-card"><div className="password-icon"><KeyRound size={24} /></div><div className="eyebrow">PAS DE SECURITATE OBLIGATORIU</div><h1>Schimbă parola</h1><p className="muted">Pentru a proteja contul, setează o parolă nouă înainte să continui. Folosește cel puțin 12 caractere.</p>
    <form className="form-stack" onSubmit={submit}>
      <label className="field"><span>Parola curentă</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
      <label className="field"><span>Parola nouă</span><input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
      <label className="field"><span>Confirmă parola nouă</span><input type="password" autoComplete="new-password" minLength={12} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} required /></label>
      {error && <div className="inline-error"><AlertTriangle size={16} />{error}</div>}
      <button className="button button-primary" disabled={pending}>{pending ? "Se actualizează..." : "Salvează parola nouă"}<ArrowUpRight size={16} /></button>
      <button className="button button-quiet" type="button" onClick={onLogout}><LogOut size={15} /> Ieși din cont</button>
    </form>
  </div><div className="password-foot"><ShieldCheck size={14} /> Parola este stocată doar sub formă de hash securizat.</div></main>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [section, setSection] = useState<AdminSection>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ user: User }>("/api/auth/me").then((result) => setUser(result.user)).catch(() => setUser(null)).finally(() => setAuthLoaded(true));
  }, []);

  const login = async (phone: string, password: string) => {
    const result = await api<{ user: User }>("/api/auth/login", { method: "POST", body: JSON.stringify({ phone, password }) });
    setUser(result.user);
  };
  const logout = async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* Expired sessions are cleared locally below. */ }
    setUser(null);
  };
  const showNotice = (message: string) => {
    setNotice(message); window.setTimeout(() => setNotice(""), 3200);
  };

  if (!authLoaded) return <div className="boot-screen"><Brand /><span className="spinner" /></div>;
  if (!user) return <Login onLogin={login} />;
  if (user.mustChangePassword) return <PasswordChange onChanged={setUser} onLogout={logout} />;
  if (user.role !== "SUPER_ADMIN") return <Suspense fallback={<div className="boot-screen"><Brand /><span className="spinner" /></div>}><ChatApp user={user} onLogout={() => void logout()} /></Suspense>;

  return <div className="admin-app">
    {mobileNav && <button className="mobile-scrim" aria-label="Închide meniul" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <div className="sidebar-brand"><Brand control /><button className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="Închide"><X size={18} /></button></div>
      <div className="workspace-select"><div className="workspace-glyph">C</div><div className="workspace-copy"><strong>ChaTiganu</strong><span>Panou principal</span></div><ChevronDown size={15} /></div>
      <nav className="side-nav" aria-label="Navigare principală">
        {["GENERAL", "GESTIONARE", "SISTEM"].map((group) => <div className="nav-group" key={group}><div className="nav-caption">{group}</div>{navigation.filter((item) => item.group === group).map((item) => {
          const Icon = item.icon;
          return <button key={item.id} className={`nav-link ${section === item.id ? "nav-link-active" : ""}`} onClick={() => { setSection(item.id); setMobileNav(false); }}><Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.id === "reports" && <span className="nav-count">•</span>}</button>;
        })}</div>)}
      </nav>
      <div className="sidebar-bottom"><div className="security-note"><span className="security-note-icon"><ShieldCheck size={16} /></span><div><strong>Protecție activă</strong><span>Rol verificat pe server</span></div><Check size={15} /></div><button className="profile-card" onClick={() => void logout()}><div className="avatar avatar-admin">{user.displayName.slice(0, 1).toUpperCase()}</div><div className="profile-copy"><strong>{user.displayName}</strong><span>Administrator principal</span></div><LogOut size={16} /><span className="sr-only">Ieși din cont</span></button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="topbar-title"><button className="icon-button menu-button" aria-label="Deschide meniul" onClick={() => setMobileNav(true)}><Menu size={19} /></button><div><div className="breadcrumb">ChaTiganu <ChevronRight size={13} /> <span>{sectionTitles[section]}</span></div><h1>{sectionTitles[section]}</h1></div></div><div className="topbar-actions"><div className="system-pill"><span className="live-dot" /> Sistem operațional</div><button className="icon-button topbar-icon" aria-label="Notificări"><Bell size={18} /><i /></button><span className="topbar-divider" /><button className="topbar-user" onClick={() => void logout()}><div className="avatar avatar-admin">{user.displayName.slice(0, 1).toUpperCase()}</div><span>{user.displayName}</span><ChevronDown size={15} /></button></div></header>
      <div className="content-area">
        {error && <div className="toast toast-error"><AlertTriangle size={17} />{error}<button onClick={() => setError("")}><X size={16} /></button></div>}
        {notice && <div className="toast toast-success"><CheckCircle2 size={17} />{notice}<button onClick={() => setNotice("")}><X size={16} /></button></div>}
        <SectionContent section={section} user={user} onNotice={showNotice} onError={setError} />
        <footer className="page-footer"><span>ChaTiganu Control <span className="footer-dot">·</span> v0.1</span><span><ShieldCheck size={13} /> Datele private ale conversațiilor nu sunt disponibile în panoul de administrare</span></footer>
      </div>
    </main>
  </div>;
}

function SectionContent({ section, user, onNotice, onError }: { section: AdminSection; user: User; onNotice: (message: string) => void; onError: (message: string) => void }) {
  switch (section) {
    case "overview": return <Overview onNotice={onNotice} onError={onError} />;
    case "users": return <UsersPage onNotice={onNotice} onError={onError} />;
    case "reports": return <ReportsPage onNotice={onNotice} onError={onError} />;
    case "groups": return <GroupsPage onNotice={onNotice} onError={onError} />;
    case "settings": return <SettingsPage onNotice={onNotice} onError={onError} />;
    case "sessions": return <SessionsPage currentUserId={user.id} onNotice={onNotice} onError={onError} />;
    case "audit": return <AuditPage onError={onError} />;
    case "system": return <SystemPage onError={onError} />;
  }
}

function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{description}</p></div>{actions && <div className="page-heading-actions">{actions}</div>}</div>;
}

function MetricCard({ label, value, trend, icon: Icon, tone = "violet", footnote }: { label: string; value: number | string; trend?: string; icon: typeof Users; tone?: string; footnote?: string }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon metric-${tone}`}><Icon size={18} /></span></div><div className="metric-value">{value}</div><div className="metric-foot">{trend && <span className="metric-trend"><ArrowUpRight size={14} />{trend}</span>}<span>{footnote ?? "față de total"}</span></div></article>;
}

function Overview({ onNotice: _onNotice, onError }: { onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setLoading(true);
    Promise.all([api<Stats>("/api/admin/overview"), api<{ events: AuditEvent[] }>("/api/admin/audit?page=1")])
      .then(([overview, audit]) => { setStats(overview); setEvents(audit.events.slice(0, 5)); })
      .catch((error) => onError(error instanceof Error ? error.message : "Nu s-au putut încărca statisticile."))
      .finally(() => setLoading(false));
  }, [onError, reload]);
  const recent = useMemo(() => events, [events]);
  return <>
    <PageHeading eyebrow="BUNĂ DIMINEAȚA" title="Panoul este pregătit." description="Aici vezi activitatea platformei și elementele care pot avea nevoie de atenția ta." actions={<button className="button button-secondary" onClick={() => setReload((value) => value + 1)}><Activity size={16} /> Actualizează</button>} />
    <div className="metric-grid">
      <MetricCard label="Utilizatori" value={loading ? "—" : stats?.totalUsers ?? 0} trend={stats ? `+${stats.newUsers} în ultimele 7 zile` : undefined} icon={Users} tone="violet" footnote="conturi înregistrate" />
      <MetricCard label="Conturi active" value={loading ? "—" : stats?.activeUsers ?? 0} icon={ShieldCheck} tone="green" footnote="cu acces permis" />
      <MetricCard label="Raportări deschise" value={loading ? "—" : stats?.openReports ?? 0} icon={MessageSquareWarning} tone="amber" footnote="necesită analiză" />
      <MetricCard label="Sesiuni active" value={loading ? "—" : stats?.activeSessions ?? 0} icon={Fingerprint} tone="blue" footnote="revocabile din panou" />
    </div>
    <div className="overview-columns">
      <section className="panel activity-panel"><div className="panel-heading"><div><h3>Activitate administrativă</h3><p>Acțiuni recente, fără parole sau conținut privat.</p></div><span className="soft-icon"><Clock3 size={17} /></span></div>
        {recent.length ? <div className="activity-list">{recent.map((event) => <div className="activity-row" key={event.id}><div className="activity-mark"><Shield size={15} /></div><div className="activity-copy"><strong>{event.action.replaceAll(".", " · ")}</strong><span>{event.actor?.displayName ?? "Sistem"}{event.subjectType ? ` · ${event.subjectType}` : ""}</span></div><time>{dateTime(event.createdAt)}</time></div>)}</div> : <EmptyState icon={FileClock} title="Încă nu există activitate" copy="Acțiunile administrative importante vor apărea aici." />}
        <div className="panel-foot"><span>Jurnalul păstrează doar metadatele operațiunilor.</span><span className="foot-arrow">↗</span></div>
      </section>
      <div className="overview-side"><section className="panel health-panel"><div className="panel-heading"><div><h3>Sănătatea platformei</h3><p>Starea serviciilor esențiale</p></div><span className="healthy-tag"><span className="live-dot" /> ACTIV</span></div><div className="health-status-row"><span className="health-service"><span className="health-glyph"><Gauge size={16} /></span><span><strong>API ChaTiganu</strong><small>Conexiune disponibilă</small></span></span><span className="health-state">Operațional</span></div><div className="health-status-row"><span className="health-service"><span className="health-glyph"><LockKeyhole size={16} /></span><span><strong>Protecția datelor</strong><small>Control acces server-side</small></span></span><span className="health-state">Activă</span></div></section>
        <section className="privacy-card"><div className="privacy-orb"><ShieldCheck size={21} /></div><div className="eyebrow">CONFIDENȚIALITATE</div><h3>Mesajele rămân private.</h3><p>Panoul nu primește conținut de mesaje, chei private sau tokenuri de autentificare.</p><div className="privacy-line"><span />Controalele sunt verificate pe server</div></section></div>
    </div>
    <div className="bottom-stat-grid"><div className="mini-stat"><span className="mini-stat-icon mini-purple"><UsersRound size={16} /></span><span><small>Grupuri active</small><strong>{loading ? "—" : stats?.activeGroups ?? 0}</strong></span><ArrowDownRight size={15} className="mini-arrow" /></div><div className="mini-stat"><span className="mini-stat-icon mini-orange"><Ban size={16} /></span><span><small>Conturi suspendate</small><strong>{loading ? "—" : stats?.suspendedUsers ?? 0}</strong></span><ArrowDownRight size={15} className="mini-arrow" /></div><div className="mini-stat"><span className="mini-stat-icon mini-teal"><Activity size={16} /></span><span><small>Acțiuni recente</small><strong>{recent.length}</strong></span><span className="mini-neutral">jurnal audit</span></div></div>
  </>;
}

function EmptyState({ icon: Icon, title, copy, action }: { icon: typeof CircleHelp; title: string; copy: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={21} /></span><strong>{title}</strong><p>{copy}</p>{action}</div>;
}

function StatusBadge({ value }: { value: string }) {
  return <span className={`status-badge tone-${statusTone(value)}`}><i />{statusLabel(value)}</span>;
}

function UsersPage({ onNotice, onError }: { onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (query.trim()) params.set("q", query.trim());
    if (filter !== "ALL") params.set("status", filter);
    api<{ users: AdminUser[]; total: number }>(`/api/admin/users?${params}`)
      .then((data) => { setUsers(data.users); setTotal(data.total); })
      .catch((error) => onError(error instanceof Error ? error.message : "Nu s-au putut încărca utilizatorii."))
      .finally(() => setLoading(false));
  }, [page, query, filter, reload, onError]);
  async function updateStatus(item: AdminUser) {
    const status = item.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    if (!window.confirm(`${status === "SUSPENDED" ? "Suspenzi" : "Reactivezi"} contul ${item.displayName}?`)) return;
    try { await api(`/api/admin/users/${item.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }); onNotice(`Contul a fost ${status === "SUSPENDED" ? "suspendat" : "reactivat"}.`); setReload((n) => n + 1); }
    catch (error) { onError(error instanceof Error ? error.message : "Acțiunea nu a reușit."); }
  }
  async function requirePassword(item: AdminUser) {
    if (!window.confirm(`La următoarea autentificare, ${item.displayName} va trebui să își schimbe parola. Sesiunile sale active vor fi revocate.`)) return;
    try { await api(`/api/admin/users/${item.id}/require-password-change`, { method: "POST" }); onNotice("Schimbarea parolei este impusă. Sesiunile active au fost revocate."); setReload((n) => n + 1); }
    catch (error) { onError(error instanceof Error ? error.message : "Acțiunea nu a reușit."); }
  }
  async function revokeSessions(item: AdminUser) {
    if (!window.confirm(`Revoci toate sesiunile active ale contului ${item.displayName}?`)) return;
    try { const result = await api<{ revoked: number }>(`/api/admin/users/${item.id}/sessions`, { method: "DELETE" }); onNotice(`Au fost revocate ${result.revoked} sesiuni.`); }
    catch (error) { onError(error instanceof Error ? error.message : "Acțiunea nu a reușit."); }
  }
  return <>
    <PageHeading eyebrow="GESTIONARE CONTURI" title="Utilizatori" description="Caută conturi și gestionează accesul în platformă." actions={<button className="button button-primary" onClick={() => setModal(true)}><span className="plus-mark">+</span> Adaugă utilizator</button>} />
    <section className="panel table-panel"><div className="table-toolbar"><div className="search-box"><Search size={16} /><input placeholder="Caută după nume sau telefon" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /><kbd>⌘ K</kbd></div><div className="toolbar-filters"><span className="muted">Filtrează:</span><select value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}><option value="ALL">Toate stările</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspendate</option></select><button className="icon-button table-filter" title="Reîncarcă" onClick={() => setReload((n) => n + 1)}><Activity size={16} /></button></div></div>
      <div className="table-wrap"><table><thead><tr><th>UTILIZATOR</th><th>TELEFON</th><th>STARE CONT</th><th>CREAT</th><th>ULTIMA CONECTARE</th><th><span className="sr-only">Acțiuni</span></th></tr></thead><tbody>
        {loading ? <tr><td colSpan={6}><div className="table-loading"><span className="spinner" /> Se încarcă utilizatorii...</div></td></tr> : users.length ? users.map((item) => <tr key={item.id}><td><div className="user-cell"><div className={`avatar avatar-${item.status === "ACTIVE" ? "green" : "gray"}`}>{item.displayName.slice(0, 1).toUpperCase()}</div><div><strong>{item.displayName}</strong>{item.role === "SUPER_ADMIN" && <small className="admin-mini-tag">SUPER ADMIN</small>}</div></div></td><td className="mono-cell">{item.phone}</td><td><StatusBadge value={item.status} /></td><td>{shortDate(item.createdAt)}</td><td>{dateTime(item.lastLoginAt)}</td><td className="actions-cell"><div className="row-menu-wrap"><button className="icon-button row-more" onClick={() => setMenuFor(menuFor === item.id ? null : item.id)} aria-label="Acțiuni utilizator"><MoreHorizontal size={18} /></button>{menuFor === item.id && <><button className="menu-dismiss" aria-label="Închide meniul" onClick={() => setMenuFor(null)} /><div className="row-menu">{item.role !== "SUPER_ADMIN" && <><button onClick={() => { setMenuFor(null); void updateStatus(item); }}>{item.status === "ACTIVE" ? <><Ban size={15} /> Suspendă cont</> : <><CheckCircle2 size={15} /> Reactivează cont</>}</button><button onClick={() => { setMenuFor(null); void requirePassword(item); }}><KeyRound size={15} /> Impune schimbarea parolei</button><button onClick={() => { setMenuFor(null); void revokeSessions(item); }}><Fingerprint size={15} /> Revocă sesiunile active</button></>}</div></>}</div></td></tr>) : <tr><td colSpan={6}><EmptyState icon={Users} title="Nu am găsit utilizatori" copy={query ? "Încearcă alt nume sau număr de telefon." : "Adaugă primul cont pentru a începe administrarea."} /></td></tr>}
      </tbody></table></div>
      <div className="table-foot"><span>Afișate {users.length ? (page - 1) * 25 + 1 : 0}–{Math.min(page * 25, total)} din {total} conturi</span><div className="pager"><button className="icon-button" aria-label="Pagina precedentă" disabled={page <= 1} onClick={() => setPage((n) => Math.max(1, n - 1))}><ChevronLeft size={16} /></button><span>Pagina <strong>{page}</strong></span><button className="icon-button" aria-label="Pagina următoare" disabled={page * 25 >= total} onClick={() => setPage((n) => n + 1)}><ChevronRight size={16} /></button></div></div>
    </section>
    {modal && <CreateUserModal onClose={() => setModal(false)} onCreated={() => { setModal(false); setPage(1); setReload((n) => n + 1); onNotice("Contul a fost creat și va solicita schimbarea parolei la prima autentificare."); }} onError={onError} />}
  </>;
}

function Modal({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-head"><div><h3 id="modal-title">{title}</h3><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Închide"><X size={18} /></button></div>{children}</section></div>;
}

function CreateUserModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (message: string) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true);
    try { await api("/api/admin/users", { method: "POST", body: JSON.stringify({ displayName, phone, temporaryPassword }) }); onCreated(); }
    catch (error) { onError(error instanceof Error ? error.message : "Contul nu a putut fi creat."); }
    finally { setPending(false); }
  }
  return <Modal title="Adaugă utilizator" subtitle="Contul va trebui să schimbe parola la prima autentificare." onClose={onClose}><form className="form-stack modal-form" onSubmit={submit}><label className="field"><span>Nume afișat</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required /></label><label className="field"><span>Număr de telefon</span><input inputMode="tel" placeholder="07xx xxx xxx" value={phone} onChange={(event) => setPhone(event.target.value)} required /></label><label className="field"><span>Parolă temporară</span><input type="password" autoComplete="new-password" minLength={12} value={temporaryPassword} onChange={(event) => setTemporaryPassword(event.target.value)} required /><small>Minimum 12 caractere. Transmite parola printr-un canal sigur.</small></label><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Anulează</button><button className="button button-primary" disabled={pending}>{pending ? "Se creează..." : "Creează contul"}</button></div></form></Modal>;
}

function ReportsPage({ onNotice, onError }: { onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setLoading(true); const query = filter === "ALL" ? "" : `?status=${filter}`;
    api<{ reports: Report[] }>(`/api/admin/reports${query}`).then((data) => setReports(data.reports)).catch((error) => onError(error instanceof Error ? error.message : "Nu s-au putut încărca raportările.")).finally(() => setLoading(false));
  }, [filter, reload, onError]);
  async function updateStatus(report: Report, status: string) {
    try { await api(`/api/admin/reports/${report.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }); onNotice(`Raportarea a fost marcată: ${statusLabel(status).toLowerCase()}.`); setReload((n) => n + 1); }
    catch (error) { onError(error instanceof Error ? error.message : "Starea nu a putut fi actualizată."); }
  }
  return <><PageHeading eyebrow="SIGURANȚA COMUNITĂȚII" title="Raportări" description="Analizează semnalările utilizatorilor. Panoul nu oferă acces la conținutul mesajelor criptate." actions={<select className="select-control" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="ALL">Toate raportările</option><option value="OPEN">Noi</option><option value="REVIEWING">În analiză</option><option value="RESOLVED">Rezolvate</option><option value="DISMISSED">Respinse</option></select>} /><div className="privacy-banner"><ShieldCheck size={18} /><span><strong>Conținutul conversațiilor rămâne criptat.</strong> Raportările afișează doar rezumatul trimis pentru analiză; nu includ corpuri de mesaje sau chei.</span></div>
    <section className="panel table-panel"><div className="panel-heading inside-panel"><div><h3>Semnalări primite</h3><p>{reports.length} rezultate afișate</p></div><button className="icon-button" onClick={() => setReload((n) => n + 1)} title="Actualizează"><Activity size={16} /></button></div><div className="table-wrap"><table><thead><tr><th>RAPORTARE</th><th>TRIMISĂ DE</th><th>STARE</th><th>PRIMITĂ</th><th>ACȚIUNI</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}><div className="table-loading"><span className="spinner" /> Se încarcă raportările...</div></td></tr> : reports.length ? reports.map((report) => <tr key={report.id}><td><div className="report-cell"><span className="report-type-icon"><MessageSquareWarning size={16} /></span><span><strong>{report.category}</strong><small>{report.summary}</small></span></div></td><td><div className="stack-cell"><strong>{report.submitter?.displayName ?? "Cont șters"}</strong><small>{report.submitter?.phone ?? "—"}</small></div></td><td><StatusBadge value={report.status} /></td><td>{dateTime(report.createdAt)}</td><td><div className="inline-actions">{report.status !== "REVIEWING" && report.status !== "RESOLVED" && <button className="text-action" onClick={() => void updateStatus(report, "REVIEWING")}>Analizează</button>}{report.status !== "RESOLVED" && <button className="icon-button action-check" title="Marchează rezolvată" onClick={() => void updateStatus(report, "RESOLVED")}><Check size={16} /></button>}{report.status !== "DISMISSED" && <button className="icon-button action-dismiss" title="Respinge raportarea" onClick={() => void updateStatus(report, "DISMISSED")}><X size={16} /></button>}</div></td></tr>) : <tr><td colSpan={5}><EmptyState icon={MessageSquareWarning} title="Nu există raportări" copy="Raportările noi vor apărea aici când sunt trimise din aplicație." /></td></tr>}</tbody></table></div></section>
  </>;
}

function GroupsPage({ onNotice, onError }: { onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [modal, setModal] = useState(false);
  useEffect(() => { setLoading(true); api<{ groups: Group[] }>("/api/admin/groups").then((data) => setGroups(data.groups)).catch((error) => onError(error instanceof Error ? error.message : "Nu s-au putut încărca grupurile.")).finally(() => setLoading(false)); }, [reload, onError]);
  async function toggle(group: Group) {
    const status = group.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    if (!window.confirm(`${status === "SUSPENDED" ? "Suspenzi" : "Reactivezi"} grupul „${group.name}”?`)) return;
    try { await api(`/api/admin/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); onNotice(`Grupul a fost ${status === "ACTIVE" ? "reactivat" : "suspendat"}.`); setReload((n) => n + 1); }
    catch (error) { onError(error instanceof Error ? error.message : "Grupul nu a putut fi actualizat."); }
  }
  return <><PageHeading eyebrow="SPAȚII DE COMUNITATE" title="Grupuri" description="Gestionează starea și vizibilitatea grupurilor, fără acces la conversațiile acestora." actions={<button className="button button-primary" onClick={() => setModal(true)}><span className="plus-mark">+</span> Grup nou</button>} />
    <section className="panel group-grid-panel"><div className="group-grid">{loading ? <div className="table-loading"><span className="spinner" /> Se încarcă grupurile...</div> : groups.length ? groups.map((group, index) => <article className="group-card" key={group.id}><div className={`group-art group-art-${index % 4}`}><UsersRound size={24} /><button className="icon-button group-more" onClick={() => void toggle(group)} title={group.status === "ACTIVE" ? "Suspendă grupul" : "Reactivează grupul"}><MoreHorizontal size={17} /></button></div><div className="group-card-body"><div className="group-title-row"><h3>{group.name}</h3><StatusBadge value={group.status} /></div><p>{group.description || "Fără descriere"}</p><div className="group-meta"><span><Users size={14} /> {group.memberCount} membri</span><span>{statusLabel(group.visibility)}</span></div><div className="group-card-foot"><span>Creat {shortDate(group.createdAt)}</span><button className="text-action" onClick={() => void toggle(group)}>{group.status === "ACTIVE" ? "Suspendă" : "Reactivează"}</button></div></div></article>) : <EmptyState icon={UsersRound} title="Nu există grupuri" copy="Creează primul grup pentru a configura comunitățile din platformă." />}</div></section>
    {modal && <CreateGroupModal onClose={() => setModal(false)} onCreated={() => { setModal(false); setReload((n) => n + 1); onNotice("Grupul a fost creat."); }} onError={onError} />}
  </>;
}

function CreateGroupModal({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [visibility, setVisibility] = useState("PRIVATE"); const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setPending(true); try { await api("/api/admin/groups", { method: "POST", body: JSON.stringify({ name, description, visibility }) }); onCreated(); } catch (error) { onError(error instanceof Error ? error.message : "Grupul nu a putut fi creat."); } finally { setPending(false); } }
  return <Modal title="Creează un grup" subtitle="Setează detaliile vizibile și nivelul de vizibilitate." onClose={onClose}><form className="form-stack modal-form" onSubmit={submit}><label className="field"><span>Numele grupului</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></label><label className="field"><span>Descriere</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={300} /></label><label className="field"><span>Vizibilitate</span><select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="PRIVATE">Privat</option><option value="INVITE_ONLY">Doar cu invitație</option><option value="PUBLIC">Public</option></select></label><div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Anulează</button><button className="button button-primary" disabled={pending}>{pending ? "Se creează..." : "Creează grupul"}</button></div></form></Modal>;
}

function SettingsPage({ onNotice, onError }: { onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [settings, setSettings] = useState({ maintenanceMode: false, groupsEnabled: true });
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  useEffect(() => { api<{ settings: typeof settings }>("/api/admin/settings").then((data) => setSettings(data.settings)).catch((error) => onError(error instanceof Error ? error.message : "Setările nu au putut fi încărcate.")).finally(() => setLoading(false)); }, [onError]);
  async function save() { setSaving(true); try { await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify(settings) }); onNotice("Setările au fost salvate."); } catch (error) { onError(error instanceof Error ? error.message : "Setările nu au putut fi salvate."); } finally { setSaving(false); } }
  return <><PageHeading eyebrow="CONFIGURARE PLATFORMĂ" title="Setări aplicație" description="Gestionează opțiunile generale care nu conțin secrete sau date private." actions={<button className="button button-primary" onClick={() => void save()} disabled={saving || loading}>{saving ? "Se salvează..." : "Salvează setările"}</button>} />
    <div className="settings-layout"><div className="settings-main"><section className="panel settings-panel"><div className="panel-heading inside-panel"><div><h3>Comportamentul aplicației</h3><p>Modificările sunt înregistrate în jurnalul de audit.</p></div><Settings2 size={19} className="muted-icon" /></div>{loading ? <div className="table-loading"><span className="spinner" /> Se încarcă...</div> : <div className="setting-list"><SettingToggle title="Mod mentenanță" description="Semnalează aplicației că serviciul este în mentenanță." value={settings.maintenanceMode} onChange={(value) => setSettings((current) => ({ ...current, maintenanceMode: value }))} /><SettingToggle title="Funcții de grup" description="Semnalează disponibilitatea funcțiilor de grup pentru clienți." value={settings.groupsEnabled} onChange={(value) => setSettings((current) => ({ ...current, groupsEnabled: value }))} /></div>}</section>
      <section className="panel settings-panel"><div className="panel-heading inside-panel"><div><h3>Servicii externe</h3><p>Secretele nu sunt afișate sau editate în acest panou.</p></div><LockKeyhole size={19} className="muted-icon" /></div><div className="integration-row"><span className="integration-mark sms-mark">SMS</span><span className="integration-copy"><strong>SMS / OTP</strong><small>Configurează datele în platforma de deployment.</small></span><span className="integration-state">Variabile de mediu</span></div><div className="integration-row"><span className="integration-mark mail-mark">@</span><span className="integration-copy"><strong>Email tranzacțional</strong><small>Configurează datele în platforma de deployment.</small></span><span className="integration-state">Variabile de mediu</span></div></section></div>
      <aside className="settings-side"><div className="settings-info"><span className="settings-info-icon"><ShieldCheck size={18} /></span><h3>Secrete protejate</h3><p>Cheile API, tokenurile și parolele serviciilor se configurează doar în mediul securizat al deploymentului.</p><div className="settings-info-footer"><LockKeyhole size={14} /> Valori mascate în răspunsurile API</div></div><div className="settings-info settings-info-muted"><span className="settings-info-icon"><FileClock size={18} /></span><h3>Trasabilitate</h3><p>Fiecare schimbare importantă este înregistrată fără a include parole, tokenuri sau mesaje.</p></div></aside></div>
  </>;
}

function SettingToggle({ title, description, value, onChange }: { title: string; description: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><button className={`toggle ${value ? "toggle-on" : ""}`} role="switch" aria-checked={value} onClick={() => onChange(!value)}><span /></button></div>;
}

function SessionsPage({ currentUserId: _currentUserId, onNotice, onError }: { currentUserId: string; onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [sessions, setSessions] = useState<Session[]>([]); const [loading, setLoading] = useState(true); const [reload, setReload] = useState(0);
  useEffect(() => { setLoading(true); api<{ sessions: Session[] }>("/api/admin/sessions").then((data) => setSessions(data.sessions)).catch((error) => onError(error instanceof Error ? error.message : "Sesiunile nu au putut fi încărcate.")).finally(() => setLoading(false)); }, [reload, onError]);
  async function revoke(session: Session) { if (!window.confirm(`Revoci sesiunea pentru ${session.user.displayName}?`)) return; try { await api(`/api/admin/sessions/${session.id}`, { method: "DELETE" }); onNotice("Sesiunea a fost revocată."); setReload((n) => n + 1); } catch (error) { onError(error instanceof Error ? error.message : "Sesiunea nu a putut fi revocată."); } }
  return <><PageHeading eyebrow="CONTROL DE ACCES" title="Sesiuni active" description="Revocă accesul imediat pentru sesiunile care nu mai trebuie să fie active." /><div className="privacy-banner"><Fingerprint size={18} /><span><strong>Tokenurile nu sunt afișate.</strong> Sunt stocate doar amprente criptografice ale tokenurilor de sesiune.</span></div><section className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>CONT</th><th>DISPOZITIV</th><th>CREATĂ</th><th>EXPIRĂ</th><th>ACȚIUNE</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}><div className="table-loading"><span className="spinner" /> Se încarcă sesiunile...</div></td></tr> : sessions.length ? sessions.map((session) => <tr key={session.id}><td><div className="stack-cell"><strong>{session.user.displayName}{session.isCurrent && <span className="current-tag">Această sesiune</span>}</strong><small>{session.user.phone}</small></div></td><td><span className="device-cell"><Smartphone size={15} />{session.userAgent ? session.userAgent.slice(0, 54) : "Dispozitiv necunoscut"}</span></td><td>{dateTime(session.createdAt)}</td><td>{dateTime(session.expiresAt)}</td><td><button className="text-action text-danger" onClick={() => void revoke(session)}>Revocă sesiunea</button></td></tr>) : <tr><td colSpan={5}><EmptyState icon={Fingerprint} title="Nu există sesiuni active" copy="Sesiunile se elimină automat la expirare sau pot fi revocate manual." /></td></tr>}</tbody></table></div><div className="table-foot"><span>Sunt afișate maximum 200 de sesiuni active.</span><button className="button button-secondary button-small" onClick={() => setReload((n) => n + 1)}><Activity size={14} /> Reîncarcă</button></div></section></>;
}

function AuditPage({ onError }: { onError: (message: string) => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]); const [loading, setLoading] = useState(true); const [total, setTotal] = useState(0);
  useEffect(() => { api<{ events: AuditEvent[]; total: number }>("/api/admin/audit").then((data) => { setEvents(data.events); setTotal(data.total); }).catch((error) => onError(error instanceof Error ? error.message : "Jurnalul nu a putut fi încărcat.")).finally(() => setLoading(false)); }, [onError]);
  return <><PageHeading eyebrow="TRASABILITATE" title="Jurnal de audit" description="Acțiunile administrative importante, păstrate fără secrete și conținut privat." /><div className="audit-summary"><span className="audit-summary-icon"><FileClock size={18} /></span><span><strong>{total} înregistrări</strong><small>cele mai recente 40 sunt afișate</small></span><span className="audit-retention">Detalii limitate la metadate</span></div><section className="panel audit-panel"><div className="audit-list">{loading ? <div className="table-loading"><span className="spinner" /> Se încarcă jurnalul...</div> : events.length ? events.map((event) => <div className="audit-row" key={event.id}><div className="audit-event-icon"><Shield size={16} /></div><div className="audit-event-main"><strong>{event.action.replaceAll(".", " · ")}</strong><span>{event.actor?.displayName ?? "Sistem"} {event.subjectType ? `· ${event.subjectType}` : ""} {event.subjectId ? `· ${event.subjectId.slice(0, 8)}` : ""}</span></div><time>{dateTime(event.createdAt)}</time></div>) : <EmptyState icon={FileClock} title="Jurnalul este gol" copy="Acțiunile administrative vor fi înregistrate aici." />}</div></section></>;
}

function SystemPage({ onError }: { onError: (message: string) => void }) {
  const [system, setSystem] = useState<{ app: string; environment: string; node: string; uptimeSeconds: number; database: string; integrations: { key: string; label: string; credentialsPresent: boolean; state: string }[]; privacy: string } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api<typeof system>("/api/admin/system").then(setSystem).catch((error) => onError(error instanceof Error ? error.message : "Starea sistemului nu a putut fi încărcată.")).finally(() => setLoading(false)); }, [onError]);
  const uptime = system ? `${Math.floor(system.uptimeSeconds / 3600)} h ${Math.floor((system.uptimeSeconds % 3600) / 60)} min` : "—";
  return <><PageHeading eyebrow="OBSERVABILITATE" title="Stare servicii" description="Informații operaționale și prezența configurării integrărilor." actions={<span className="read-only-tag"><LockKeyhole size={13} /> Vizualizare sigură</span>} /><div className="system-overview-grid"><div className="system-stat panel"><span className="system-stat-icon"><Activity size={17} /></span><small>API</small><strong>{loading ? "—" : "Disponibil"}</strong><span>proces activ</span></div><div className="system-stat panel"><span className="system-stat-icon"><Gauge size={17} /></span><small>Bază de date</small><strong>{loading ? "—" : system?.database === "healthy" ? "Operațională" : "Indisponibilă"}</strong><span>{system?.database ?? "se verifică"}</span></div><div className="system-stat panel"><span className="system-stat-icon"><Clock3 size={17} /></span><small>Timp activ</small><strong>{uptime}</strong><span>de la pornire</span></div><div className="system-stat panel"><span className="system-stat-icon"><Command size={17} /></span><small>Runtime</small><strong>{system?.node ?? "—"}</strong><span>{system?.environment ?? ""}</span></div></div>
    <section className="panel integration-panel"><div className="panel-heading inside-panel"><div><h3>Integrări externe</h3><p>Starea reflectă doar prezența variabilelor, nu conectivitatea furnizorului.</p></div></div>{system?.integrations.map((item) => <div className="integration-row" key={item.key}><span className="integration-mark">{item.key === "smsOtp" ? "SMS" : "@"}</span><span className="integration-copy"><strong>{item.label}</strong><small>Credențiale {item.credentialsPresent ? "prezente" : "neconfigurate"}</small></span><StatusBadge value="NOT_CONNECTED" /><span className="integration-state">Conexiunea nu este implementată</span></div>)}</section><section className="panel privacy-system-panel"><div className="privacy-system-icon"><ShieldCheck size={20} /></div><div><strong>Limită de confidențialitate</strong><p>{system?.privacy ?? ""}</p></div></section>
  </>;
}

export default App;
